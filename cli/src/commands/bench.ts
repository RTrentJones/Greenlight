import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type EvaluationRecord,
  GateHarnessError,
  GateInputRecordSchema,
  type IterateOptions,
  IterationError,
  LEDGER_FILE,
  ModelsConfigSchema,
  PrerequisiteError,
  type RunResult,
  type RunnerAssets,
  activateTasks,
  checkGraders,
  checkModels,
  dockerAvailable,
  evalEvidencePath,
  formatReport,
  iterate,
  loadEvaluationRecords,
  parseLedger,
  planIteration,
  recompute,
  reviewIteration,
  runBench,
  sameDecision,
  writeHandoff,
} from '@rtrentjones/greenlight-wiki';
import { parseFlags } from '../args';

/**
 * `greenlight bench …` (vision 07 §3.10; roadmap M1-05/06). Thin wiring over
 * `@rtrentjones/greenlight-wiki`'s runner (packages/wiki/src/bench/runner.ts). A framework-checkout
 * command: it reads `bench/` and builds the sandbox CLI with the checkout's esbuild.
 * Exit codes (07 §0): 0 done, 1 incomplete / mismatch / check failed, 2 usage, 3 missing
 * prerequisite, 4 refused by policy (budget, process sandbox for a gate role, changed identity).
 * `bench iterate` (M2-01) drives one resumable WikiSkill iteration; `bench review` (M2-04) records
 * the owner's review of its ledger rows. `bench gate <proposal>` stands alone in M3.
 */

export interface BenchIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Injected in tests: builds (or returns prebuilt) runner assets. */
  assets?: () => Promise<RunnerAssets>;
  fetchImpl?: typeof fetch;
  /** Injected in tests: clocks, quota store, outlet evaluator… for `bench iterate`. */
  iterate?: Partial<IterateOptions>;
}

const defaultIo = (): BenchIo => ({
  cwd: process.cwd(),
  env: process.env,
  out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
  err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
});

export const BENCH_USAGE = `usage: greenlight bench <subcommand>

  run [--split train|val|test] [--tasks <glob>[,<glob>…]] [--models frontier,small] [--runs n]
      [--mode isolation] [--role train|baseline] [--sandbox docker|process] [--resume <evaluationId>]
      [--force] [--max-requests n] [--max-steps n] [--rollout-requests n] [--json]
                       run rollouts in isolated sandboxes, grade them, and write raw records, spend
                       events and (when complete) a sealed EvaluationRecord; train runs are cached
                       by baseline identity (--force re-runs). --sandbox process is local
                       development only and is refused for baseline evaluations.
                       --max-steps (default 15) and --rollout-requests (the per-rollout request
                       cap, default max-steps + 2) are part of the identity; a model whose daily
                       quota left is below the cap is skipped for today (exit 1, deferred).
  check-graders [taskId…] [--verbose]
                       every grader passes its reference and fails every mutant (alias: mutants)
  models --check       verify bench/models.json against models.list
  gate --recompute <gateInputHash>
                       re-derive a recorded gate decision from its GateInputRecord and
                       EvaluationRecords; exit 1 when it differs from the ledger event
  activate <taskId…>   flip pending tasks to active once a recorded baseline covers them on every
                       gate model (06 §4.1)
  iterate [--scope <skill|all>] [--resume <iterationId>] [--sandbox docker|process] [--json]
          [--dry-run] [--handoff-only] [--models frontier,small] [--runs n] [--max-steps n]
          [--rollout-requests n] [--candidate <commit|dir>]
                       one WikiSkill iteration (06 §1.3) as a resumable state machine: train
                       evidence → maintainer → baseline → proposer → outlet evaluation → control
                       arm → ledger → hand-off. State: .greenlight/bench/iterations/<id>/state.json.
                       A quota deferral persists and exits 1; --resume continues on a later day.
                       --dry-run plans without a request; --handoff-only regenerates handoff.md.
                       --candidate (mechanism / doctor): a commit, or a clean checkout (pinned to
                       its HEAD); fixed on first use, a different one on resume is refused.
                       A verify proposal needs the faulty and fixed artifacts, which M2 takes only
                       programmatically (OutletContext.artifacts): from the CLI it stays invalid.
  review <iterationId> --decision accept|reject --reason "<text>"
                       record the owner's review of an iteration's ledger rows (a review event;
                       a reject of an accepted candidate is a withdrawn event)

common: --bench <dir> (default bench), --root <wiki dir> (default wiki),
        --skills <dir> (default .claude/skills).
The model key is read by the host process only (GEMINI_API_KEY, or injected by an egress proxy:
then run with NODE_USE_ENV_PROXY=1); it never enters a sandbox.`;

const COMMON = ['--bench', '--root', '--skills'] as const;

export async function benchCommand(args: string[], io: BenchIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'run':
        return await runCmd(rest, io);
      case 'check-graders':
      case 'mutants':
        return await checkGradersCmd(rest, io);
      case 'models':
        return await modelsCmd(rest, io);
      case 'gate':
        return gateCmd(rest, io);
      case 'activate':
        return activateCmd(rest, io);
      case 'iterate':
        return await iterateCmd(rest, io);
      case 'review':
        return reviewCmd(rest, io);
      case undefined:
      case 'help':
      case '--help':
        io.out(BENCH_USAGE);
        return sub === undefined ? 2 : 0;
      default:
        io.err(`unknown bench subcommand "${sub}"\n\n${BENCH_USAGE}`);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(msg);
    if (msg.includes('unknown flag') || msg.includes('needs a value')) return 2;
    if (err instanceof PrerequisiteError) return 3;
    if (err instanceof IterationError) return err.exitCode;
    if (err instanceof GateHarnessError) return 1;
    return 1;
  }
}

function paths(io: BenchIo, v: Record<string, string>) {
  return {
    bench: resolve(io.cwd, v['--bench'] ?? 'bench'),
    wiki: resolve(io.cwd, v['--root'] ?? 'wiki'),
    skills: resolve(io.cwd, v['--skills'] ?? '.claude/skills'),
  };
}

const EXIT: Record<RunResult['status'], number> = {
  complete: 0,
  cached: 0,
  deferred: 1,
  incomplete: 1,
  refused: 1,
  'budget-refused': 4,
  'policy-refused': 4,
  'models-unavailable': 3,
  usage: 2,
};

const posInt = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`\`greenlight bench\`: ${name} needs a value ≥ 1`);
  return n;
};

async function runCmd(args: string[], io: BenchIo): Promise<number> {
  const a = parseFlags('bench run', args, {
    value: [
      ...COMMON,
      '--split',
      '--tasks',
      '--models',
      '--runs',
      '--mode',
      '--role',
      '--sandbox',
      '--resume',
      '--max-requests',
      '--max-steps',
      '--rollout-requests',
    ],
    boolean: ['--force', '--json'],
  });
  const p = paths(io, a.values);
  const v = a.values;
  const oneOf = <T extends string>(flag: string, allowed: readonly T[]): T | undefined => {
    const x = v[flag];
    if (x === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(x))
      throw new Error(
        `\`greenlight bench run\`: ${flag} needs a value (one of ${allowed.join(', ')})`,
      );
    return x as T;
  };
  const mode = oneOf('--mode', ['isolation', 'production'] as const);
  if (mode === 'production') {
    io.err('production mode needs the wiki hooks and a pinned snapshot, which land in M3');
    return 2;
  }
  const sandbox = oneOf('--sandbox', ['docker', 'process'] as const) ?? 'docker';
  if (!existsSync(join(p.bench, 'tasks')))
    throw new PrerequisiteError(`no bench at ${p.bench} (pass --bench <dir>)`);
  if (sandbox === 'docker' && !dockerAvailable()) {
    io.err(
      'docker is not available (start the daemon, or use --sandbox process for local development)',
    );
    return 3;
  }
  const repoRoot = resolve(p.bench, '..');
  const assets = await (
    io.assets ??
    (async () => {
      const { buildBenchAssets } = await import('../bench-assets');
      return buildBenchAssets(repoRoot);
    })
  )();
  const r = await runBench({
    repoRoot,
    benchDir: p.bench,
    skillsDir: p.skills,
    wikiRoot: p.wiki,
    stateDir: join(io.cwd, '.greenlight'),
    split: oneOf('--split', ['train', 'val', 'test'] as const),
    tasks: v['--tasks']?.split(',').filter(Boolean),
    models: v['--models']?.split(',').filter(Boolean),
    runs: posInt(v['--runs'], '--runs'),
    mode: 'isolation',
    role: oneOf('--role', ['train', 'baseline'] as const),
    sandbox,
    resume: v['--resume'],
    force: a.flags.has('--force'),
    maxRequests: posInt(v['--max-requests'], '--max-requests'),
    maxSteps: posInt(v['--max-steps'], '--max-steps'),
    rolloutRequestCap: posInt(v['--rollout-requests'], '--rollout-requests'),
    assets,
    env: io.env,
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    log: (s) => io.err(s),
  });
  if (a.flags.has('--json')) {
    io.out(
      JSON.stringify({
        status: r.status,
        message: r.message,
        evaluationId: r.evaluationId,
        record: r.record?.hash,
        recordPath: r.recordPath,
        requests: r.requests,
        rollouts: r.rollouts,
        ...(r.remaining ? { remaining: r.remaining, deferredModels: r.deferredModels } : {}),
      }),
    );
  }
  printPassRates(io, r);
  for (const [m, keys] of Object.entries(r.remaining ?? {}))
    io.err(`  ${m}: ${keys.length} rollout(s) left — ${r.deferredModels?.[m] ?? 'deferred'}`);
  io.err(`${r.status}: ${r.message}`);
  return EXIT[r.status];
}

function printPassRates(io: BenchIo, r: RunResult): void {
  const outcomes = r.record?.outcomes ?? [];
  if (outcomes.length === 0) return;
  const byTask = new Map<string, { pass: number; total: number }>();
  for (const o of outcomes) {
    const k = `${o.task} · ${o.model}`;
    const s = byTask.get(k) ?? { pass: 0, total: 0 };
    s.total++;
    if (o.score === 1) s.pass++;
    byTask.set(k, s);
  }
  for (const [k, s] of byTask) io.err(`  ${s.pass}/${s.total}  ${k}`);
}

async function checkGradersCmd(args: string[], io: BenchIo): Promise<number> {
  const a = parseFlags('bench check-graders', args, { value: COMMON, boolean: ['--verbose'] });
  const p = paths(io, a.values);
  const report = await checkGraders({
    benchDir: p.bench,
    tasks: a.positional.length > 0 ? a.positional : undefined,
  });
  io.out(formatReport(report, { verbose: a.flags.has('--verbose') }));
  return report.ok ? 0 : 1;
}

async function modelsCmd(args: string[], io: BenchIo): Promise<number> {
  const a = parseFlags('bench models', args, { value: COMMON, boolean: ['--check', '--json'] });
  const p = paths(io, a.values);
  const file = join(p.bench, 'models.json');
  if (!existsSync(file)) throw new PrerequisiteError(`no ${file}`);
  const config = ModelsConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (!a.flags.has('--check')) {
    io.out(JSON.stringify(config, null, 2));
    return 0;
  }
  const r = await checkModels(config, io.fetchImpl, { env: io.env });
  if (a.flags.has('--json')) io.out(JSON.stringify(r));
  for (const id of r.checked) {
    const mark = r.missing.includes(id)
      ? '✘ missing'
      : r.deprecated.includes(id)
        ? '⚠ deprecated'
        : '✔';
    io.err(`${mark} ${id}`);
  }
  return r.ok ? 0 : 1;
}

function gateCmd(args: string[], io: BenchIo): number {
  const a = parseFlags('bench gate', args, { value: [...COMMON, '--recompute'] });
  const hash = a.values['--recompute'];
  if (!hash) {
    io.err(
      '`bench gate <proposal>` is M2; only `bench gate --recompute <gateInputHash>` exists now',
    );
    return 2;
  }
  const p = paths(io, a.values);
  const file = join(p.wiki, evalEvidencePath(hash));
  if (!existsSync(file)) throw new PrerequisiteError(`no gate input record at ${file}`);
  const gateInput = GateInputRecordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const records: EvaluationRecord[] = loadEvaluationRecords(p.wiki);
  const decision = recompute(gateInput, records);
  const ledgerFile = join(p.wiki, LEDGER_FILE);
  const events = existsSync(ledgerFile) ? parseLedger(readFileSync(ledgerFile, 'utf8')).events : [];
  const recorded = events.find(
    (e) =>
      (e.evidence?.kind === 'bench' || e.evidence?.kind === 'template') &&
      e.evidence.gateInput === hash,
  );
  io.out(
    `recomputed ${decision.decision} for ${decision.proposalId} (${decision.reasons
      .map((r) => r.code)
      .join(', ')})`,
  );
  if (!recorded) {
    io.err(`no ledger event references gate input ${hash}`);
    return 1;
  }
  const same = sameDecision(recorded, decision);
  io.out(
    same
      ? `✔ matches the ledger event ${recorded.eventId} (${recorded.stage})`
      : `✘ differs from the ledger event ${recorded.eventId} (${recorded.stage})`,
  );
  return same ? 0 : 1;
}

function activateCmd(args: string[], io: BenchIo): number {
  const a = parseFlags('bench activate', args, { value: COMMON });
  if (a.positional.length === 0) {
    io.err('usage: greenlight bench activate <taskId…>');
    return 2;
  }
  const p = paths(io, a.values);
  const r = activateTasks({ benchDir: p.bench, wikiRoot: p.wiki, taskIds: a.positional });
  for (const t of r.activated) io.out(`✔ ${t}: active`);
  for (const t of r.refused) io.err(`✘ ${t.task}: ${t.reason}`);
  return r.refused.length > 0 ? 1 : 0;
}

async function iterateCmd(args: string[], io: BenchIo): Promise<number> {
  const a = parseFlags('bench iterate', args, {
    value: [
      ...COMMON,
      '--scope',
      '--resume',
      '--sandbox',
      '--models',
      '--runs',
      '--max-steps',
      '--rollout-requests',
      '--candidate',
    ],
    boolean: ['--json', '--dry-run', '--handoff-only'],
  });
  const p = paths(io, a.values);
  const v = a.values;
  const stateDir = join(io.cwd, '.greenlight');
  const sandbox = v['--sandbox'] ?? 'docker';
  if (sandbox !== 'docker' && sandbox !== 'process') {
    io.err('`greenlight bench iterate`: --sandbox needs a value (one of docker, process)');
    return 2;
  }
  if (!existsSync(join(p.bench, 'tasks')))
    throw new PrerequisiteError(`no bench at ${p.bench} (pass --bench <dir>)`);
  const repoRoot = resolve(p.bench, '..');
  if (a.flags.has('--handoff-only')) {
    const id = v['--resume'];
    if (!id) {
      io.err('--handoff-only needs --resume <iterationId>');
      return 2;
    }
    const { file, handoff } = writeHandoff({
      stateDir,
      skillsDir: p.skills,
      wikiRoot: p.wiki,
      iterationId: id,
      benchDir: p.bench,
    });
    if (a.flags.has('--json')) io.out(JSON.stringify({ file, handoff }));
    else io.out(`${handoff.kind}: ${handoff.title}\n${file}`);
    return 0;
  }
  const base = {
    repoRoot,
    benchDir: p.bench,
    skillsDir: p.skills,
    wikiRoot: p.wiki,
    stateDir,
    sandbox,
    env: io.env,
    ...(v['--scope'] ? { scope: v['--scope'] } : {}),
    ...(v['--resume'] ? { resume: v['--resume'] } : {}),
    ...(v['--models'] ? { models: v['--models'].split(',').filter(Boolean) } : {}),
    ...(v['--runs'] ? { runs: posInt(v['--runs'], '--runs') } : {}),
    ...(v['--max-steps'] ? { maxSteps: posInt(v['--max-steps'], '--max-steps') } : {}),
    ...(v['--rollout-requests']
      ? { rolloutRequestCap: posInt(v['--rollout-requests'], '--rollout-requests') }
      : {}),
    ...(v['--candidate']
      ? {
          // mechanism / doctor / verify: the candidate change the outlet rule judges.
          outletCandidate: existsSync(resolve(io.cwd, v['--candidate']))
            ? { dir: resolve(io.cwd, v['--candidate']) }
            : { commit: v['--candidate'] },
        }
      : {}),
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    log: (s: string) => io.err(s),
    ...(io.iterate ?? {}),
  } satisfies Partial<IterateOptions>;
  if (a.flags.has('--dry-run')) {
    const plan = planIteration({ ...base, assets: undefined as never } as IterateOptions);
    if (a.flags.has('--json')) io.out(JSON.stringify({ plan: plan.lines }));
    else for (const l of plan.lines) io.out(l);
    return 0;
  }
  if (sandbox === 'docker' && !dockerAvailable()) {
    io.err(
      'docker is not available (start the daemon; baseline and candidate rollouts need the docker sandbox)',
    );
    return 3;
  }
  const assets = await (
    io.assets ??
    (async () => {
      const { buildBenchAssets } = await import('../bench-assets');
      return buildBenchAssets(repoRoot);
    })
  )();
  const r = await iterate({ ...base, assets });
  if (a.flags.has('--json')) {
    io.out(
      JSON.stringify({
        status: r.status,
        iterationId: r.iterationId,
        step: r.step,
        message: r.message,
        ...(r.remaining ? { remaining: r.remaining } : {}),
        ...(r.state?.handoff.file
          ? {
              handoff: join(
                stateDir,
                'bench',
                'iterations',
                r.iterationId as string,
                r.state.handoff.file,
              ),
            }
          : {}),
      }),
    );
  }
  for (const [m, keys] of Object.entries(r.remaining ?? {}))
    io.err(`  ${m}: ${keys.length} rollout(s) left`);
  io.err(`${r.status}${r.step ? ` at ${r.step}` : ''}: ${r.message}`);
  if (r.iterationId && r.status !== 'complete')
    io.err(`resume with \`greenlight bench iterate --resume ${r.iterationId}\``);
  if (r.status === 'complete' && r.iterationId && !a.flags.has('--json')) {
    const file = join(stateDir, 'bench', 'iterations', r.iterationId, 'handoff.md');
    if (existsSync(file)) io.out(readFileSync(file, 'utf8'));
  }
  return r.exitCode;
}

function reviewCmd(args: string[], io: BenchIo): number {
  const a = parseFlags('bench review', args, {
    value: [...COMMON, '--decision', '--reason'],
    boolean: ['--json'],
  });
  const id = a.positional[0];
  const decision = a.values['--decision'];
  const reason = a.values['--reason'];
  if (
    !id ||
    a.positional.length > 1 ||
    (decision !== 'accept' && decision !== 'reject') ||
    !reason?.trim()
  ) {
    io.err(
      'usage: greenlight bench review <iterationId> --decision accept|reject --reason "<text>"',
    );
    return 2;
  }
  const p = paths(io, a.values);
  const r = reviewIteration({
    stateDir: join(io.cwd, '.greenlight'),
    wikiRoot: p.wiki,
    skillsDir: p.skills,
    iterationId: id,
    decision,
    reason,
    benchDir: p.bench,
    ...(io.iterate?.now ? { now: io.iterate.now } : {}),
  });
  if (a.flags.has('--json')) io.out(JSON.stringify({ eventIds: r.eventIds }));
  for (const e of r.events) io.err(`✔ ${e.stage} ${e.proposalId} (${e.eventId})`);
  return 0;
}
