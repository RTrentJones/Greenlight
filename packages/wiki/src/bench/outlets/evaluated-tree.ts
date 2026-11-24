import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { RunnerImage } from '../sandbox';
import { SAFE_GIT_ARGS } from './git';

// ---- the evaluated tree: base + the candidate's diff ------------------------------------------

/**
 * Paths a candidate may not change (vision 06 §5.6): everything that decides what the install,
 * check-all and the bench run, so a candidate cannot rewrite the suite it is judged by. Matched on
 * the repo-relative posix path; a basename rule applies at any depth.
 */
export const HARNESS_CONFIG_PATHS: readonly { rule: string; re: RegExp }[] = [
  { rule: 'package.json', re: /(^|\/)package\.json$/ },
  { rule: 'pnpm-lock.yaml', re: /(^|\/)pnpm-lock\.yaml$/ },
  { rule: 'pnpm-workspace.yaml', re: /(^|\/)pnpm-workspace\.yaml$/ },
  { rule: '.npmrc', re: /(^|\/)\.npmrc$/ },
  { rule: '.pnpmfile.{cjs,mjs,js}', re: /(^|\/)\.pnpmfile\.[cm]?js$/ },
  { rule: '.gitignore', re: /(^|\/)\.gitignore$/ },
  { rule: 'turbo.json', re: /(^|\/)turbo\.jsonc?$/ },
  { rule: 'vitest.config.*', re: /(^|\/)vite(st)?\.(config|workspace)\.[\w.]+$/ },
  { rule: 'biome.json*', re: /(^|\/)biome\.jsonc?$/ },
  { rule: 'tsconfig*.json', re: /(^|\/)tsconfig[^/]*\.json$/ },
  { rule: '.dependency-cruiser.cjs', re: /(^|\/)\.dependency-cruiser\.[cm]?js$/ },
  { rule: 'scripts/**', re: /^scripts\// },
  { rule: '.github/**', re: /^\.github\// },
  { rule: 'bench/**', re: /^bench\// },
];

/** Never copied from either tree: dependencies, git state, and build caches a candidate could
 * plant (a turbo cache hit or a tsbuildinfo would skip the very check it records). */
const NEVER_COPIED_DIRS = new Set(['node_modules', '.git', '.turbo']);
const neverCopied = (name: string, isDir: boolean) =>
  isDir ? NEVER_COPIED_DIRS.has(name) : name === '.git' || name.endsWith('.tsbuildinfo');

export type TreeEntry =
  | { kind: 'file'; hash: string; exec: boolean }
  | { kind: 'link'; target: string };

/** Every file and link of a tree, by repo-relative posix path (`neverCopied` names skipped). */
export function listTreeEntries(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (neverCopied(name, st.isDirectory())) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink())
        out.set(r, { kind: 'link', target: readlinkSync(join(root, r)) });
      else if (st.isFile()) {
        const hash = createHash('sha256')
          .update(readFileSync(join(root, r)))
          .digest('hex');
        out.set(r, { kind: 'file', hash, exec: (st.mode & 0o111) !== 0 });
      }
      // sockets, fifos, devices: never part of a tree
    }
  };
  walk('');
  return out;
}

export const sameEntry = (a: TreeEntry | undefined, b: TreeEntry | undefined) =>
  !!a &&
  !!b &&
  (a.kind === 'file'
    ? b.kind === 'file' && a.hash === b.hash && a.exec === b.exec
    : b.kind === 'link' && a.target === b.target);

/** The candidate's diff against the base: every path added or changed, and every one removed. */
export function candidateDiff(
  baseDir: string,
  candDir: string,
): {
  changed: string[];
  removed: string[];
  base: Map<string, TreeEntry>;
  candidate: Map<string, TreeEntry>;
} {
  const base = listTreeEntries(baseDir);
  const candidate = listTreeEntries(candDir);
  const changed = [...candidate.keys()].filter((p) => !sameEntry(base.get(p), candidate.get(p)));
  const removed = [...base.keys()].filter((p) => !candidate.has(p));
  return { changed, removed, base, candidate };
}

/** The paths that touch the harness's configuration (`HARNESS_CONFIG_PATHS`). */
export function harnessConfigTouches(paths: readonly string[]): string[] {
  return paths.filter((p) => HARNESS_CONFIG_PATHS.some((r) => r.re.test(p)));
}

/** Markers that switch a check off. A diff that adds one is still evaluated (no refusal), but
 * the owner's hand-off says so (`suppressionNotes`). */
export const SUPPRESSION_MARKERS: readonly { marker: string; re: RegExp }[] = [
  { marker: 'biome-ignore', re: /biome-ignore/g },
  { marker: '@ts-nocheck', re: /@ts-nocheck/g },
  { marker: '@ts-ignore', re: /@ts-ignore/g },
  { marker: 'eslint-disable', re: /eslint-disable/g },
  { marker: '.skip', re: /\b(?:it|describe|test|suite|bench)\.skip\b/g },
  { marker: '.only', re: /\b(?:it|describe|test|suite|bench)\.only\b/g },
];

const countOf = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** One note per changed text file that has more of a `SUPPRESSION_MARKERS` marker in the
 * candidate than in the base (a new file counts from zero). */
export function suppressionNotes(
  baseDir: string,
  candDir: string,
  changed: readonly string[],
): string[] {
  const read = (root: string, rel: string): string | null => {
    const f = join(root, rel);
    try {
      if (!lstatSync(f).isFile()) return null;
      const buf = readFileSync(f);
      return buf.includes(0) ? null : buf.toString('utf8');
    } catch {
      return null;
    }
  };
  const notes: string[] = [];
  for (const rel of changed) {
    const now = read(candDir, rel);
    if (now === null) continue;
    const was = read(baseDir, rel) ?? '';
    const added = SUPPRESSION_MARKERS.map((m) => ({
      m: m.marker,
      n: countOf(now, m.re) - countOf(was, m.re),
    })).filter((x) => x.n > 0);
    if (added.length > 0) {
      notes.push(
        `the candidate adds ${added.map((x) => `\`${x.m}\` ×${x.n}`).join(', ')} in ${rel}`,
      );
    }
  }
  return notes;
}

/**
 * Writes `dest`: a copy of the base tree with the candidate's diff overlaid. Refuses, writing
 * nothing, a diff that touches the harness's configuration or adds a link that points out of the
 * tree. Neither tree's `node_modules`, `.git`, `.turbo` or tsbuildinfo is copied.
 */
export function buildEvaluatedTree(
  baseDir: string,
  candDir: string,
  dest: string,
):
  | { ok: true; changed: string[]; removed: string[] }
  | { refused: 'harness-config' | 'unsafe-link'; paths: string[] } {
  const d = candidateDiff(baseDir, candDir);
  const touched = harnessConfigTouches([...d.changed, ...d.removed]);
  if (touched.length > 0) return { refused: 'harness-config', paths: touched };
  const escapes = (p: string, target: string) =>
    isAbsolute(target) || relative('.', join(dirname(p), target)).split('/')[0] === '..';
  const badLinks = d.changed.filter((p) => {
    const e = d.candidate.get(p);
    return e?.kind === 'link' && escapes(p, e.target);
  });
  if (badLinks.length > 0) return { refused: 'unsafe-link', paths: badLinks };
  mkdirSync(dest, { recursive: true });
  const place = (from: string, rel: string, e: TreeEntry) => {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (e.kind === 'link') symlinkSync(e.target, to);
    else {
      copyFileSync(join(from, rel), to);
      chmodSync(to, e.exec ? 0o755 : 0o644);
    }
  };
  const changed = new Set(d.changed);
  for (const [rel, e] of d.base) {
    if (d.candidate.has(rel) && !changed.has(rel)) place(baseDir, rel, e);
  }
  for (const rel of d.changed) place(candDir, rel, d.candidate.get(rel) as TreeEntry);
  return { ok: true, changed: d.changed, removed: d.removed };
}

/** A fresh repository holding `dir` as one commit: no remote, and neither the system nor the
 * global config (so no harness credential or extraheader), for checks that need a git tree. */
export function freshGit(dir: string): void {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'greenlight-bench',
    GIT_AUTHOR_EMAIL: 'bench@greenlight.invalid',
    GIT_COMMITTER_NAME: 'greenlight-bench',
    GIT_COMMITTER_EMAIL: 'bench@greenlight.invalid',
  };
  const g = (args: string[]) =>
    execFileSync('git', [...SAFE_GIT_ARGS, ...args], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-q', '--no-verify', '--allow-empty', '-m', 'evaluated tree']);
}

/**
 * The framework suite's commands, from the HARNESS tree's `package.json` (`scripts["check-all"]`),
 * never the candidate's: a candidate that rewrites `"check-all": "true"` (or any script it chains)
 * is judged by the harness's suite all the same. `pnpm <script>` / `pnpm run <script>` steps are
 * expanded through the harness's scripts until only leaf commands remain.
 */
export function checkAllCommands(harnessRoot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const top = scripts['check-all'];
  if (!top) throw new Error(`no check-all script in ${harnessRoot}/package.json`);
  const expand = (cmd: string, depth: number): string[] =>
    cmd
      .split('&&')
      .map((x) => x.trim())
      .filter(Boolean)
      .flatMap((part) => {
        const m = /^pnpm\s+(?:run\s+)?([\w:.-]+)$/.exec(part);
        const sub = m ? scripts[m[1] as string] : undefined;
        if (sub === undefined) return [part];
        if (depth > 8) throw new Error(`check-all expands too deep at ${part}`);
        return expand(sub, depth + 1);
      });
  return expand(top, 0);
}

/**
 * The `pnpm` inside the check-all sandbox: `pnpm run <script>` and `--version` only (what turbo
 * needs), reading the script from the package.json in its cwd. The host's pnpm (a glibc binary in
 * CI) never enters the container, and nothing installs there: the network is off.
 */
export const SANDBOX_PNPM = String.raw`#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--config.'));
if (args[0] === '--version' || args[0] === '-v') { console.log(process.env.GL_PNPM_VERSION || '10.0.0'); process.exit(0); }
const rest = args[0] === 'run' || args[0] === 'run-script' ? args.slice(1) : args;
const name = rest[0];
const pkgFile = join(process.cwd(), 'package.json');
const scripts = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')).scripts || {} : {};
if (!name || scripts[name] === undefined) { console.error('sandbox pnpm: no script "' + name + '" in ' + pkgFile); process.exit(1); }
const bins = [];
for (let d = process.cwd(); ; d = dirname(d)) { const b = join(d, 'node_modules', '.bin'); if (existsSync(b)) bins.push(b); if (dirname(d) === d) break; }
const q = (s) => "'" + s.split("'").join("'\\''") + "'";
const cmd = [scripts[name], ...rest.slice(1).filter((a) => a !== '--').map(q)].join(' ');
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env: { ...process.env, PATH: ['/opt/gl-bin', ...bins, process.env.PATH].join(':'), npm_lifecycle_event: name } });
process.exit(r.status === null ? 1 : r.status);
`;

/**
 * The `vitest` inside the check-all sandbox. The tree is mounted read-only, and vite writes a
 * bundled copy of its config NEXT TO the config file before importing it, so the tree's root
 * config (the base's: a candidate cannot change it) is copied into the writable `.vitest-tmp/`
 * and named with `--config`; the root, and so every include glob, stays the tree.
 */
export const SANDBOX_VITEST = String.raw`#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const cwd = process.cwd();
const real = join(cwd, 'node_modules', '.bin', 'vitest');
if (!existsSync(real)) { console.error('sandbox vitest: no node_modules/.bin/vitest in ' + cwd); process.exit(1); }
const named = args.some((a) => a === '--config' || a === '-c' || a.startsWith('--config='));
const extra = [];
if (!named) {
  const cfg = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((x) => 'vitest.config.' + x).find((f) => existsSync(join(cwd, f)));
  if (cfg) {
    const dir = join(cwd, '.vitest-tmp', '.config');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(cwd, cfg), join(dir, cfg));
    extra.push('--config', join(dir, cfg));
  }
}
const r = spawnSync(real, [...args, ...extra], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`;

export interface SandboxOptions {
  docker?: string;
  /** The runner image (default: `ensureRunnerImage(<harness>/bench/runner)`). */
  image?: RunnerImage;
  memory?: string;
  cpus?: string;
}

export interface SandboxedCheckAllOptions extends SandboxOptions {
  /** Per command (default 1 h). */
  timeoutMs?: number;
  /** Called after every command: a non-null drift (`snapshotDrift`) stops the suite as
   * `mutated`, before any later command runs on the changed tree. */
  verify?: () => string | null;
}
