import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { z } from 'zod';
import { idToPath, normalizeId } from './ids';
import { appendLogEntry, reconcileIndex } from './index-gen';
import { type LintContext, lintScratch } from './lint';
import { INDEX_FILE, LOG_FILE, type Wiki, withWrites } from './load';
import { PageParseError, type ParsedPage, parsePage } from './parse';
import {
  MaintainerOutputSchema,
  type PatchOpSchema,
  type ProposerOutput,
  ProposerOutputSchema,
} from './schema';

/**
 * The patch engine (vision 08 §9). Every edit names its target by exact substring, and a target
 * must occur exactly once: zero means the editor worked from a stale page, and two means the edit
 * is ambiguous. Either refuses the whole output — nothing is written unless everything applies.
 */

export type PatchOp = z.infer<typeof PatchOpSchema>;
export type FilePatchOp = Extract<ProposerOutput, { action: 'patch' }>['edits'][number];

/** A set of whole-file writes, paths relative to the directory the changeset is applied to. */
export interface Changeset {
  writes: { path: string; content: string }[];
}

export type ApplyResult =
  | { ok: true; changeset: Changeset; indexCorrections: string[] }
  | { ok: false; errors: string[] };

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/** Counts occurrences of `target` in `text`, overlapping ones included, so "aa" in "aaa" is 2. */
function occurrences(text: string, target: string): number {
  let n = 0;
  for (let i = text.indexOf(target); i >= 0; i = text.indexOf(target, i + 1)) n++;
  return n;
}

/** Applies one op. Throws `PatchError` when its target does not occur exactly once. */
export function applyOp(text: string, op: PatchOp): string {
  if (op.op === 'append') return text + op.text;
  const n = occurrences(text, op.target);
  if (n !== 1) {
    const why = n === 0 ? 'does not occur' : `occurs ${n} times`;
    throw new PatchError(
      `${op.op} target ${JSON.stringify(op.target)} ${why}; it must occur exactly once`,
    );
  }
  const at = text.indexOf(op.target);
  const end = at + op.target.length;
  return op.op === 'replace'
    ? text.slice(0, at) + op.text + text.slice(end)
    : text.slice(0, end) + op.text + text.slice(end);
}

/** Applies `ops` in order, each to the result of the previous one. Throws `PatchError` naming the
 * failing op's index. */
export function applyOps(text: string, ops: readonly PatchOp[]): string {
  return ops.reduce((acc, op, i) => {
    try {
      return applyOp(acc, op);
    } catch (err) {
      if (err instanceof PatchError) throw new PatchError(`op ${i}: ${err.message}`);
      throw err;
    }
  }, text);
}

const zodErrors = (issues: readonly z.ZodIssue[]): string[] =>
  issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

/** Parses a page's new content and checks its id still names its path. */
function checkPage(
  id: string,
  path: string,
  content: string,
): { page?: ParsedPage; problems: string[] } {
  let page: ParsedPage;
  try {
    page = parsePage(path, content);
  } catch (err) {
    if (err instanceof PageParseError) return { problems: [err.message] };
    throw err;
  }
  const declared = normalizeId(page.frontmatter.id);
  const problems =
    declared === id ? [] : [`${path}: frontmatter id "${page.frontmatter.id}" is not ${id}`];
  return { page, problems };
}

/**
 * Turns a maintainer output (08 §9.1) into a changeset for the wiki root, or refuses it whole.
 * Checks: the output schema; creates name new ids and start as `hypothesis` (a maintainer cannot
 * create a confirmed page, 07 §3.7); every op target occurs once; every resulting page parses.
 * The submitted index is reconciled with the generated one (06 §2.3), and the log entry records
 * any corrections. Finally LR-19 (seam) and LR-20 (secrets) run on the scratch wiki (06 §2.4), and
 * any finding in a file this output writes rejects it. LR-20's shape detector always runs; LR-19
 * runs when `lint` is a framework context with seam terms.
 */
export function applyMaintainerOutput(
  wiki: Wiki,
  output: unknown,
  opts: {
    actor: string;
    now?: Date;
    lint?: Pick<LintContext, 'kind' | 'seam' | 'secretValues'>;
  },
): ApplyResult {
  const parsed = MaintainerOutputSchema.safeParse(output);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error.issues) };
  const out = parsed.data;
  const errors: string[] = [];
  const writes: Changeset['writes'] = [];
  // Defence in depth behind the schema's canonical-id check: one write per path.
  const claimed = new Map<string, string>();
  const claim = (path: string, at: string): boolean => {
    const prior = claimed.get(path);
    if (prior !== undefined) {
      errors.push(
        `${at}: ${path} is already written by ${prior}; one create or one update per page`,
      );
      return false;
    }
    claimed.set(path, at);
    return true;
  };

  for (const [i, c] of out.create_pages.entries()) {
    const at = `create_pages.${i}`;
    const id = normalizeId(c.id);
    const path = pagePath(id);
    if (!path) {
      errors.push(`${at}: "${c.id}" is not a page id`);
      continue;
    }
    if (wiki.pages.has(id) || wiki.files.has(path)) {
      errors.push(`${at}: page "${id}" already exists`);
      continue;
    }
    if (!claim(path, at)) continue;
    const { page, problems } = checkPage(id, path, c.content);
    errors.push(...problems.map((p) => `${at}: ${p}`));
    if (page && page.frontmatter.status !== 'hypothesis') {
      errors.push(`${at}: a maintainer creates pages as status: hypothesis`);
    }
    writes.push({ path, content: c.content });
  }

  for (const [i, u] of out.update_pages.entries()) {
    const at = `update_pages.${i}`;
    const page = wiki.pages.get(normalizeId(u.id));
    if (!page) {
      errors.push(`${at}: page "${u.id}" does not exist`);
      continue;
    }
    if (!claim(page.path, at)) continue;
    let content: string;
    try {
      content = applyOps(page.raw, u.ops);
    } catch (err) {
      if (!(err instanceof PatchError)) throw err;
      errors.push(`${at} (${page.id}): ${err.message}`);
      continue;
    }
    errors.push(...checkPage(page.id, page.path, content).problems.map((p) => `${at}: ${p}`));
    writes.push({ path: page.path, content });
  }

  if (errors.length > 0) return { ok: false, errors };

  const scratch = withWrites(wiki, writes);
  const { index, corrections } = reconcileIndex(out.update_index, scratch);
  const body = corrections.length
    ? `${out.append_log.trim()}\nindex corrections: ${corrections.join('; ')}`
    : out.append_log;
  const ts = (opts.now ?? new Date()).toISOString();
  const log = appendLogEntry(wiki.log, { ts, actor: opts.actor, operation: 'ingest', body });
  writes.push({ path: INDEX_FILE, content: index }, { path: LOG_FILE, content: log });

  const written = new Set(writes.map((w) => w.path));
  const findings = lintScratch(withWrites(wiki, writes), {
    kind: opts.lint?.kind ?? 'project',
    ...(opts.lint?.seam ? { seam: opts.lint.seam } : {}),
    ...(opts.lint?.secretValues ? { secretValues: opts.lint.secretValues } : {}),
  }).filter((f) => written.has(f.page));
  if (findings.length > 0) {
    return { ok: false, errors: findings.map((f) => `${f.rule} ${f.page}: ${f.message}`) };
  }
  return { ok: true, changeset: { writes }, indexCorrections: corrections };
}

function pagePath(id: string): string | undefined {
  try {
    return idToPath(id);
  } catch {
    return undefined;
  }
}

/** True when `path` resolves inside `root` (never `root` itself, never through `..`). */
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Applies a proposer's multi-file edits (08 §9.2) relative to `root` (the skill directory, or the
 * named template directory). Every file must already exist inside `root` — also after symlinks
 * are resolved, so a link cannot smuggle a write outside it — and every op must apply; otherwise
 * nothing is returned but errors. Ops on one file apply in array order.
 */
export function applyFilePatches(root: string, edits: readonly FilePatchOp[]): ApplyResult {
  const base = realpathSync(root);
  const texts = new Map<string, string>();
  const errors: string[] = [];
  for (const [i, { file, ...op }] of edits.entries()) {
    const at = `edits.${i} (${file})`;
    const current = texts.get(file) ?? readContained(base, file);
    if (typeof current !== 'string') {
      errors.push(`${at}: ${current.error}`);
      continue;
    }
    try {
      texts.set(file, applyOp(current, op as PatchOp));
    } catch (err) {
      if (!(err instanceof PatchError)) throw err;
      errors.push(`${at}: ${err.message}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const writes = [...texts].map(([path, content]) => ({ path, content }));
  return { ok: true, changeset: { writes }, indexCorrections: [] };
}

/** Reads `file` under `base`, refusing paths that leave it before or after resolving symlinks. */
function readContained(base: string, file: string): string | { error: string } {
  const abs = resolve(base, file);
  if (!contained(base, abs)) return { error: 'is outside the target' };
  if (!existsSync(abs)) return { error: 'does not exist' };
  if (!contained(base, realpathSync(abs))) return { error: 'resolves outside the target' };
  return readFileSync(abs, 'utf8');
}

/** Validates a proposer output, then applies its edits; only `patch` outputs carry edits. */
export function applyProposerPatch(root: string, output: unknown): ApplyResult {
  const parsed = ProposerOutputSchema.safeParse(output);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error.issues) };
  if (parsed.data.action !== 'patch') {
    return { ok: false, errors: [`action "${parsed.data.action}" carries no file edits`] };
  }
  return applyFilePatches(root, parsed.data.edits);
}

/**
 * Writes a changeset under `root` as close to atomically as a filesystem allows: every file is
 * staged next to its target first, and targets are replaced by rename only once all staging
 * succeeded. A staging failure removes the staged files and leaves every target untouched.
 */
export function writeChangeset(root: string, changeset: Changeset): void {
  const base = resolve(root);
  const staged: { tmp: string; target: string }[] = [];
  try {
    for (const w of changeset.writes) {
      const target = resolve(base, w.path);
      if (!contained(base, target)) throw new PatchError(`${w.path} is outside ${root}`);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.gl-tmp-${randomBytes(6).toString('hex')}`);
      writeFileSync(tmp, w.content);
      staged.push({ tmp, target });
    }
  } catch (err) {
    for (const s of staged) rmSync(s.tmp, { force: true });
    throw err;
  }
  for (const s of staged) renameSync(s.tmp, s.target);
}
