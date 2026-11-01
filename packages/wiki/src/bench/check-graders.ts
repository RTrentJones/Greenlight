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
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type TaskSpec, TaskSpecSchema } from '../schema/bench';
import {
  GRADER_API_URL,
  GRADER_CHILD_FLAG,
  type GraderCheck,
  type GraderJob,
  GraderResultSchema,
  type JudgeFn,
  sandboxEnv,
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
 * - `mutants/<taskId>/<mutantId>/expect.json`: `{ "failingChecks": ["<check name>", …] }`, the
 *   checks the mutant exists to trip. A mutant must fail on at least one of them; failing only
 *   on others is a problem (the grader rejects it for the wrong reason, so the property the
 *   mutant names is untested);
 * - `references/<taskId>/alternatives/<altId>/`: further layers (applied over the reference)
 *   that are also correct and must pass, e.g. another spelling of the fix;
 * - `pairs/<pairId>/pair.json`: rules that must fail exactly one task of a pair.
 *
 * Every task is also graded on its untouched `fixture/`, which must fail: a grader that passes
 * the starting tree cannot tell a solution from doing nothing.
 *
 * A run materializes fixture → reference → mutant into a fresh temp dir and grades it in a child
 * Node process with a timeout. The CLI (`greenlight bench check-graders`) wraps `checkGraders`.
 */

/** `mutants/<task>/<id>/expect.json`. */
export const MutantExpectSchema = z
  .object({ failingChecks: z.array(z.string().min(1)).min(1) })
  .strict();

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
   * tsx (`graderChildArgv`). A bundled CLI passes its own binary, which is invoked with
   * GRADER_CHILD_FLAG as its first argument and then calls `graderChildMain()`, and
   * `nodeArgs: []`. */
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
  /** From expect.json. */
  expectedFailing: string[];
}

export interface AlternativeRun extends GraderRun {
  id: string;
}

export interface TaskGraderReport {
  task: string;
  split: string;
  ok: boolean;
  reference?: GraderRun;
  /** The untouched fixture (must fail). */
  fixture?: GraderRun;
  alternatives: AlternativeRun[];
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

/** The argv of one grader child: the default runs this package's grader-api under tsx; a
 * bundled CLI passes its own binary as `entry`, which gets GRADER_CHILD_FLAG. */
export function graderChildArgv(child: { entry?: string; nodeArgs?: string[] } = {}): string[] {
  if (child.entry) return [...(child.nodeArgs ?? []), child.entry, GRADER_CHILD_FLAG];
  return [
    ...(child.nodeArgs ?? ['--import', TSX_LOADER]),
    '--input-type=module',
    '-e',
    `import(${JSON.stringify(GRADER_API_URL)}).then((m) => m.graderChildMain());`,
  ];
}

/** Runs one job in a child Node process: its own process group (a timeout or exit kills anything
 * the grader spawned), a scrubbed environment (`sandboxEnv`, with a throwaway HOME outside every
 * tree), and the job and result on its IPC channel. The verdict is the child's first IPC message
 * that is not a judge request; nothing a grandchild writes to disk, or prints, can stand in for it.
 *
 * `child.judge` (real gate grading, with `job.useJudge`) answers the child's `{ judge: { id,
 * prompt } }` requests. check-graders itself never passes one, so no LLM ever runs there. */
export function runInChild(
  job: GraderJob,
  timeoutMs: number,
  child: { entry?: string; nodeArgs?: string[]; judge?: JudgeFn } = {},
): Promise<GraderRun> {
  const started = Date.now();
  return new Promise((res) => {
    const home = mkdtempSync(join(tmpdir(), 'greenlight-grader-home-'));
    const proc = spawn(process.execPath, graderChildArgv(child), {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
      env: sandboxEnv(home),
    });
    let stderr = '';
    let message: { result?: unknown; error?: string } | undefined;
    proc.on('message', (m: unknown) => {
      const req = (m as { judge?: { id?: unknown; prompt?: unknown } } | null)?.judge;
      if (req && typeof req.id === 'number' && typeof req.prompt === 'string') {
        const id = req.id;
        const answer = (judgeResult: Record<string, unknown>) => {
          if (proc.connected) proc.send({ judgeResult: { id, ...judgeResult } });
        };
        if (!child.judge || !job.useJudge)
          answer({ error: 'no judge is available to this grading' });
        else
          child.judge(req.prompt).then(
            (v) => answer({ passed: v.passed, rationale: v.rationale }),
            (e: unknown) => answer({ error: e instanceof Error ? e.message : String(e) }),
          );
        return;
      }
      message ??= (m ?? {}) as { result?: unknown; error?: string };
    });
    proc.on('error', (e) => {
      stderr += `spawn error: ${e.message}\n`;
    });
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4000);
    });
    proc.send({ job });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }, timeoutMs);
    const killGroup = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      const durationMs = Date.now() - started;
      if (timedOut) {
        res({ verdict: 'error', checks: [], error: `timed out after ${timeoutMs} ms`, durationMs });
        return;
      }
      if (!message) {
        res({
          verdict: 'error',
          checks: [],
          error: `grader process sent no result${stderr ? `:\n${stderr}` : ''}`,
          durationMs,
        });
        return;
      }
      const out = message;
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
    };
    // On exit, reap anything the grader left in its group, then let the IPC channel and pipes
    // drain ('close') so a result sent just before exit is not lost.
    proc.once('exit', () => {
      killGroup();
      setTimeout(finish, 2000).unref();
    });
    proc.once('close', finish);
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

/** A mutant's expected failing checks, or a problem description. */
function readExpect(path: string): string[] | string {
  if (!existsSync(path)) {
    return 'no expect.json declaring the checks it must fail (`{ "failingChecks": [...] }`)';
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return `expect.json is not JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const r = MutantExpectSchema.safeParse(raw);
  if (!r.success) {
    return `expect.json is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  }
  return r.data.failingChecks;
}

/** `grader <task> fails mutant <n> for the wrong reason: …`. */
export const wrongReasonMessage = (
  task: string,
  mutant: string,
  failed: string[],
  expected: string[],
) =>
  `grader ${task} fails mutant ${mutant} for the wrong reason: it fails ${failed
    .map((f) => `"${f}"`)
    .join(', ')} but none of the expected ${expected.map((f) => `"${f}"`).join(', ')}`;

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
      alternatives: [],
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
    const expected = new Map<string, string[]>();
    // A missing or bad expect.json is a problem, but the mutant is still graded.
    const expectProblems: string[] = [];
    for (const m of task.spec.mutants) {
      const dir = join(mutantRoot, m.id);
      if (!isLayer(dir)) {
        report.problems.push(
          `grader ${task.id}: mutant ${m.id} has no files at mutants/${task.id}/${m.id}/`,
        );
        continue;
      }
      const e = readExpect(join(dir, 'expect.json'));
      if (typeof e === 'string') expectProblems.push(`grader ${task.id}: mutant ${m.id}: ${e}`);
      else expected.set(m.id, e);
    }
    const altRoot = join(refDir, 'alternatives');
    const alternatives = existsSync(altRoot)
      ? readdirSync(altRoot)
          .filter((n) => isLayer(join(altRoot, n)))
          .sort()
      : [];
    if (report.problems.length > 0) continue;
    report.problems.push(...expectProblems);
    jobs.push(async () => {
      report.reference = await grade(task, [refDir]);
    });
    // The untouched starting tree must fail (no layer at all).
    jobs.push(async () => {
      report.fixture = await grade(task, []);
    });
    for (const a of alternatives) {
      jobs.push(async () => {
        report.alternatives.push({ id: a, ...(await grade(task, [refDir, join(altRoot, a)])) });
      });
    }
    for (const m of task.spec.mutants) {
      jobs.push(async () => {
        const run = await grade(task, [refDir, join(mutantRoot, m.id)]);
        report.mutants.push({
          id: m.id,
          description: m.description,
          grader: m.grader,
          kind: m.kind,
          expectedFailing: expected.get(m.id) ?? [],
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
    if (r.fixture) {
      if (r.fixture.verdict === 'pass')
        r.problems.push(
          `grader ${r.task} passes the untouched fixture: it cannot distinguish a solution from doing nothing`,
        );
      if (r.fixture.verdict === 'error')
        r.problems.push(`grader ${r.task} errored on the untouched fixture: ${r.fixture.error}`);
    }
    r.alternatives.sort((a, b) => a.id.localeCompare(b.id));
    for (const a of r.alternatives) {
      if (a.verdict === 'fail')
        r.problems.push(`grader ${r.task} fails alternative solution ${a.id}: ${failedChecks(a)}`);
      if (a.verdict === 'error')
        r.problems.push(`grader ${r.task} errored on alternative solution ${a.id}: ${a.error}`);
    }
    for (const m of r.mutants) {
      if (m.verdict === 'pass') r.problems.push(passesMutantMessage(r.task, m.id, m.description));
      if (m.verdict === 'error')
        r.problems.push(`grader ${r.task} errored on mutant ${m.id}: ${m.error}`);
      if (m.verdict === 'fail' && m.expectedFailing.length > 0) {
        const failed = m.checks.filter((c) => !c.passed).map((c) => c.name);
        if (!failed.some((f) => m.expectedFailing.includes(f)))
          r.problems.push(wrongReasonMessage(r.task, m.id, failed, m.expectedFailing));
      }
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
    for (const a of t.alternatives)
      lines.push(`       alternative ${a.id}: ${a.verdict} (expect pass)`);
    if (t.fixture) lines.push(`       untouched fixture: ${t.fixture.verdict} (expect fail)`);
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
