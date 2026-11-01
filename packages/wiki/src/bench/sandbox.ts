import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
 *   `--cap-drop ALL` plus only SETUID/SETGID (the shim recorder's doas hops), pid/memory/cpu
 *   limits;
 * - tmpfs `/work` (the task fixture plus the skills under test in `.claude/skills/`, a fresh git
 *   repo), tmpfs `/srv` (the bare `origin`, so pushes are observable), tmpfs HOME and `/tmp`;
 * - exactly two bind mounts, both read-only: the shim socket directory (`/run/greenlight-shim`,
 *   socket owned by the shim uid, mode 0600: the agent cannot connect) and the built greenlight
 *   CLI (`/opt/real/greenlight`, inside a root:shim 0750 directory: only the recorder's command
 *   hop can run it). Never `bench/`, graders, mutants, references, or the repo source; no host
 *   path of them appears anywhere in the container;
 * - the real binaries of the shimmed commands are executable by the shim group only, so the
 *   agent's own processes reach git, curl and greenlight through the shims alone;
 * - no secret in any environment: the model key stays in the host process (or the egress proxy).
 *
 * `finish` kills EVERY process but PID 1 (an inert `sleep`) as root with CAP_KILL (a privileged
 * `docker exec`), the shim user's in-flight recorders included, and repeats until a scan of
 * `/proc` finds none alive; a loop that does not converge is a harness error. Only then are the
 * origin refs and the tree read out, from a container in which nothing runs: the exported tree
 * is the one snapshot both the diff (`treeDiff`, on the host) and the grader see. `dispose`
 * removes the container, so no agent process survives into grading.
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
  /** BaselineIdentity `harness.imageDigest` (see `ensureRunnerImage`), or `process`. */
  readonly imageDigest: string;
  /** HEAD of the fixture commit made at setup. */
  readonly baseCommit: string;
  /** Runs argv as the agent with cwd = workDir. */
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Kills every process in the sandbox; returns how many were still running. Throws when it
   * cannot stop them all (a harness error: nothing may run while the tree is read out). */
  finish(): Promise<{ killed: number }>;
  /** Every ref of the bare origin (`<sha> <ref>` lines, the recorder's own format). */
  originRefs(): Promise<string>;
  /** Copies the final tree (with `.git`) to `dest`, which must not exist. Only regular files,
   * directories and symlinks are copied; nothing is followed. */
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
/** Where the built CLI is mounted in the rollout container (only the shim group can enter). */
export const CLI_MOUNT = '/opt/real/greenlight';
/** Cap on the exported tree (the work tmpfs is 512 MB). */
export const MAX_TREE_BYTES = 600 * 1024 * 1024;

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

/**
 * A short private temp dir for a unix socket: `sun_path` holds about 104 bytes, and a deep TMPDIR
 * (CI runners, macOS) would overflow it. Uses `/tmp/<prefix>XXXXXX` when TMPDIR is too long, and
 * throws a clear error when even that is too long for `<dir>/<leaf>`.
 */
export function shortSocketDir(prefix = 'gl-', leaf = 'shim.sock'): string {
  const fits = (base: string) => join(base, `${prefix}XXXXXX`, leaf).length <= 100;
  const base = fits(tmpdir()) ? tmpdir() : '/tmp';
  if (!fits(base) || !existsSync(base)) {
    throw new Error(
      `no directory short enough for a unix socket (${join(base, `${prefix}XXXXXX`, leaf).length} > 100 bytes): set TMPDIR to a shorter path`,
    );
  }
  return mkdtempSync(join(base, prefix));
}

// ---------------------------------------------------------------------------------------------
// the exported tree

export type TarEntryType =
  | 'file'
  | 'dir'
  | 'symlink'
  | 'hardlink'
  | 'char'
  | 'block'
  | 'fifo'
  | 'other';

export interface TarEntry {
  name: string;
  type: TarEntryType;
  mode: number;
  size: number;
  linkname: string;
  /** Offset of the member's data in the archive. */
  offset: number;
}

const TYPES: Record<string, TarEntryType> = {
  '0': 'file',
  '\0': 'file',
  '7': 'file',
  '5': 'dir',
  '2': 'symlink',
  '1': 'hardlink',
  '3': 'char',
  '4': 'block',
  '6': 'fifo',
};

function octal(b: Buffer): number {
  if ((b[0] as number) & 0x80) throw new Error('tree archive: a base-256 size is not supported');
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim();
  return s === '' ? 0 : Number.parseInt(s, 8);
}

/** Members of a ustar/GNU/pax archive (`L`/`K` long names and pax `path`/`linkpath` applied). */
export function listTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  const cstr = (b: Buffer) => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString('utf8');
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h.subarray(124, 136));
    const flag = String.fromCharCode(h[156] as number);
    const ustar = h.subarray(257, 262).toString('latin1') === 'ustar';
    const prefix = ustar ? cstr(h.subarray(345, 500)) : '';
    const rawName = cstr(h.subarray(0, 100));
    const start = off + 512;
    if (start + size > buf.length) throw new Error('tree archive is truncated');
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (flag === 'L') {
      longName = cstr(data);
      continue;
    }
    if (flag === 'K') {
      longLink = cstr(data);
      continue;
    }
    if (flag === 'x' || flag === 'g') {
      if (flag === 'x') {
        // Records are `<len> <key>=<value>\n`, `len` counting bytes of the whole record.
        pax = {};
        let rest = data;
        while (rest.length > 0) {
          const sp = rest.indexOf(0x20);
          const len = Number.parseInt(rest.subarray(0, sp).toString('latin1'), 10);
          if (!(sp > 0 && len > sp && len <= rest.length)) break;
          const rec = rest.subarray(sp + 1, len - 1).toString('utf8');
          const eq = rec.indexOf('=');
          if (eq > 0) pax[rec.slice(0, eq)] = rec.slice(eq + 1);
          rest = rest.subarray(len);
        }
      }
      continue;
    }
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    const linkname = pax.linkpath ?? longLink ?? cstr(h.subarray(157, 257));
    out.push({
      name,
      type: TYPES[flag] ?? 'other',
      mode: octal(h.subarray(100, 108)),
      size,
      linkname,
      offset: start,
    });
    longName = undefined;
    longLink = undefined;
    pax = {};
  }
  return out;
}

/** `./a/b/` → `a/b`; '' for the root. */
const normal = (n: string) => n.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/**
 * Refuses an archive the host must not unpack: a member that is absolute or climbs out with `..`,
 * a hardlink, device, FIFO or unknown type, a duplicate name, a member below a symlink member
 * (the classic "symlink, then write through it" escape), or more than `maxBytes` of content.
 * Returns the members to extract.
 */
export function assertSafeTar(buf: Buffer, maxBytes = MAX_TREE_BYTES): TarEntry[] {
  if (buf.length > maxBytes + 1024 * 1024) throw new Error('tree archive exceeds the size cap');
  const entries = listTar(buf);
  const names = new Set<string>();
  const links = new Set<string>();
  let total = 0;
  const kept: TarEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('/') || e.name.split('/').includes('..'))
      throw new Error(`refusing a tree archive member that escapes: ${e.name}`);
    if (e.type !== 'file' && e.type !== 'dir' && e.type !== 'symlink')
      throw new Error(`refusing a tree archive member of type ${e.type}: ${e.name}`);
    const n = normal(e.name);
    if (n === '' || n === '.') continue;
    if (names.has(n)) throw new Error(`refusing a duplicate tree archive member: ${n}`);
    names.add(n);
    if (e.type === 'symlink') links.add(n);
    total += e.size;
    if (total > maxBytes) throw new Error(`the final tree exceeds ${maxBytes} bytes`);
    kept.push({ ...e, name: n });
  }
  for (const e of kept) {
    const parts = e.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/');
      if (links.has(anc))
        throw new Error(`refusing a tree archive member below a symlink: ${e.name}`);
    }
  }
  return kept;
}

/** The same rules as `assertSafeTar` for a directory on the host (the process sandbox): only
 * regular files (one link each), directories and symlinks, at most `maxBytes` in all. */
export function assertPlainTree(root: string, maxBytes = MAX_TREE_BYTES): void {
  let total = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && st.nlink === 1) {
        total += st.size;
        if (total > maxBytes) throw new Error(`the final tree exceeds ${maxBytes} bytes`);
      } else
        throw new Error(
          `refusing a tree member that is not a regular file, directory or symlink: ${r}`,
        );
    }
  };
  walk('');
}

/** Unpacks checked members into `dest` (created): nothing is followed, nothing is owned by
 * anyone but the host user, and every directory stays traversable. */
export function extractTar(buf: Buffer, entries: readonly TarEntry[], dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const p = join(dest, e.name);
    if (e.type === 'dir') mkdirSync(p, { recursive: true, mode: 0o755 });
  }
  for (const e of entries) {
    const p = join(dest, e.name);
    if (e.type === 'dir') continue;
    mkdirSync(join(p, '..'), { recursive: true, mode: 0o755 });
    if (e.type === 'symlink') symlinkSync(e.linkname, p);
    else
      writeFileSync(p, buf.subarray(e.offset, e.offset + e.size), {
        mode: (e.mode & 0o755) | 0o600,
        flag: 'wx',
      });
  }
  for (const e of entries) if (e.type === 'dir') chmodSync(join(dest, e.name), 0o755);
}

/**
 * The final tree against the base (both host directories), untracked files included,
 * binary-safe, `.git` excluded: `git diff` of two `write-tree`s in a throwaway repository with no
 * system, global or repository config, so nothing the agent wrote (a filter, fsmonitor, textconv
 * or hook) can run on the host.
 */
export function treeDiff(baseDir: string, treeDir: string, o: { git?: string } = {}): string {
  const git = o.git ?? 'git';
  const tmp = mkdtempSync(join(tmpdir(), 'greenlight-diff-'));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      XDG_CONFIG_HOME: tmp,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_DIR: join(tmp, 'repo.git'),
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
    const g = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      execFileSync(git, args, {
        cwd: tmp,
        env: { ...env, ...extra },
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf8');
    g(['init', '-q']);
    const tree = (work: string, index: string) => {
      const e = { GIT_INDEX_FILE: join(tmp, index), GIT_WORK_TREE: work };
      g(['-C', work, '-c', 'core.fsmonitor=false', 'add', '-A'], e);
      return g(['write-tree'], e).trim();
    };
    const a = tree(baseDir, 'base.index');
    const b = tree(treeDir, 'tree.index');
    return g(['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', a, b]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
  /** The local image id (`sha256:…`), informational: it changes on every rebuild. */
  id: string;
  /** BaselineIdentity `harness.imageDigest` (see `runnerImageDigest`). */
  digest: string;
  /** The shim user's uid (and the shim group's gid) in this image. */
  shimUid: number;
}

/**
 * `harness.imageDigest`: a hash of the build context (`bench/runner/`, whose Dockerfile pins the
 * base image by digest and every apk package by version), the shim uid, and the package list
 * actually installed in the image (`apk info -v`, sorted).
 *
 * Why not the local image id: it changes on every rebuild (layer timestamps), so a pruned and
 * rebuilt image would refuse every resume across days although nothing an agent can observe
 * changed. The context hash names what was asked for; the package list proves what was installed
 * (a transitive dependency the pins do not cover would show up there), so a drifted rebuild still
 * changes the identity.
 */
export function runnerImageDigest(contextHash: string, uid: number, packages: string): string {
  const list = packages
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort()
    .join('\n');
  const h = createHash('sha256').update(`runner\0${contextHash}\0${uid}\0${list}\n`).digest('hex');
  return `ctx:sha256:${h}`;
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
  const contextHash = hashTree(runnerDir);
  const h = createHash('sha256').update(`${contextHash}:${uid}`).digest('hex');
  const tag = `greenlight-bench-runner:${h.slice(0, 16)}`;
  const inspect = () =>
    execFileSync(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const image = (id: string): RunnerImage => {
    const packages = execFileSync(
      docker,
      ['run', '--rm', '--network', 'none', '--entrypoint', '/sbin/apk', tag, 'info', '-v'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
    return { tag, id, digest: runnerImageDigest(contextHash, uid, packages), shimUid: uid };
  };
  try {
    return image(inspect());
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
  return image(inspect());
}

export interface DockerSandboxOptions {
  image: RunnerImage;
  docker?: string;
  memory?: string;
  cpus?: string;
  pids?: number;
  workSize?: string;
}

/** A tar stream of `dir` (contents, not the dir itself). */
const tarOf = (dir: string) =>
  execFileSync('tar', ['-C', dir, '-cf', '-', '.'], { maxBuffer: 1 << 30 });

/**
 * Run as root with every capability (a privileged exec) in the container's PID namespace: SIGKILL
 * to every process but PID 1 and itself, repeated until two consecutive /proc scans find nothing
 * alive (zombies, which the inert PID 1 never reaps, do not count). Prints
 * `{ before, rounds, left }`.
 */
const KILL_ALL = `const fs=require('fs');
const live=()=>{const o=[];for(const d of fs.readdirSync('/proc')){if(!/^\\d+$/.test(d))continue;const p=+d;if(p===1||p===process.pid)continue;
try{const s=fs.readFileSync('/proc/'+d+'/stat','utf8');const c=s[s.lastIndexOf(')')+2];if(c!=='Z'&&c!=='X')o.push(p)}catch{}}return o};
const before=live().length;let rounds=0,left=live();
for(;rounds<50;rounds++){try{process.kill(-1,'SIGKILL')}catch{}const t=Date.now();while(Date.now()-t<20){}
left=live();if(left.length===0&&live().length===0)break}
console.log(JSON.stringify({before,rounds,left}))`;

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
    `${setup.cliDir}:${CLI_MOUNT}:ro`,
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

  /** `agent`: the agent's tool calls. `git`: the runner's own git (uid agent, group shim, a clean
   * git environment). `root`: a privileged exec, for the kill loop and the tree export only. */
  type As = 'agent' | 'git' | 'root';
  const user: Record<As, string[]> = {
    agent: ['-u', 'agent'],
    git: [
      '-u',
      `${AGENT_UID}:${o.image.shimUid}`,
      '-e',
      'HOME=/nonexistent',
      '-e',
      'GIT_CONFIG_NOSYSTEM=1',
      '-e',
      'GIT_CONFIG_GLOBAL=/dev/null',
    ],
    root: ['--privileged', '-u', '0'],
  };
  const dexec = (
    argv: string[],
    eo: ExecOptions & { stdinBuf?: Buffer; bare?: boolean; as?: As } = {},
  ): Promise<ExecResult> => {
    const secs = Math.max(1, Math.ceil((eo.timeoutMs ?? 120_000) / 1000));
    // In-container `timeout` so a timed-out command dies inside too (killing the docker client
    // alone would leave it running); `bare` for the runner's own commands.
    // `docker exec` starts with umask 000; files the agent creates get the usual 022.
    const wrap = eo.bare
      ? []
      : ['sh', '-c', 'umask 022 && exec "$@"', 'sh', 'timeout', '-s', 'KILL', String(secs)];
    const proc = spawn(docker, [
      'exec',
      '-i',
      ...user[eo.as ?? 'agent'],
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
  const init = await dexec(['sh', '-c', FIXTURE_COMMIT_SCRIPT('/usr/bin/git', '/srv/origin.git')], {
    as: 'git',
  });
  if (init.exit !== 0) await fail('git init', init);
  const baseCommit = init.stdout.trim().split('\n').pop() ?? '';

  let disposed = false;
  return {
    kind: 'docker',
    workDir: WORK_DIR,
    imageDigest: o.image.digest,
    baseCommit,
    exec: (argv, eo) => dexec(argv, eo),
    async finish() {
      const r = await dexec(['node', '-e', KILL_ALL], {
        bare: true,
        as: 'root',
        timeoutMs: 60_000,
      });
      let parsed: { before?: number; rounds?: number; left?: number[] } = {};
      try {
        parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
      } catch {
        // below
      }
      if (r.exit !== 0 || !Array.isArray(parsed.left)) {
        throw new Error(`the sandbox kill loop failed: ${r.stderr.trim() || r.stdout.trim()}`);
      }
      if (parsed.left.length > 0) {
        throw new Error(
          `the sandbox kill loop did not converge: ${parsed.left.length} process(es) still running after ${parsed.rounds} rounds`,
        );
      }
      return { killed: parsed.before ?? 0 };
    },
    async originRefs() {
      const r = await dexec(
        ['sh', '/opt/runner/git-ctx.sh', 'origin', '/srv/origin.git', '/usr/bin/git'],
        { bare: true, as: 'git', maxOutput: 8 * 1024 * 1024 },
      );
      if (r.exit !== 0) throw new Error(`could not read the origin refs: ${r.stderr.trim()}`);
      return r.stdout;
    },
    async exportTree(dest) {
      const buf = await new Promise<Buffer>((res, rej) => {
        const p = spawn(docker, [
          'exec',
          ...user.root,
          name,
          'tar',
          '-C',
          WORK_DIR,
          '-cf',
          '-',
          '.',
        ]);
        const chunks: Buffer[] = [];
        let size = 0;
        let over = false;
        let stderr = '';
        p.stdout.on('data', (b: Buffer) => {
          size += b.length;
          if (size > MAX_TREE_BYTES + 1024 * 1024) {
            over = true;
            p.kill('SIGKILL');
            return;
          }
          chunks.push(b);
        });
        p.stderr.on('data', (b: Buffer) => {
          stderr = (stderr + b.toString()).slice(-2000);
        });
        p.on('close', (code) => {
          if (over) rej(new Error(`the final tree exceeds ${MAX_TREE_BYTES} bytes`));
          else if (code !== 0)
            rej(new Error(`could not copy the final tree out of the sandbox: ${stderr.trim()}`));
          else res(Buffer.concat(chunks));
        });
      });
      extractTar(buf, assertSafeTar(buf), dest);
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
  const gitCtx = join(o.runnerDir, 'git-ctx.sh');
  const baseEnv = { HOME: home, PATH: hostPath, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1' };
  writeProcessShims(shimDir, {
    node: process.execPath,
    recordScript: join(o.runnerDir, 'record.mjs'),
    gitCtx,
    socket: join(setup.channelDir, 'shim.sock'),
    origin,
    baseEnv,
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
    async originRefs() {
      return execFileSync('sh', [gitCtx, 'origin', origin, git], {
        encoding: 'utf8',
        env: { ...baseEnv, GIT_CONFIG_GLOBAL: '/dev/null' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    },
    async exportTree(dest) {
      assertPlainTree(work);
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
