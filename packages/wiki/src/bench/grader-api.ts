import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type TaskSpec, TaskSpecSchema, type TrajectoryEvent } from '../schema/bench';
import { MaintainerOutputSchema } from '../schema/io';
import { type RuleResult, evaluateRules, parseTrajectory } from './trajectory';

/**
 * The uniform grader interface (vision 06 §4.2, §4.6; 08 §10.1).
 *
 * A grader is `bench/graders/<taskId>/grade.mjs`, an ES module whose default export is
 *
 *     export default async function grade(ctx) { return { passed, checks: [{ name, passed, detail? }] } }
 *
 * It runs in its own Node process (one process per grading), after the rollout has stopped, with
 * the sandbox's final tree mounted read-only. `passed` MUST equal "there is at least one check and
 * every check passed": a grader with no checks cannot pass, and the result is rejected otherwise.
 *
 * The context gives the grader everything it may observe and nothing else:
 * - `tree`: the final sandbox tree (read-only; graders never write to it);
 * - `trajectory`: the recorded TrajectoryEvent[] when the run has one (`trajectoryErrors` lists
 *   lines that did not validate: a grader treats any as a failed check);
 * - `maintainerOutput` (raw JSON, unvalidated) and `bundleDir` for maintainer tasks;
 * - helpers: `startFixture` (the fake stores under `bench/fixtures/<name>/server.mjs`, each
 *   exporting `start(options)` → `{ stop() }`), `spawnApp` (run the agent's code as a child process
 *   and wait for it to listen), `evaluateTrajectory` (the rule DSL), `validateMaintainerOutput`,
 *   and `onCleanup` (always run after grading, pass or fail).
 */

export const GraderCheckSchema = z
  .object({ name: z.string().min(1), passed: z.boolean(), detail: z.string().optional() })
  .strict();

export const GraderResultSchema = z
  .object({ passed: z.boolean(), checks: z.array(GraderCheckSchema) })
  .strict()
  .refine((r) => r.passed === (r.checks.length > 0 && r.checks.every((c) => c.passed)), {
    message: 'passed must be true iff there is at least one check and every check passed',
  });

export type GraderCheck = z.infer<typeof GraderCheckSchema>;
export type GraderResult = z.infer<typeof GraderResultSchema>;

export interface SpawnAppOptions {
  /** Working directory (usually a directory inside `ctx.tree`). */
  cwd: string;
  /** argv; a leading `"node"` is replaced by the grader's own Node binary. */
  command: string[];
  env?: Record<string, string>;
  /** Port to pass as `PORT`; a free one is picked when omitted. */
  port?: number;
  /** Path polled until the app answers with any HTTP status (default `/`). */
  readyPath?: string;
  readyTimeoutMs?: number;
}

export interface SpawnedApp {
  url: string;
  port: number;
  /** Combined stdout + stderr so far (bounded), for check details. */
  output(): string;
  stop(): Promise<void>;
}

export interface MaintainerValidation {
  success: boolean;
  error?: string;
}

export interface GraderContext {
  taskId: string;
  task: TaskSpec;
  split: TaskSpec['split'];
  /** The grader kinds the task declares (a task may combine graders, 06 §4.2). */
  kinds: TaskSpec['graders'];
  /** Absolute path of `bench/`. */
  benchDir: string;
  /** Absolute path of the final sandbox tree. Read-only. */
  tree: string;
  trajectory?: TrajectoryEvent[];
  trajectoryErrors: string[];
  maintainerOutput?: unknown;
  /** Set when `output.json` was present but not JSON. */
  maintainerOutputError?: string;
  bundleDir?: string;
  startFixture<T = unknown>(name: string, options?: unknown): Promise<T>;
  spawnApp(options: SpawnAppOptions): Promise<SpawnedApp>;
  evaluateTrajectory(rules?: TaskSpec['trajectory'], events?: TrajectoryEvent[]): RuleResult[];
  validateMaintainerOutput(value: unknown): MaintainerValidation;
  onCleanup(fn: () => unknown): void;
  check(name: string, passed: boolean, detail?: string): GraderCheck;
  result(checks: GraderCheck[]): GraderResult;
  /** Diagnostic output to stderr (never part of the verdict). */
  log(...args: unknown[]): void;
}

export type Grader = (ctx: GraderContext) => Promise<GraderResult>;

/** What the parent writes for one grading run. Every path is absolute. */
export interface GraderJob {
  taskId: string;
  benchDir: string;
  graderPath: string;
  tree: string;
  trajectoryPath?: string;
  maintainerOutputPath?: string;
  bundleDir?: string;
  resultPath: string;
}

export const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function spawnApp(opts: SpawnAppOptions, register: (fn: () => unknown) => void) {
  const port = opts.port ?? (await freePort());
  const [first, ...rest] = opts.command;
  if (!first) throw new Error('spawnApp needs a command');
  const bin = first === 'node' ? process.execPath : first;
  let out = '';
  const proc: ChildProcess = spawn(bin, rest, {
    cwd: opts.cwd,
    env: { PATH: process.env.PATH ?? '', ...opts.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (b: Buffer) => {
    out = (out + b.toString()).slice(-8000);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  const stop = async () => {
    if (exited) return;
    proc.kill('SIGKILL');
    await new Promise((r) => (exited ? r(null) : proc.once('exit', r)));
  };
  register(stop);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10_000);
  for (;;) {
    if (exited) throw new Error(`app exited before listening:\n${out}`);
    try {
      await fetch(url + (opts.readyPath ?? '/'), { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`app did not listen on ${url} in time:\n${out}`);
      }
      await sleep(50);
    }
  }
  return { url, port, output: () => out, stop } satisfies SpawnedApp;
}

/** Builds the context for one job. `cleanup()` runs every registered cleanup, in reverse order. */
export function createGraderContext(job: GraderJob): {
  ctx: GraderContext;
  cleanup: () => Promise<void>;
} {
  const task = TaskSpecSchema.parse(
    JSON.parse(readFileSync(join(job.benchDir, 'tasks', job.taskId, 'task.json'), 'utf8')),
  );
  const cleanups: (() => unknown)[] = [];
  const onCleanup = (fn: () => unknown) => {
    cleanups.push(fn);
  };

  let trajectory: TrajectoryEvent[] | undefined;
  let trajectoryErrors: string[] = [];
  if (job.trajectoryPath && existsSync(job.trajectoryPath)) {
    const parsed = parseTrajectory(readFileSync(job.trajectoryPath, 'utf8'));
    trajectory = parsed.events;
    trajectoryErrors = parsed.errors;
  }

  let maintainerOutput: unknown;
  let maintainerOutputError: string | undefined;
  if (job.maintainerOutputPath && existsSync(job.maintainerOutputPath)) {
    try {
      maintainerOutput = JSON.parse(readFileSync(job.maintainerOutputPath, 'utf8'));
    } catch (e) {
      maintainerOutputError = e instanceof Error ? e.message : String(e);
    }
  }

  const ctx: GraderContext = {
    taskId: job.taskId,
    task,
    split: task.split,
    kinds: task.graders,
    benchDir: job.benchDir,
    tree: job.tree,
    trajectory,
    trajectoryErrors,
    maintainerOutput,
    maintainerOutputError,
    bundleDir: job.bundleDir,
    async startFixture<T>(name: string, options?: unknown): Promise<T> {
      const mod = (await import(
        pathToFileURL(join(job.benchDir, 'fixtures', name, 'server.mjs')).href
      )) as { start: (o?: unknown) => Promise<T & { stop?: () => unknown }> };
      const handle = await mod.start(options);
      if (typeof handle.stop === 'function') onCleanup(() => handle.stop?.());
      return handle;
    },
    spawnApp: (o) => spawnApp(o, onCleanup),
    evaluateTrajectory(rules = task.trajectory, events = trajectory ?? []) {
      return evaluateRules(rules?.rules ?? [], events);
    },
    validateMaintainerOutput(value) {
      const r = MaintainerOutputSchema.safeParse(value);
      return r.success
        ? { success: true }
        : {
            success: false,
            error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          };
    },
    onCleanup,
    check: (name, passed, detail) =>
      detail === undefined ? { name, passed } : { name, passed, detail },
    result: (checks) => ({
      passed: checks.length > 0 && checks.every((c) => c.passed),
      checks,
    }),
    log: (...args) => console.error(...args),
  };

  const cleanup = async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        // best effort: a failing cleanup must not mask the verdict
      }
    }
  };
  return { ctx, cleanup };
}

/** Runs one grader in THIS process and returns its validated result. `check-graders` calls it
 * through a child process (below) so a grader can never share state with another. */
export async function runGraderJob(job: GraderJob): Promise<GraderResult> {
  const { ctx, cleanup } = createGraderContext(job);
  try {
    const mod = (await import(pathToFileURL(job.graderPath).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') {
      throw new Error(`${job.graderPath} has no default-exported grade function`);
    }
    const raw = await (mod.default as Grader)(ctx);
    const r = GraderResultSchema.safeParse(raw);
    if (!r.success) {
      throw new Error(
        `grader returned an invalid result: ${r.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return r.data;
  } finally {
    await cleanup();
  }
}

/** Path of this module, the default child-process entry point for one grading run. */
export const GRADER_CHILD_ENTRY = fileURLToPath(import.meta.url);

/** Set in the child's environment by the parent; the entry block below runs only with it, so
 * bundling this module into another binary can never trigger it by accident. */
export const GRADER_CHILD_ENV = 'GREENLIGHT_GRADER_CHILD';

/** The child-process body: reads the job at `jobPath`, writes `{ result }` or `{ error }` to its
 * resultPath, and exits (killing anything the grader left running). A bundled CLI calls this from
 * its own entry when `GREENLIGHT_GRADER_CHILD=1`. */
export function graderChildMain(jobPath: string): void {
  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as GraderJob;
  runGraderJob(job)
    .then((result) => writeFileSync(job.resultPath, JSON.stringify({ result })))
    .catch((e: unknown) =>
      writeFileSync(
        job.resultPath,
        JSON.stringify({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
      ),
    )
    .finally(() => process.exit(0));
}

// `GREENLIGHT_GRADER_CHILD=1 node --import tsx grader-api.ts <job.json>`
if (
  process.env[GRADER_CHILD_ENV] === '1' &&
  process.argv[1] &&
  resolve(process.argv[1]) === GRADER_CHILD_ENTRY &&
  process.argv[2]
) {
  graderChildMain(process.argv[2]);
}
