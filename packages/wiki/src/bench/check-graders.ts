import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type TaskSpec, TaskSpecSchema } from '../schema/bench';
import {
  GRADER_CHILD_ENTRY,
  GRADER_CHILD_ENV,
  type GraderCheck,
  type GraderJob,
  GraderResultSchema,
} from './grader-api';

/**
 * `bench check-graders` (vision 06 §4.3, 13 §2.7, 15 §8.3): every grader passes its task's hidden
 * reference solution and fails every mutant, and every overgeneral-rule pair fails exactly the
 * task it names.
 *
 * Layout read (08 §10.1, bench/README.md):
 * - `tasks/<taskId>/{task.json, fixture/}`;
 * - `graders/<taskId>/grade.mjs` (the uniform interface in ./grader-api.ts);
 * - `references/<taskId>/` and `mutants/<taskId>/<mutantId>/`, each a LAYER of, applied in this
 *   order: `tree/` (overlaid on the fixture), `copy.json` (`{ treePath: benchRelativeSource }`),
 *   `remove.json` (paths to delete), `patch.diff` (`git apply`), `trajectory.jsonl`, `output.json`
 *   (a MaintainerOutput);
 * - `pairs/<pairId>/pair.json`: rules that must fail exactly one task of a pair.
 *
 * A run materializes fixture → reference → mutant into a fresh temp dir and grades it in a child
 * Node process with a timeout. The CLI (`greenlight bench check-graders`) wraps `checkGraders`.
 */

export interface CheckGradersOptions {
  /** Absolute or cwd-relative path of `bench/`. */
  benchDir: string;
  /** Restrict to these task ids (default: every task under `tasks/`). Pairs are checked only when
   * all their tasks are selected. */
  tasks?: string[];
  /** Per grading run (default 60 s). */
  timeoutMs?: number;
  /** Parallel grading runs (default min(4, cpus)). */
  concurrency?: number;
  /** Keep the temp trees for inspection. */
  keepTemp?: boolean;
  /** Child entry and Node args for one grading run. Default: this package's grader-api.ts under
   * tsx. A bundled CLI passes its own binary (which calls `graderChildMain` when
   * `GREENLIGHT_GRADER_CHILD=1`) and `nodeArgs: []`. */
  childEntry?: string;
  nodeArgs?: string[];
}

export type Verdict = 'pass' | 'fail' | 'error';

export interface GraderRun {
  verdict: Verdict;
  checks: GraderCheck[];
  error?: string;
  durationMs: number;
}

export interface MutantRun extends GraderRun {
  id: string;
  description: string;
  grader: string;
  kind: string;
}

export interface TaskGraderReport {
  task: string;
  split: string;
  ok: boolean;
  reference?: GraderRun;
  mutants: MutantRun[];
  problems: string[];
}

export interface PairRuleReport {
  id: string;
  statement: string;
  mustFail: string;
  verdicts: Record<string, Verdict>;
  ok: boolean;
  problems: string[];
}

export interface PairReport {
  id: string;
  ok: boolean;
  rules: PairRuleReport[];
  problems: string[];
}

export interface CheckGradersReport {
  ok: boolean;
  tasks: TaskGraderReport[];
  pairs: PairReport[];
  /** Every problem, in the 06 §4.3 wording where one exists. */
  problems: string[];
}

export const PairSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string().min(1),
    tasks: z.array(z.string().min(1)).min(2),
    rules: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            statement: z.string().min(1),
            mustFail: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const r of p.rules) {
      if (!p.tasks.includes(r.mustFail)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rule "${r.id}" mustFail "${r.mustFail}" is not one of the pair's tasks`,
        });
      }
    }
  });

export type PairSpec = z.infer<typeof PairSpecSchema>;

/** `grader <task> passes mutant <n>: it cannot distinguish <description>` (06 §4.3). */
export const passesMutantMessage = (task: string, mutant: string, description: string) =>
  `grader ${task} passes mutant ${mutant}: it cannot distinguish ${description}`;

function walkTaskFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'fixture') continue;
    if (statSync(p).isDirectory()) walkTaskFiles(p, out);
    else if (name === 'task.json') out.push(p);
  }
  return out;
}

export interface LoadedTask {
  id: string;
  dir: string;
  spec: TaskSpec;
}

/** Every task under `tasks/`, validated; a task whose folder does not match its id is an error. */
export function loadTasks(benchDir: string): { tasks: LoadedTask[]; problems: string[] } {
  const tasksDir = join(benchDir, 'tasks');
  const problems: string[] = [];
  const tasks: LoadedTask[] = [];
  for (const file of walkTaskFiles(tasksDir).sort()) {
    const dir = resolve(file, '..');
    const rel = relative(tasksDir, dir).split('\\').join('/');
    const r = TaskSpecSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!r.success) {
      problems.push(
        `task ${rel}: task.json is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
      continue;
    }
    if (r.data.id !== rel) {
      problems.push(`task ${rel}: task.json id "${r.data.id}" does not match its folder`);
      continue;
    }
    tasks.push({ id: r.data.id, dir, spec: r.data });
  }
  return { tasks, problems };
}

const inside = (base: string, p: string) => p === base || p.startsWith(base + sep);

/** Materializes fixture + layers into `workDir`, returning the job paths. */
export function materialize(
  benchDir: string,
  task: LoadedTask,
  layers: string[],
  workDir: string,
): Pick<GraderJob, 'tree' | 'trajectoryPath' | 'maintainerOutputPath' | 'bundleDir'> {
  const tree = join(workDir, 'tree');
  mkdirSync(tree, { recursive: true });
  const fixture = join(task.dir, 'fixture');
  if (existsSync(fixture)) cpSync(fixture, tree, { recursive: true });
  let trajectoryPath: string | undefined;
  let maintainerOutputPath: string | undefined;
  for (const layer of layers) {
    const t = join(layer, 'tree');
    if (existsSync(t)) cpSync(t, tree, { recursive: true, force: true });
    const copy = join(layer, 'copy.json');
    if (existsSync(copy)) {
      // { "<tree path>": "<bench-relative source>" }: reuse a file kept once under bench/.
      for (const [to, from] of Object.entries(
        JSON.parse(readFileSync(copy, 'utf8')) as Record<string, string>,
      )) {
        const target = resolve(tree, to);
        const source = resolve(benchDir, from);
        if (!inside(tree, target) || !inside(benchDir, source))
          throw new Error(`${copy}: path escapes the tree or bench/: ${to} <- ${from}`);
        mkdirSync(resolve(target, '..'), { recursive: true });
        cpSync(source, target, { recursive: true, force: true });
      }
    }
    const remove = join(layer, 'remove.json');
    if (existsSync(remove)) {
      for (const p of JSON.parse(readFileSync(remove, 'utf8')) as string[]) {
        const target = resolve(tree, p);
        if (!inside(tree, target)) throw new Error(`${remove}: path escapes the tree: ${p}`);
        rmSync(target, { recursive: true, force: true });
      }
    }
    const patch = join(layer, 'patch.diff');
    if (existsSync(patch)) {
      execFileSync('git', ['apply', patch], {
        cwd: tree,
        stdio: 'pipe',
      });
    }
    if (existsSync(join(layer, 'trajectory.jsonl')))
      trajectoryPath = join(layer, 'trajectory.jsonl');
    if (existsSync(join(layer, 'output.json'))) maintainerOutputPath = join(layer, 'output.json');
  }
  return {
    tree,
    trajectoryPath,
    maintainerOutputPath,
    bundleDir: task.spec.graders.includes('maintainer') ? fixture : undefined,
  };
}

const TSX_LOADER = (() => {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  } catch {
    return 'tsx';
  }
})();

/** Runs one job in a child Node process (its own process group, so a timeout also kills any app
 * the grader spawned). */
export function runInChild(
  job: GraderJob,
  timeoutMs: number,
  child: { entry?: string; nodeArgs?: string[] } = {},
): Promise<GraderRun> {
  const started = Date.now();
  return new Promise((res) => {
    writeFileSync(`${job.resultPath}.job.json`, JSON.stringify(job));
    const proc = spawn(
      process.execPath,
      [
        ...(child.nodeArgs ?? ['--import', TSX_LOADER]),
        child.entry ?? GRADER_CHILD_ENTRY,
        `${job.resultPath}.job.json`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, [GRADER_CHILD_ENV]: '1' },
      },
    );
    let stderr = '';
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (timedOut) {
        res({ verdict: 'error', checks: [], error: `timed out after ${timeoutMs} ms`, durationMs });
        return;
      }
      // Reap anything the grader left behind in its group.
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // group already gone
      }
      if (!existsSync(job.resultPath)) {
        res({
          verdict: 'error',
          checks: [],
          error: `grader process wrote no result${stderr ? `:\n${stderr}` : ''}`,
          durationMs,
        });
        return;
      }
      const out = JSON.parse(readFileSync(job.resultPath, 'utf8')) as {
        result?: unknown;
        error?: string;
      };
      if (out.error !== undefined) {
        res({ verdict: 'error', checks: [], error: out.error, durationMs });
        return;
      }
      const r = GraderResultSchema.safeParse(out.result);
      if (!r.success) {
        res({ verdict: 'error', checks: [], error: 'invalid grader result', durationMs });
        return;
      }
      res({ verdict: r.data.passed ? 'pass' : 'fail', checks: r.data.checks, durationMs });
    });
  });
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        out[i] = await (jobs[i] as () => Promise<T>)();
      }
    }),
  );
  return out;
}

const failedChecks = (r: GraderRun) =>
  r.error ??
  r.checks
    .filter((c) => !c.passed)
    .map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`)
    .join('; ');

const LAYER_FILES = [
  'tree',
  'copy.json',
  'remove.json',
  'patch.diff',
  'trajectory.jsonl',
  'output.json',
];
const isLayer = (dir: string) => LAYER_FILES.some((f) => existsSync(join(dir, f)));

export async function checkGraders(opts: CheckGradersOptions): Promise<CheckGradersReport> {
  const benchDir = resolve(opts.benchDir);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const concurrency = opts.concurrency ?? Math.min(4, cpus().length || 1);
  const loaded = loadTasks(benchDir);
  const problems = [...loaded.problems];
  const selected = opts.tasks
    ? loaded.tasks.filter((t) => opts.tasks?.includes(t.id))
    : loaded.tasks;
  if (opts.tasks) {
    for (const id of opts.tasks) {
      if (!loaded.tasks.some((t) => t.id === id)) problems.push(`task ${id}: not found`);
    }
  }
  const byId = new Map(loaded.tasks.map((t) => [t.id, t]));
  const tmpRoot = mkdtempSync(join(tmpdir(), 'greenlight-check-graders-'));
  let seq = 0;

  const grade = (task: LoadedTask, layers: string[]): Promise<GraderRun> => {
    const workDir = join(tmpRoot, String(seq++));
    mkdirSync(workDir, { recursive: true });
    try {
      const paths = materialize(benchDir, task, layers, workDir);
      return runInChild(
        {
          taskId: task.id,
          benchDir,
          graderPath: join(benchDir, 'graders', task.id, 'grade.mjs'),
          resultPath: join(workDir, 'result.json'),
          ...paths,
        },
        timeoutMs,
        { entry: opts.childEntry, nodeArgs: opts.nodeArgs },
      );
    } catch (e) {
      return Promise.resolve({
        verdict: 'error',
        checks: [],
        error: `could not materialize: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: 0,
      });
    }
  };

  const reports: TaskGraderReport[] = [];
  const jobs: (() => Promise<void>)[] = [];
  for (const task of selected) {
    const report: TaskGraderReport = {
      task: task.id,
      split: task.spec.split,
      ok: false,
      mutants: [],
      problems: [],
    };
    reports.push(report);
    const graderPath = join(benchDir, 'graders', task.id, 'grade.mjs');
    const refDir = join(benchDir, 'references', task.id);
    if (!existsSync(graderPath))
      report.problems.push(`grader ${task.id}: no ${relative(benchDir, graderPath)}`);
    if (!existsSync(refDir) || !isLayer(refDir))
      report.problems.push(`grader ${task.id}: no reference solution at references/${task.id}/`);
    const mutantRoot = join(benchDir, 'mutants', task.id);
    const declared = new Set(task.spec.mutants.map((m) => m.id));
    if (existsSync(mutantRoot)) {
      for (const name of readdirSync(mutantRoot)) {
        if (!declared.has(name)) {
          report.problems.push(
            `grader ${task.id}: mutants/${task.id}/${name} is not declared in task.json`,
          );
        }
      }
    }
    for (const m of task.spec.mutants) {
      if (!isLayer(join(mutantRoot, m.id))) {
        report.problems.push(
          `grader ${task.id}: mutant ${m.id} has no files at mutants/${task.id}/${m.id}/`,
        );
      }
    }
    if (report.problems.length > 0) continue;
    jobs.push(async () => {
      report.reference = await grade(task, [refDir]);
    });
    for (const m of task.spec.mutants) {
      jobs.push(async () => {
        const run = await grade(task, [refDir, join(mutantRoot, m.id)]);
        report.mutants.push({
          id: m.id,
          description: m.description,
          grader: m.grader,
          kind: m.kind,
          ...run,
        });
      });
    }
  }

  // Pairs (15 §8.3): each rule's tree for a task is the task's mutant of the same id when there is
  // one, else `pairs/<pairId>/<ruleId>/<taskId>/`.
  const pairReports: PairReport[] = [];
  const fromMutants: { rr: PairRuleReport; task: string; mutant: string }[] = [];
  const pairsDir = join(benchDir, 'pairs');
  const pairFiles = existsSync(pairsDir)
    ? readdirSync(pairsDir)
        .filter((d) => existsSync(join(pairsDir, d, 'pair.json')))
        .sort()
    : [];
  for (const d of pairFiles) {
    const parsed = PairSpecSchema.safeParse(
      JSON.parse(readFileSync(join(pairsDir, d, 'pair.json'), 'utf8')),
    );
    if (!parsed.success) {
      problems.push(
        `pair ${d}: pair.json is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    const pair = parsed.data;
    if (opts.tasks && !pair.tasks.every((t) => opts.tasks?.includes(t))) continue;
    const pr: PairReport = { id: pair.id, ok: false, rules: [], problems: [] };
    pairReports.push(pr);
    for (const tid of pair.tasks)
      if (!byId.has(tid)) pr.problems.push(`pair ${pair.id}: unknown task ${tid}`);
    if (pr.problems.length > 0) continue;
    for (const rule of pair.rules) {
      const rr: PairRuleReport = {
        id: rule.id,
        statement: rule.statement,
        mustFail: rule.mustFail,
        verdicts: {},
        ok: false,
        problems: [],
      };
      pr.rules.push(rr);
      for (const tid of pair.tasks) {
        const task = byId.get(tid) as LoadedTask;
        const asMutant = task.spec.mutants.some((m) => m.id === rule.id);
        const layer = asMutant
          ? join(benchDir, 'mutants', tid, rule.id)
          : join(pairsDir, d, rule.id, tid);
        if (!isLayer(layer)) {
          rr.problems.push(
            `pair ${pair.id}: rule ${rule.id} has no tree for ${tid} at ${relative(benchDir, layer)}/`,
          );
          continue;
        }
        if (asMutant) {
          // Same tree as the task's own mutant run: reuse its verdict instead of grading twice.
          fromMutants.push({ rr, task: tid, mutant: rule.id });
          continue;
        }
        jobs.push(async () => {
          const run = await grade(task, [join(benchDir, 'references', tid), layer]);
          rr.verdicts[tid] = run.verdict;
        });
      }
    }
  }

  await pool(jobs, concurrency);
  for (const f of fromMutants) {
    const run = reports.find((r) => r.task === f.task)?.mutants.find((m) => m.id === f.mutant);
    if (run) f.rr.verdicts[f.task] = run.verdict;
    else
      f.rr.problems.push(
        `rule ${f.mutant} was not graded on ${f.task} (task not selected or broken)`,
      );
  }

  for (const r of reports) {
    const spec = byId.get(r.task)?.spec;
    r.mutants.sort(
      (a, b) =>
        (spec?.mutants.findIndex((m) => m.id === a.id) ?? 0) -
        (spec?.mutants.findIndex((m) => m.id === b.id) ?? 0),
    );
    if (r.reference) {
      if (r.reference.verdict === 'fail')
        r.problems.push(
          `grader ${r.task} fails its reference solution: ${failedChecks(r.reference)}`,
        );
      if (r.reference.verdict === 'error')
        r.problems.push(`grader ${r.task} errored on its reference solution: ${r.reference.error}`);
    }
    for (const m of r.mutants) {
      if (m.verdict === 'pass') r.problems.push(passesMutantMessage(r.task, m.id, m.description));
      if (m.verdict === 'error')
        r.problems.push(`grader ${r.task} errored on mutant ${m.id}: ${m.error}`);
    }
    r.ok = r.problems.length === 0;
    problems.push(...r.problems);
  }

  for (const pr of pairReports) {
    for (const rr of pr.rules) {
      const verdicts = Object.entries(rr.verdicts);
      for (const [tid, v] of verdicts) {
        if (v === 'error') rr.problems.push(`pair ${pr.id}: rule ${rr.id} errored on ${tid}`);
      }
      const failing = verdicts.filter(([, v]) => v === 'fail').map(([t]) => t);
      if (rr.problems.length === 0) {
        if (failing.length !== 1) {
          rr.problems.push(
            `pair ${pr.id}: overgeneral rule ${rr.id} ("${rr.statement}") fails ${failing.length} of the paired tasks; it must fail exactly one`,
          );
        } else if (failing[0] !== rr.mustFail) {
          rr.problems.push(
            `pair ${pr.id}: overgeneral rule ${rr.id} ("${rr.statement}") fails ${failing[0]} instead of ${rr.mustFail}`,
          );
        }
      }
      rr.ok = rr.problems.length === 0;
      pr.problems.push(...rr.problems);
    }
    pr.ok = pr.problems.length === 0;
    problems.push(...pr.problems);
  }

  if (!opts.keepTemp) rmSync(tmpRoot, { recursive: true, force: true });
  return {
    ok: problems.length === 0 && reports.every((r) => r.ok) && pairReports.every((p) => p.ok),
    tasks: reports,
    pairs: pairReports,
    problems,
  };
}

/** A plain-text summary, one line per run; `verbose` adds the checks each mutant failed on. */
export function formatReport(r: CheckGradersReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'FAIL');
  for (const t of r.tasks) {
    lines.push(`${mark(t.ok)} ${t.task} [${t.split}]`);
    if (t.reference) lines.push(`       reference: ${t.reference.verdict} (expect pass)`);
    for (const m of t.mutants) {
      lines.push(`       mutant ${m.id}: ${m.verdict} (expect fail)`);
      if (opts.verbose && m.verdict === 'fail') {
        for (const c of m.checks.filter((x) => !x.passed)) {
          lines.push(`         ✘ ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
        }
      }
    }
  }
  for (const p of r.pairs) {
    lines.push(`${mark(p.ok)} pair ${p.id}`);
    for (const rule of p.rules) {
      const v = Object.entries(rule.verdicts)
        .map(([t, x]) => `${t}=${x}`)
        .join(', ');
      lines.push(`       ${rule.id}: ${v} (must fail only ${rule.mustFail})`);
    }
  }
  if (r.problems.length > 0) lines.push('', ...r.problems.map((p) => `✘ ${p}`));
  else lines.push('', '✔ every grader passes its reference and fails every mutant');
  return lines.join('\n');
}

// `pnpm bench:check-graders [--verbose] [taskId…]` (the CLI's `bench check-graders` wraps
// checkGraders).
const SELF = fileURLToPath(import.meta.url);
if (SELF.endsWith('check-graders.ts') && process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const ids = args.filter((a) => !a.startsWith('--'));
  checkGraders({ benchDir: join(process.cwd(), 'bench'), tasks: ids.length > 0 ? ids : undefined })
    .then((report) => {
      console.log(formatReport(report, { verbose }));
      process.exit(report.ok ? 0 : 1);
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(2);
    });
}
