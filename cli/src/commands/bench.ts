import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type EvaluationRecord,
  GateHarnessError,
  GateInputRecordSchema,
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
  loadEvaluationRecords,
  parseLedger,
  recompute,
  runBench,
  sameDecision,
} from '@rtrentjones/greenlight-wiki';
import { parseFlags } from '../args';

/**
 * `greenlight bench …` (vision 07 §3.10; roadmap M1-05/06). Thin wiring over
 * `@rtrentjones/greenlight-wiki`'s runner (packages/wiki/src/bench/runner.ts). A framework-checkout
 * command: it reads `bench/` and builds the sandbox CLI with the checkout's esbuild.
 * Exit codes (07 §0): 0 done, 1 incomplete / mismatch / check failed, 2 usage, 3 missing
 * prerequisite, 4 refused by policy (budget, process sandbox for a gate role, changed identity).
 * `bench gate <proposal>` and `bench iterate` are M2.
 */

export interface BenchIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Injected in tests: builds (or returns prebuilt) runner assets. */
  assets?: () => Promise<RunnerAssets>;
  fetchImpl?: typeof fetch;
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
      [--force] [--max-requests n] [--max-steps n] [--json]
                       run rollouts in isolated sandboxes, grade them, and write raw records, spend
                       events and (when complete) a sealed EvaluationRecord; train runs are cached
                       by baseline identity (--force re-runs). --sandbox process is local
                       development only and is refused for baseline evaluations.
  check-graders [taskId…] [--verbose]
                       every grader passes its reference and fails every mutant (alias: mutants)
  models --check       verify bench/models.json against models.list
  gate --recompute <gateInputHash>
                       re-derive a recorded gate decision from its GateInputRecord and
                       EvaluationRecords; exit 1 when it differs from the ledger event
  activate <taskId…>   flip pending tasks to active once a recorded baseline covers them on every
                       gate model (06 §4.1)

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
      }),
    );
  }
  printPassRates(io, r);
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
