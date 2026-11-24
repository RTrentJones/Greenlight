import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_UID, type RunnerImage, dockerAvailable, ensureRunnerImage } from '../sandbox';
import {
  SANDBOX_PNPM,
  SANDBOX_VITEST,
  type SandboxedCheckAllOptions,
  type TreeEntry,
  checkAllCommands,
  listTreeEntries,
  sameEntry,
} from './evaluated-tree';
import { errMsg, tail } from './helpers';
import { runProcess } from './process';
import type { CheckAllResult } from './types';

// ---- the sandboxed tree: read-only, with declared outputs ----------------------------------

/** The workspace packages of a tree, by the `packages:` globs of its `pnpm-workspace.yaml` (the
 * base's: a candidate cannot change it), the root included. Globs: `dir`, `dir/*`, `!dir/x-*`. */
export function workspacePackages(tree: string): string[] {
  const file = join(tree, 'pnpm-workspace.yaml');
  const out = new Set<string>(['.']);
  if (!existsSync(file)) return [...out];
  const globs: string[] = [];
  let inPackages = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
      if (m) globs.push((m[1] as string).trim());
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  const toRe = (g: string) =>
    new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*?/g, '[^/]*')}$`);
  const negated = globs.filter((g) => g.startsWith('!')).map((g) => toRe(g.slice(1)));
  const isPkg = (rel: string) =>
    !rel.split('/').some((x) => x === '..' || x === 'node_modules') &&
    existsSync(join(tree, rel, 'package.json'));
  for (const g of globs.filter((x) => !x.startsWith('!'))) {
    const clean = g.replace(/\/+$/, '');
    const star = /^(.*?)\/\*\*?$/.exec(clean);
    const candidates = star
      ? existsSync(join(tree, star[1] as string))
        ? readdirSync(join(tree, star[1] as string)).map((n) => `${star[1]}/${n}`)
        : []
      : [clean];
    for (const rel of candidates) {
      if (isPkg(rel) && !negated.some((re) => re.test(rel))) out.add(rel);
    }
  }
  return [...out].sort();
}

/**
 * The only paths of the tree a check-all command may write, each a fresh tmpfs per container
 * (found by running the harness's check-all in the sandbox on a read-only tree): turbo's cache
 * and task logs (`.turbo` in the root and in every workspace package), vitest's cache
 * (`node_modules/.vite`) and `.vitest-tmp/`, the one repo-local scratch directory tests write
 * (configs jiti must resolve from inside the repo; the sandbox `vitest`'s config copy). `typecheck`
 * emits nothing (no `dist`, no tsbuildinfo), and no command reads another's output, so every
 * command starts from the pristine tree. Relative, posix.
 */
export function checkOutputDirs(tree: string): string[] {
  const out = ['.vitest-tmp', 'node_modules/.vite'];
  for (const pkg of workspacePackages(tree)) out.push(pkg === '.' ? '.turbo' : `${pkg}/.turbo`);
  return out;
}

/** Every directory outside node_modules readable (and enterable) by the sandbox's uid, and every
 * file readable; node_modules is left as installed. Nothing is made writable. */
export function makeReadable(root: string): void {
  const walk = (dir: string) => {
    const st = lstatSync(dir);
    if ((st.mode & 0o555) !== 0o555) chmodSync(dir, st.mode | 0o555);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const e = lstatSync(p);
      if (e.isDirectory()) {
        if (name !== 'node_modules') walk(p);
      } else if (e.isFile() && (e.mode & 0o444) !== 0o444) chmodSync(p, e.mode | 0o444);
    }
  };
  walk(root);
}

export interface TreeSnapshot {
  /** `listTreeEntries`: the content of everything outside node_modules / .git / .turbo. */
  entries: Map<string, TreeEntry>;
  /** Every file and link under every node_modules (size, mode, mtime, inode; link targets),
   * the declared output mount points excluded. */
  modules: Map<string, string>;
}

/** What the tree is now: content hashes outside node_modules, a stat manifest inside it. */
export function treeSnapshot(root: string): TreeSnapshot {
  const outputs = new Set(checkOutputDirs(root));
  const modules = new Map<string, string>();
  const walkModules = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = `${rel}/${name}`;
      if (outputs.has(r)) continue;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) walkModules(r);
      else if (st.isSymbolicLink()) modules.set(r, `l:${readlinkSync(join(root, r))}`);
      else modules.set(r, `f:${st.size}:${st.mode}:${st.mtimeMs}:${st.ino}`);
    }
  };
  const findModules = (rel: string) => {
    for (const name of readdirSync(join(root, rel || '.')).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (!st.isDirectory() || name === '.git') continue;
      if (name === 'node_modules') walkModules(r);
      else findModules(r);
    }
  };
  findModules('');
  return { entries: listTreeEntries(root), modules };
}

/** The paths that differ between two snapshots (at most 10 named), or null when none do. */
export function snapshotDrift(a: TreeSnapshot, b: TreeSnapshot): string | null {
  const diff: string[] = [];
  for (const [p, e] of b.entries) if (!sameEntry(a.entries.get(p), e)) diff.push(p);
  for (const p of a.entries.keys()) if (!b.entries.has(p)) diff.push(`${p} (removed)`);
  for (const [p, v] of b.modules) if (a.modules.get(p) !== v) diff.push(p);
  for (const p of a.modules.keys()) if (!b.modules.has(p)) diff.push(`${p} (removed)`);
  if (diff.length === 0) return null;
  return `${diff.slice(0, 10).join(', ')}${diff.length > 10 ? ` and ${diff.length - 10} more` : ''}`;
}

const DOCKER_CLIENT_ENV = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

/** The docker client's own environment, and nothing of the harness's. */
export function dockerClientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of DOCKER_CLIENT_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export const stampOf = (s: string) =>
  createHash('sha256').update(`${s}${Date.now()}${Math.random()}`).digest('hex').slice(0, 12);

export async function removeContainer(docker: string, name: string): Promise<void> {
  await runProcess(docker, ['rm', '-f', name], {
    cwd: tmpdir(),
    env: dockerClientEnv(),
    timeoutMs: 60_000,
  });
}

/**
 * `docker run` arguments for one container of the bench runner image that runs tree code: uid
 * 10000 (group shim, so git runs), `--network none`, `--read-only` root, `--cap-drop ALL`,
 * `no-new-privileges`, pid/memory/cpu limits, tmpfs `/tmp` and HOME, the tree READ-ONLY at its
 * host path (pnpm's .bin shims name absolute paths), a fresh tmpfs over each declared output,
 * and `mounts` (read-only helpers). Only the variables set here enter the container.
 */
export function sandboxRunArgs(o: {
  name: string;
  image: RunnerImage;
  tree: string;
  outputs: readonly string[];
  mounts: readonly string[];
  workdir: string;
  path: string;
  env?: Record<string, string>;
  memory?: string | undefined;
  cpus?: string | undefined;
}): string[] {
  const tmpfs = `rw,exec,uid=${AGENT_UID},gid=${AGENT_UID},mode=0700`;
  return [
    'run',
    '--rm',
    '--name',
    o.name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '4096',
    '--memory',
    o.memory ?? '6g',
    '--cpus',
    o.cpus ?? '2',
    '-u',
    `${AGENT_UID}:${o.image.shimUid}`,
    '--tmpfs',
    '/tmp:rw,exec,mode=1777,size=2g',
    '--tmpfs',
    `/home/agent:${tmpfs},size=256m`,
    '-v',
    `${o.tree}:${o.tree}:ro`,
    ...o.outputs.flatMap((out) => ['--tmpfs', `${join(o.tree, out)}:${tmpfs},size=1g`]),
    ...o.mounts,
    '-w',
    o.workdir,
    '-e',
    'HOME=/home/agent',
    '-e',
    'TZ=UTC',
    ...Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-e',
    `PATH=${o.path}`,
    o.image.tag,
  ];
}

/**
 * The harness's check-all commands (`checkAllCommands(harnessRoot)`) on the evaluated `tree`,
 * each in a fresh container (`sandboxRunArgs`): the tree read-only, a fresh tmpfs over each of
 * `checkOutputDirs(tree)`, and three read-only helpers (the `pnpm run` and `vitest` shims, and a
 * git system config that trusts the tree). After every command `o.verify` re-hashes the tree;
 * drift stops the suite (`mutated`). No harness environment variable enters the container (the
 * docker client's own environment is not forwarded). Without docker or the runner image the
 * result is `unavailable`, never a pass or a fail.
 */
export async function runSandboxedCheckAll(
  harnessRoot: string,
  tree: string,
  o: SandboxedCheckAllOptions = {},
): Promise<CheckAllResult> {
  const docker = o.docker ?? 'docker';
  if (!dockerAvailable(docker)) {
    return { ok: false, unavailable: true, detail: 'docker is not available' };
  }
  let image: RunnerImage;
  try {
    image = o.image ?? ensureRunnerImage(join(harnessRoot, 'bench', 'runner'), { docker });
  } catch (e) {
    return { ok: false, unavailable: true, detail: `no runner image: ${errMsg(e)}` };
  }
  const commands = checkAllCommands(harnessRoot);
  const dir = resolve(tree);
  const harnessPkg = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const pnpmVersion = /^pnpm@([\w.-]+)/.exec(harnessPkg.packageManager ?? '')?.[1] ?? '10.0.0';
  const outputs = checkOutputDirs(dir);
  for (const out of outputs) mkdirSync(join(dir, out), { recursive: true });
  makeReadable(dir);
  const aux = mkdtempSync(join(tmpdir(), 'greenlight-check-all-aux-'));
  const stamp = stampOf(dir);
  try {
    mkdirSync(join(aux, 'bin'));
    writeFileSync(join(aux, 'bin', 'pnpm'), SANDBOX_PNPM, { mode: 0o755 });
    writeFileSync(join(aux, 'bin', 'vitest'), SANDBOX_VITEST, { mode: 0o755 });
    writeFileSync(join(aux, 'git.cfg'), '[safe]\n\tdirectory = *\n', { mode: 0o644 });
    chmodSync(aux, 0o755);
    chmodSync(join(aux, 'bin'), 0o755);
    let detail = '';
    let i = 0;
    for (const cmd of commands) {
      const name = `gl-check-all-${stamp}-${i++}`;
      const args = sandboxRunArgs({
        name,
        image,
        tree: dir,
        outputs,
        mounts: [
          '-v',
          `${join(aux, 'bin')}:/opt/gl-bin:ro`,
          '-v',
          `${join(aux, 'git.cfg')}:/etc/gitconfig:ro`,
        ],
        workdir: dir,
        path: `/opt/gl-bin:${dir}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
        env: { TURBO_TELEMETRY_DISABLED: '1', GL_PNPM_VERSION: pnpmVersion },
        memory: o.memory,
        cpus: o.cpus,
      });
      const res = await runProcess(docker, [...args, 'sh', '-c', cmd], {
        cwd: aux,
        env: dockerClientEnv(),
        timeoutMs: o.timeoutMs ?? 3_600_000,
      });
      if (res.timedOut) await removeContainer(docker, name);
      detail = `$ ${cmd}\n${res.output}`;
      const drift = o.verify?.() ?? null;
      if (drift) return { ok: false, mutated: `after \`${cmd}\`: ${drift}`, detail };
      // 125: docker itself could not start the container; that is no verdict on the candidate.
      if (res.code === 125) {
        return { ok: false, unavailable: true, detail: `docker run failed: ${tail(res.output)}` };
      }
      if (res.code !== 0 || res.timedOut) return { ok: false, detail };
    }
    return { ok: true, detail };
  } finally {
    rmSync(aux, { recursive: true, force: true });
  }
}
