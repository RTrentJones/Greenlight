import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashTree } from './identity';
import { writeProcessShims } from './shims';

/**
 * Rollout sandboxes (vision 06 §4.2, roadmap M1-05). The ReAct loop runs on the HOST, which holds
 * the model access; every agent tool call runs INSIDE the sandbox through `exec`.
 *
 * **docker** (the only sandbox a baseline or candidate may use): one container per rollout from
 * the runner image (`bench/runner/Dockerfile`):
 * - the agent user (uid 10000), its own PID namespace, `--network none`, `--read-only` root,
 *   `--cap-drop ALL` plus only SETUID/SETGID (the shim recorder's doas hop), pid/memory/cpu limits;
 * - tmpfs `/work` (the task fixture plus the skills under test in `.claude/skills/`, a fresh git
 *   repo), tmpfs `/srv` (the bare `origin`, so pushes are observable), tmpfs HOME and `/tmp`;
 * - exactly two bind mounts, both read-only: the shim socket directory (`/run/greenlight-shim`,
 *   socket owned by the shim uid, mode 0600: the agent cannot connect) and the built greenlight
 *   CLI (`/opt/greenlight`, for `greenlight preview`). Never `bench/`, graders, mutants,
 *   references, or the repo source; no host path of them appears anywhere in the container;
 * - no secret in any environment: the model key stays in the host process (or the egress proxy).
 * `finish` kills every agent process (`kill -9 -1` as the agent; PID 1 is an inert `sleep`)
 * before the tree is copied out, and `dispose` removes the container, so no agent process
 * survives into grading.
 *
 * **process** (local development only): the tool calls run as host child processes in a temp
 * directory, with the same shims on PATH. Same uid as the host: the agent could read the host's
 * files and connect to the shim socket, so its records carry `imageDigest: 'process'` and the
 * runner refuses it for baseline and candidate roles.
 */

export interface ExecOptions {
  stdin?: string;
  /** Kill the command after this long (default 120 s). */
  timeoutMs?: number;
  /** Cap on captured stdout/stderr each (default 1 MB). */
  maxOutput?: number;
}

export interface ExecResult {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Sandbox {
  readonly kind: 'docker' | 'process';
  /** The work dir as the agent sees it. */
  readonly workDir: string;
  /** `docker image inspect` id, or `process`. */
  readonly imageDigest: string;
  /** HEAD of the fixture commit made at setup. */
  readonly baseCommit: string;
  /** Runs argv as the agent with cwd = workDir. */
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Kills every agent process; returns how many were still running. */
  finish(): Promise<{ killed: number }>;
  /** The final tree against the fixture commit, untracked files included (binary-safe). */
  diff(): Promise<string>;
  /** Copies the final tree (with `.git`) to `dest`, which must not exist. */
  exportTree(dest: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxSetup {
  /** Host directory copied into the work dir (fixture + `.claude/skills/`). */
  stageDir: string;
  /** Host directory holding the shim socket (`shim.sock`). */
  channelDir: string;
  /** Host directory with the built CLI (`greenlight.mjs`, and its `node_modules/`). */
  cliDir: string;
  /** Extra environment for every agent command (never a secret). */
  env?: Record<string, string>;
}

export const AGENT_UID = 10000;
export const WORK_DIR = '/work';

const FIXTURE_COMMIT_SCRIPT = (git: string, origin: string) => `set -e
${git} init -q -b main
${git} config user.name "Bench Agent"
${git} config user.email "agent@bench.invalid"
${git} config commit.gpgsign false
${git} add -A
${git} commit -q --allow-empty -m "fixture"
${git} init -q --bare "${origin}"
${git} remote add origin "${origin}"
${git} branch develop
${git} push -q origin main develop
${git} branch -q --set-upstream-to=origin/main main
${git} branch -q --set-upstream-to=origin/develop develop
${git} rev-parse HEAD`;

/** The diff script: a throwaway index so the agent's own index is untouched. */
const DIFF_SCRIPT = (git: string, base: string) =>
  `export GIT_INDEX_FILE="$(mktemp)"; ${git} -c core.fsmonitor= add -A >/dev/null 2>&1; ${git} -c core.fsmonitor= --no-pager diff --cached --binary ${base}; rm -f "$GIT_INDEX_FILE"`;

interface Collected {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function collect(
  proc: ChildProcess,
  o: { stdin?: string | Buffer; timeoutMs: number; maxOutput: number; onTimeout: () => void },
): Promise<Collected> {
  return new Promise((res) => {
    let out = '';
    let err = '';
    let timedOut = false;
    const cap = (s: string, b: Buffer) => (s.length < o.maxOutput ? s + b.toString() : s);
    proc.stdout?.on('data', (b: Buffer) => {
      out = cap(out, b);
    });
    proc.stderr?.on('data', (b: Buffer) => {
      err = cap(err, b);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      o.onTimeout();
    }, o.timeoutMs);
    proc.on('error', (e) => {
      err += `spawn error: ${e.message}\n`;
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      res({
        exit: code ?? (signal ? 137 : 1),
        stdout: out.slice(0, o.maxOutput),
        stderr: err.slice(0, o.maxOutput),
        timedOut,
      });
    });
    proc.stdin?.on('error', () => {});
    if (o.stdin !== undefined) proc.stdin?.end(o.stdin);
    else proc.stdin?.end();
  });
}

function run(
  bin: string,
  args: string[],
  o: { stdin?: string | Buffer; timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Collected> {
  const proc = spawn(bin, args, { cwd: o.cwd, env: o.env ?? process.env });
  return collect(proc, {
    stdin: o.stdin,
    timeoutMs: o.timeoutMs ?? 120_000,
    maxOutput: 64 * 1024 * 1024,
    onTimeout: () => proc.kill('SIGKILL'),
  });
}

// ---------------------------------------------------------------------------------------------
// docker

export function dockerAvailable(docker = 'docker'): boolean {
  try {
    execFileSync(docker, ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The uid the shim recorder runs as inside the container. A root host can chown the socket to
 * any uid; otherwise the image's shim user takes the host's own uid, so the host-owned socket is
 * connectable by the shim user and nobody else in the container. */
export function shimUid(hostUid = process.getuid?.() ?? 0): number {
  if (hostUid === 0) return 10001;
  if (hostUid === AGENT_UID) throw new Error(`host uid ${hostUid} collides with the agent uid`);
  return hostUid;
}

export interface RunnerImage {
  tag: string;
  /** The image id (`sha256:…`): BaselineIdentity `harness.imageDigest`. */
  id: string;
}

/**
 * Builds the runner image from `bench/runner/` if no image for this exact context exists (the tag
 * is the context's content hash and the shim uid). Behind an egress proxy, HTTPS_PROXY and a CA
 * bundle (SSL_CERT_FILE / NODE_EXTRA_CA_CERTS) are passed to the build only.
 */
export function ensureRunnerImage(
  runnerDir: string,
  o: { docker?: string; uid?: number; env?: NodeJS.ProcessEnv; log?: (s: string) => void } = {},
): RunnerImage {
  const docker = o.docker ?? 'docker';
  const env = o.env ?? process.env;
  const uid = o.uid ?? shimUid();
  const h = createHash('sha256')
    .update(`${hashTree(runnerDir)}:${uid}`)
    .digest('hex');
  const tag = `greenlight-bench-runner:${h.slice(0, 16)}`;
  const inspect = () =>
    execFileSync(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    return { tag, id: inspect() };
  } catch {
    // not built yet
  }
  const args = ['build', '-q', '-t', tag, '--build-arg', `SHIM_UID=${uid}`];
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (proxy) args.push('--network', 'host', '--build-arg', `HTTPS_PROXY=${proxy}`);
  const ca = [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS].find((p) => p && existsSync(p));
  if (ca) args.push('--secret', `id=ca,src=${ca}`);
  args.push(runnerDir);
  o.log?.(`building the bench runner image ${tag} …`);
  execFileSync(docker, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, DOCKER_BUILDKIT: '1' },
    timeout: 900_000,
  });
  return { tag, id: inspect() };
}

export interface DockerSandboxOptions {
  image: RunnerImage;
  docker?: string;
  shimUid?: number;
  memory?: string;
  cpus?: string;
  pids?: number;
  workSize?: string;
}

/** A tar stream of `dir` (contents, not the dir itself). */
const tarOf = (dir: string) =>
  execFileSync('tar', ['-C', dir, '-cf', '-', '.'], { maxBuffer: 1 << 30 });

/** Refuses an archive member that is absolute or climbs out with `..`. */
export function assertSafeTar(file: string): void {
  const names = execFileSync('tar', ['-tf', file], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n')
    .filter(Boolean);
  for (const n of names) {
    if (n.startsWith('/') || n.split('/').includes('..'))
      throw new Error(`refusing a tree archive member that escapes: ${n}`);
  }
}

export async function createDockerSandbox(
  setup: SandboxSetup,
  o: DockerSandboxOptions,
): Promise<Sandbox> {
  const docker = o.docker ?? 'docker';
  const name = `gl-rollout-${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`;
  // The socket directory: traversable, not listable or writable, by the container's users.
  chmodSync(setup.channelDir, 0o711);
  const envArgs = Object.entries(setup.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const t = (opts: string) => `rw,exec,uid=${AGENT_UID},gid=${AGENT_UID},${opts}`;
  const runArgs = [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--pids-limit',
    String(o.pids ?? 256),
    '--memory',
    o.memory ?? '1g',
    '--cpus',
    o.cpus ?? '2',
    '--tmpfs',
    `${WORK_DIR}:${t(`mode=0755,size=${o.workSize ?? '512m'}`)}`,
    '--tmpfs',
    `/srv:${t('mode=0755,size=128m')}`,
    '--tmpfs',
    `/home/agent:${t('mode=0700,size=128m')}`,
    '--tmpfs',
    '/tmp:rw,exec,mode=1777,size=256m',
    '-v',
    `${setup.channelDir}:/run/greenlight-shim:ro`,
    '-v',
    `${setup.cliDir}:/opt/greenlight:ro`,
    '-u',
    'agent',
    '-w',
    WORK_DIR,
    ...envArgs,
    o.image.tag,
    'sleep',
    '2147483647',
  ];
  const started = await run(docker, runArgs, { timeoutMs: 60_000 });
  if (started.exit !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);

  const dexec = (
    argv: string[],
    eo: ExecOptions & { stdinBuf?: Buffer; bare?: boolean } = {},
  ): Promise<ExecResult> => {
    const secs = Math.max(1, Math.ceil((eo.timeoutMs ?? 120_000) / 1000));
    // In-container `timeout` so a timed-out command dies inside too (killing the docker client
    // alone would leave it running); `bare` for the runner's own ps/kill.
    // `docker exec` starts with umask 000; files the agent creates get the usual 022.
    const wrap = eo.bare
      ? []
      : ['sh', '-c', 'umask 022 && exec "$@"', 'sh', 'timeout', '-s', 'KILL', String(secs)];
    const proc = spawn(docker, [
      'exec',
      '-i',
      '-u',
      'agent',
      '-w',
      WORK_DIR,
      name,
      ...wrap,
      ...argv,
    ]);
    return collect(proc, {
      stdin: eo.stdinBuf ?? eo.stdin,
      timeoutMs: secs * 1000 + 10_000,
      maxOutput: eo.maxOutput ?? 1024 * 1024,
      onTimeout: () => proc.kill('SIGKILL'),
    }).then((r) => ({ ...r, timedOut: r.timedOut || r.exit === 137 }));
  };

  const fail = async (what: string, r: ExecResult) => {
    await run(docker, ['rm', '-f', name]);
    throw new Error(`sandbox setup failed (${what}): ${r.stderr.trim() || r.stdout.trim()}`);
  };
  const untar = await dexec(['tar', '-x', '-C', WORK_DIR], { stdinBuf: tarOf(setup.stageDir) });
  if (untar.exit !== 0) await fail('copy fixture', untar);
  const init = await dexec(['sh', '-c', FIXTURE_COMMIT_SCRIPT('/usr/bin/git', '/srv/origin.git')]);
  if (init.exit !== 0) await fail('git init', init);
  const baseCommit = init.stdout.trim().split('\n').pop() ?? '';

  let disposed = false;
  return {
    kind: 'docker',
    workDir: WORK_DIR,
    imageDigest: o.image.id,
    baseCommit,
    exec: (argv, eo) => dexec(argv, eo),
    async finish() {
      const list = async () => {
        const r = await dexec(['ps', '-o', 'user=,pid=,comm='], { bare: true });
        return r.stdout
          .split('\n')
          .map((l) => l.trim().split(/\s+/))
          .filter(
            ([u, pid, comm]) => u === 'agent' && pid !== '1' && comm !== 'ps' && comm !== 'timeout',
          );
      };
      const before = (await list()).length;
      // Everything the agent started, at any depth, runs as uid agent: one kill reaches it all.
      // PID 1 (an inert sleep) ignores it; `timeout` and `kill` are the exec's own processes.
      await dexec(['kill', '-9', '-1'], { bare: true });
      for (let i = 0; i < 20 && (await list()).length > 0; i++) {
        await dexec(['kill', '-9', '-1'], { bare: true });
      }
      return { killed: before };
    },
    async diff() {
      const r = await dexec(['sh', '-c', DIFF_SCRIPT('/usr/bin/git', baseCommit)], {
        maxOutput: 32 * 1024 * 1024,
      });
      return r.stdout;
    },
    async exportTree(dest) {
      const tmp = mkdtempSync(join(tmpdir(), 'greenlight-tree-'));
      try {
        const file = join(tmp, 'tree.tar');
        const r = await new Promise<number>((res) => {
          const p = spawn(docker, ['exec', name, 'tar', '-C', WORK_DIR, '-cf', '-', '.']);
          const chunks: Buffer[] = [];
          p.stdout.on('data', (b: Buffer) => chunks.push(b));
          p.stderr.on('data', () => {});
          p.on('close', (code) => {
            writeFileSync(file, Buffer.concat(chunks));
            res(code ?? 1);
          });
        });
        if (r !== 0) throw new Error('could not copy the final tree out of the sandbox');
        assertSafeTar(file);
        mkdirSync(dest, { recursive: true });
        execFileSync('tar', [
          '-x',
          '-f',
          file,
          '-C',
          dest,
          '--no-same-owner',
          '--no-same-permissions',
          '--delay-directory-restore',
        ]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await run(docker, ['rm', '-f', name], { timeoutMs: 60_000 });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// process (local development only)

export interface ProcessSandboxOptions {
  /** `bench/runner/` (record.mjs, git-ctx.sh). */
  runnerDir: string;
  /** The host git, used for the fixture commit (not shimmed). */
  git?: string;
}

function which(bin: string, pathEnv: string, skip: string): string | null {
  for (const d of pathEnv.split(':')) {
    if (!d || d === skip) continue;
    const p = join(d, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function createProcessSandbox(
  setup: SandboxSetup,
  o: ProcessSandboxOptions,
): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), 'greenlight-proc-sandbox-'));
  const work = join(root, 'work');
  const home = join(root, 'home');
  const origin = join(root, 'origin.git');
  const shimDir = join(root, 'shims');
  mkdirSync(home);
  cpSync(setup.stageDir, work, { recursive: true, verbatimSymlinks: true });
  const hostPath = process.env.PATH ?? '/usr/bin:/bin';
  const git = o.git ?? which('git', hostPath, shimDir) ?? 'git';
  const curl = which('curl', hostPath, shimDir);
  writeProcessShims(shimDir, {
    node: process.execPath,
    recordScript: join(o.runnerDir, 'record.mjs'),
    gitCtx: join(o.runnerDir, 'git-ctx.sh'),
    socket: join(setup.channelDir, 'shim.sock'),
    origin,
    baseEnv: { HOME: home, PATH: hostPath, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1' },
    real: {
      git: [git],
      greenlight: [process.execPath, join(setup.cliDir, 'greenlight.mjs')],
      curl: curl ? [curl] : null,
    },
  });
  const env: NodeJS.ProcessEnv = {
    PATH: `${shimDir}:${hostPath}`,
    HOME: home,
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GREENLIGHT_WIKI: 'off',
    ...setup.env,
  };
  const groups = new Set<number>();
  const pexec = (argv: string[], eo: ExecOptions = {}): Promise<ExecResult> => {
    const [bin, ...args] = argv;
    if (!bin)
      return Promise.resolve({ exit: 2, stdout: '', stderr: 'empty argv', timedOut: false });
    const proc = spawn(bin, args, { cwd: work, env, detached: true });
    if (proc.pid) groups.add(proc.pid);
    const kill = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    return collect(proc, {
      stdin: eo.stdin,
      timeoutMs: eo.timeoutMs ?? 120_000,
      maxOutput: eo.maxOutput ?? 1024 * 1024,
      onTimeout: kill,
    });
  };
  const init = await pexec(['sh', '-c', FIXTURE_COMMIT_SCRIPT(`'${git}'`, origin)]);
  if (init.exit !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`sandbox setup failed (git init): ${init.stderr.trim()}`);
  }
  const baseCommit = init.stdout.trim().split('\n').pop() ?? '';
  const alive = (pgid: number) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    kind: 'process',
    workDir: work,
    imageDigest: 'process',
    baseCommit,
    exec: pexec,
    async finish() {
      // Best effort: every process group the sandbox started. A process that calls setsid()
      // escapes this, which is one reason the process sandbox is for development only.
      let killed = 0;
      for (const g of groups) {
        if (!alive(g)) continue;
        killed++;
        try {
          process.kill(-g, 'SIGKILL');
        } catch {
          // gone
        }
      }
      return { killed };
    },
    async diff() {
      const r = await pexec(['sh', '-c', DIFF_SCRIPT(`'${git}'`, baseCommit)], {
        maxOutput: 32 * 1024 * 1024,
      });
      return r.stdout;
    },
    async exportTree(dest) {
      cpSync(work, dest, { recursive: true, verbatimSymlinks: true });
    },
    async dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Copies a task fixture and the managed skills into a fresh staging dir for a sandbox. */
export function stageRollout(o: {
  fixtureDir: string;
  skillsDir: string;
  dest: string;
}): void {
  mkdirSync(o.dest, { recursive: true });
  if (existsSync(o.fixtureDir)) cpSync(o.fixtureDir, o.dest, { recursive: true });
  if (existsSync(o.skillsDir)) {
    cpSync(o.skillsDir, join(o.dest, '.claude', 'skills'), { recursive: true });
  }
}
