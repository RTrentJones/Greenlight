import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EVIDENCE_REF_RE } from '@rtrentjones/greenlight-shared';
import type { OutletContext } from './context';
import { buildEvaluatedTree, freshGit, listTreeEntries, suppressionNotes } from './evaluated-tree';
import { safeGit } from './git';
import { errMsg, tail } from './helpers';
import { runProcess } from './process';
import { checkOutputDirs } from './sandbox';
import type { OutletTreeRef } from './types';

// ---- trees ----------------------------------------------------------------------------------

type Opened =
  | { dir: string; ref: string }
  | { error: string; code: 'unpinned-tree' | 'checkout-failed' };

/** Opens trees for one evaluation and removes every worktree it added on `close()`. */
export class Checkouts {
  private readonly added: string[] = [];
  private readonly scratch: string[] = [];
  constructor(private readonly ctx: OutletContext) {}

  private get repo(): string {
    return this.ctx.sourceRepo ?? 'RTrentJones/greenlight';
  }

  /** The evaluated tree: a fresh copy of `baseDir` with the candidate's diff overlaid, its
   * dependencies installed from the base lockfile, and a fresh `.git` (no remote, no config). */
  async evaluated(
    baseDir: string,
    candDir: string,
  ): Promise<
    | { dir: string; notes: string[] }
    | {
        error: string;
        code: 'candidate-touches-harness-config' | 'candidate-unsafe-tree' | 'checkout-failed';
      }
  > {
    const root = mkdtempSync(join(tmpdir(), 'greenlight-outlet-evaluated-'));
    this.scratch.push(root);
    const dir = join(root, 'tree');
    const built = buildEvaluatedTree(baseDir, candDir, dir);
    if ('refused' in built) {
      return built.refused === 'harness-config'
        ? {
            error: `the candidate changes the harness's own configuration (${built.paths.slice(0, 10).join(', ')}${built.paths.length > 10 ? ', …' : ''}); such a change is reviewed by a human, never evaluated`,
            code: 'candidate-touches-harness-config',
          }
        : {
            error: `the candidate tree has a link that leaves it: ${built.paths.join(', ')}`,
            code: 'candidate-unsafe-tree',
          };
    }
    try {
      await (this.ctx.prepareTree ?? defaultPrepareTree)(dir);
      freshGit(dir);
      // The declared outputs' mount points exist before the pristine snapshot is taken.
      for (const out of checkOutputDirs(dir)) mkdirSync(join(dir, out), { recursive: true });
    } catch (e) {
      return { error: `evaluated tree: ${errMsg(e)}`, code: 'checkout-failed' };
    }
    return { dir, notes: suppressionNotes(baseDir, candDir, built.changed) };
  }

  async open(t: OutletTreeRef, label: string, o: { install?: boolean } = {}): Promise<Opened> {
    if ('dir' in t) {
      // Host git never runs in a directory (its .git/config could name an fsmonitor, a hook or
      // a filter): a git checkout is named by its commit, resolved in the harness repository.
      const dir = resolve(t.dir);
      if (!existsSync(dir))
        return { error: `${label}: no directory ${dir}`, code: 'checkout-failed' };
      if (existsSync(join(dir, '.git'))) {
        return {
          error: `${label}: ${dir} has its own .git; git is never run in a given directory, so name the commit instead (it is resolved in the harness repository)`,
          code: 'unpinned-tree',
        };
      }
      if (t.ref === undefined) {
        return {
          error: `${label}: ${dir} has no evidence ref, so the result could not be recomputed`,
          code: 'unpinned-tree',
        };
      }
      if (!EVIDENCE_REF_RE.test(t.ref)) {
        return { error: `${label}: "${t.ref}" is not an evidence ref`, code: 'unpinned-tree' };
      }
      if (t.ref.startsWith('commit:')) {
        return {
          error: `${label}: a directory cannot be shown to be ${t.ref} without running git in it; name the commit instead`,
          code: 'unpinned-tree',
        };
      }
      if (t.hash !== undefined && treeContentHash(dir) !== t.hash) {
        return {
          error: `${label}: ${dir} no longer has the contents it was pinned with (${t.hash.slice(0, 12)})`,
          code: 'unpinned-tree',
        };
      }
      return { dir, ref: t.ref };
    }
    let sha: string;
    try {
      sha = safeGit(this.ctx.repoRoot, ['rev-parse', '--verify', `${t.commit}^{commit}`]);
    } catch (e) {
      return {
        error: `${label}: ${t.commit} is not a commit: ${errMsg(e)}`,
        code: 'checkout-failed',
      };
    }
    const root = mkdtempSync(join(tmpdir(), `greenlight-outlet-${label}-`));
    this.scratch.push(root);
    const dir = join(root, 'tree');
    try {
      safeGit(this.ctx.repoRoot, ['worktree', 'add', '--detach', dir, sha]);
      this.added.push(dir);
      if (o.install !== false) await (this.ctx.prepareTree ?? defaultPrepareTree)(dir);
    } catch (e) {
      return {
        error: `${label}: could not check out ${sha}: ${errMsg(e)}`,
        code: 'checkout-failed',
      };
    }
    return { dir, ref: `commit:${this.repo}@${sha}` };
  }

  close(): void {
    for (const dir of this.added) {
      try {
        safeGit(this.ctx.repoRoot, ['worktree', 'remove', '--force', dir]);
      } catch {
        // removed below; prune drops the registration
      }
    }
    for (const s of this.scratch) rmSync(s, { recursive: true, force: true });
    if (this.added.length > 0) {
      try {
        safeGit(this.ctx.repoRoot, ['worktree', 'prune']);
      } catch {
        // best effort
      }
    }
  }
}

/** sha256 over a directory's contents as `listTreeEntries` sees them (node_modules, .git, .turbo
 * and tsbuildinfo skipped): what a directory pin binds. */
export function treeContentHash(dir: string): string {
  const h = createHash('sha256');
  for (const [p, e] of listTreeEntries(dir)) {
    h.update(
      e.kind === 'file' ? `f\0${p}\0${e.hash}\0${e.exec ? 1 : 0}\n` : `l\0${p}\0${e.target}\n`,
    );
  }
  return h.digest('hex');
}

/** Environment variables a dependency install may need (the store, the proxy, CA bundles) and
 * nothing else: no API key or token of the harness reaches a candidate tree's install. */
const INSTALL_ENV_ALLOW = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'PNPM_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];

export function installEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { CI: '1' };
  for (const k of INSTALL_ENV_ALLOW) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The registry every install uses: the harness's default, never one a tree configures. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

async function defaultPrepareTree(tree: string): Promise<void> {
  // --ignore-scripts and --ignore-pnpmfile: nothing of the tree's runs during the install; the
  // registry is the harness's, whatever the tree's .npmrc says.
  const res = await runProcess(
    'pnpm',
    [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      `--config.registry=${DEFAULT_REGISTRY}`,
    ],
    { cwd: tree, env: installEnv(), timeoutMs: 600_000 },
  );
  if (res.code !== 0) throw new Error(`pnpm install failed:\n${tail(res.output)}`);
}
