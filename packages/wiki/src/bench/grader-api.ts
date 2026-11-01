import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { normalizeId, pathToId } from '../ids';
import { type Wiki, loadWiki } from '../load';
import { type ApplyResult, applyMaintainerOutput } from '../patch';
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
 * Isolation. The grader process gets a scrubbed environment (`sandboxEnv`: PATH, a throwaway
 * HOME, TZ; never NODE_OPTIONS, never the parent's secrets), and it receives its job and returns
 * its result over the IPC channel to its parent, never through a file (anything the agent's code
 * can write could forge one). A grader NEVER loads the agent's code into its own process: an
 * imported module can patch the grader's globals (`fetch`, timers) and fake a pass. Agent code
 * runs only in child processes (`spawnApp`, `spawnNode`) with `sandboxEnv`, a cwd inside the
 * tree, and only the channels the grader opens to it.
 *
 * The context gives the grader everything it may observe and nothing else:
 * - `tree`: the final sandbox tree (read-only; graders never write to it);
 * - `trajectory`: the recorded TrajectoryEvent[] when the run has one (`trajectoryErrors` lists
 *   lines that did not validate: a grader treats any as a failed check);
 * - `maintainerOutput` (raw JSON, unvalidated) and `bundleDir` for maintainer tasks;
 * - helpers: `startFixture` (the fake stores under `bench/fixtures/<name>/server.mjs`, each
 *   exporting `start(options)` → `{ stop() }`), `spawnApp` (run the agent's app as a child
 *   process and wait for it to listen), `spawnNode` (run a grader-side Node script, typically a
 *   host that loads agent code, as a child with an IPC channel), `evaluateTrajectory` (the rule
 *   DSL), `validateMaintainerOutput`, `wiki` (the real wiki loader and patch engine, so a
 *   maintainer grader applies an output exactly as production does), `sandboxEnv`, and
 *   `onCleanup` (always run after grading, pass or fail).
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
  /** Added to `sandboxEnv()`: the app never sees the grader's environment. */
  env?: Record<string, string>;
  /** Grader-side modules preloaded into the app with `node --import` (absolute paths), e.g. a
   * fake-clock shim. Put in argv when the command is `node`, else in NODE_OPTIONS. */
  preload?: string[];
  /** Open an IPC channel to the app (`SpawnedApp.send` / `onMessage`), for a preloaded shim. */
  ipc?: boolean;
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
  /** With `ipc`: send a message to the app process / receive its messages. */
  send(message: unknown): void;
  onMessage(fn: (message: unknown) => void): void;
  stop(): Promise<void>;
}

export interface SpawnNodeOptions {
  /** The script to run: a grader-side file. Agent code is loaded BY it, never by the grader. */
  script: string;
  args?: string[];
  /** Working directory (inside `ctx.tree`). */
  cwd: string;
  /** Added to `sandboxEnv()`. */
  env?: Record<string, string>;
}

export interface SpawnedNode {
  send(message: unknown): void;
  onMessage(fn: (message: unknown) => void): void;
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; output: string }>;
  output(): string;
  stop(): Promise<void>;
}

/** The wiki engine, exactly as production applies a maintainer output (08 §9.1). */
export interface GraderWiki {
  load(root: string): Wiki;
  applyMaintainerOutput(
    wiki: Wiki,
    output: unknown,
    opts: { actor: string; now?: Date },
  ): ApplyResult;
  normalizeId(ref: string): string;
  pathToId(relPath: string): string | undefined;
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
  spawnNode(options: SpawnNodeOptions): SpawnedNode;
  /** The environment of every child that runs agent code: PATH, a throwaway HOME, TZ, `extra`. */
  sandboxEnv(extra?: Record<string, string>): Record<string, string>;
  wiki: GraderWiki;
  evaluateTrajectory(rules?: TaskSpec['trajectory'], events?: TrajectoryEvent[]): RuleResult[];
  validateMaintainerOutput(value: unknown): MaintainerValidation;
  onCleanup(fn: () => unknown): void;
  check(name: string, passed: boolean, detail?: string): GraderCheck;
  result(checks: GraderCheck[]): GraderResult;
  /** Diagnostic output to stderr (never part of the verdict). */
  log(...args: unknown[]): void;
}

export type Grader = (ctx: GraderContext) => Promise<GraderResult>;

/** What the parent sends for one grading run (over IPC). Every path is absolute. */
export interface GraderJob {
  taskId: string;
  benchDir: string;
  graderPath: string;
  tree: string;
  trajectoryPath?: string;
  maintainerOutputPath?: string;
  bundleDir?: string;
}

/**
 * The scrubbed environment for a child process that runs grader or agent code: PATH (so `node`
 * and `git` resolve), its own HOME, a fixed TZ, and `extra`. Never NODE_OPTIONS (it injects code
 * into every Node child) and nothing else from the caller's environment.
 */
export function sandboxEnv(
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TZ: 'UTC', ...extra };
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

interface Child {
  proc: ChildProcess;
  output(): string;
  isExited(): boolean;
  stop(): Promise<void>;
  send(message: unknown): void;
  onMessage(fn: (message: unknown) => void): void;
}

function startChild(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; ipc: boolean },
  register: (fn: () => unknown) => void,
): Child {
  let out = '';
  const proc: ChildProcess = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const append = (b: Buffer | string) => {
    out = (out + b.toString()).slice(-8000);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  proc.on('error', (e) => {
    append(`spawn error: ${e.message}\n`);
    exited = true;
  });
  const stop = async () => {
    if (exited) return;
    proc.kill('SIGKILL');
    await new Promise((r) => (exited ? r(null) : proc.once('exit', r)));
  };
  register(stop);
  return {
    proc,
    output: () => out,
    isExited: () => exited,
    stop,
    send(message) {
      if (!proc.connected) throw new Error('the child has no open IPC channel');
      proc.send(message as never);
    },
    onMessage(fn) {
      proc.on('message', fn);
    },
  };
}

type EnvFn = (extra?: Record<string, string>) => Record<string, string>;

async function spawnApp(
  opts: SpawnAppOptions,
  env: EnvFn,
  register: (fn: () => unknown) => void,
): Promise<SpawnedApp> {
  const port = opts.port ?? (await freePort());
  const [first, ...rest] = opts.command;
  if (!first) throw new Error('spawnApp needs a command');
  const imports = (opts.preload ?? []).flatMap((p) => ['--import', pathToFileURL(p).href]);
  const isNode = first === 'node';
  const extra: Record<string, string> = { ...opts.env, PORT: String(port) };
  if (!isNode && imports.length > 0) extra.NODE_OPTIONS = imports.join(' ');
  const child = startChild(
    isNode ? process.execPath : first,
    isNode ? [...imports, ...rest] : rest,
    { cwd: opts.cwd, env: env(extra), ipc: Boolean(opts.ipc) },
    register,
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10_000);
  for (;;) {
    if (child.isExited()) throw new Error(`app exited before listening:\n${child.output()}`);
    try {
      await fetch(url + (opts.readyPath ?? '/'), { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      if (Date.now() > deadline) {
        await child.stop();
        throw new Error(`app did not listen on ${url} in time:\n${child.output()}`);
      }
      await sleep(50);
    }
  }
  return {
    url,
    port,
    output: child.output,
    send: child.send,
    onMessage: child.onMessage,
    stop: child.stop,
  };
}

function spawnNode(
  opts: SpawnNodeOptions,
  env: EnvFn,
  register: (fn: () => unknown) => void,
): SpawnedNode {
  const child = startChild(
    process.execPath,
    [opts.script, ...(opts.args ?? [])],
    { cwd: opts.cwd, env: env(opts.env ?? {}), ipc: true },
    register,
  );
  const exited = new Promise<{ code: number | null; output: string }>((res) => {
    child.proc.once('exit', (code) => res({ code, output: child.output() }));
    child.proc.once('error', () => res({ code: null, output: child.output() }));
  });
  return {
    send: child.send,
    onMessage: child.onMessage,
    exited,
    output: child.output,
    stop: child.stop,
  };
}

const graderWiki: GraderWiki = {
  load: loadWiki,
  applyMaintainerOutput,
  normalizeId,
  pathToId,
};

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
  // One throwaway HOME per grading, outside the tree, removed afterwards.
  let home: string | undefined;
  const env: EnvFn = (extra = {}) => {
    if (!home) {
      const h = mkdtempSync(join(tmpdir(), 'greenlight-grader-home-'));
      home = h;
      onCleanup(() => rmSync(h, { recursive: true, force: true }));
    }
    return sandboxEnv(home, extra);
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
    spawnApp: (o) => spawnApp(o, env, onCleanup),
    spawnNode: (o) => spawnNode(o, env, onCleanup),
    sandboxEnv: env,
    wiki: graderWiki,
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

/** This module's URL: the default grader child is `node --import tsx --input-type=module -e
 * "import(GRADER_API_URL).then((m) => m.graderChildMain())"`. */
export const GRADER_API_URL = import.meta.url;
export const GRADER_API_PATH = fileURLToPath(import.meta.url);

/** The argument `check-graders` passes to a dedicated child entry (a bundled CLI's own binary,
 * `CheckGradersOptions.childEntry`). That entry calls `graderChildMain()` only when its argv
 * carries this flag. This module itself has NO import-time side effect, so bundling it into
 * another binary can never start a grader by accident, or twice. */
export const GRADER_CHILD_FLAG = '--greenlight-grader-child';

/** The child-process body: waits for `{ job }` on the IPC channel, runs it, sends back
 * `{ result }` or `{ error }`, and exits (the parent then kills anything left in its process
 * group). The verdict never touches the filesystem. */
export function graderChildMain(): void {
  const send = process.send?.bind(process);
  if (!send) {
    console.error('graderChildMain: no IPC channel (spawn the grader child with an ipc stdio)');
    process.exit(2);
  }
  const reply = (msg: unknown) =>
    new Promise<void>((res) => {
      send(msg, undefined, {}, () => res());
    });
  process.once('message', (msg: unknown) => {
    const job = (msg as { job?: GraderJob } | null)?.job;
    const run = job
      ? runGraderJob(job).then((result) => reply({ result }))
      : Promise.reject(new Error('expected { job } as the first IPC message'));
    run
      .catch((e: unknown) =>
        reply({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
      )
      .finally(() => process.exit(0));
  });
}
