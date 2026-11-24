import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isArchivedPath, pathToId } from './ids';
import { type PageIssue, PageParseError, type ParsedPage, parsePage } from './parse';
import { type LedgerEvent, LedgerEventSchema } from './schema';

/**
 * Loading a wiki (vision 03 §3 `load.ts`). Loading never throws on bad content: a page that fails
 * to parse, or a ledger line that fails its schema, is recorded so that lint can report every
 * problem at once instead of stopping at the first.
 */

export interface WikiPage extends ParsedPage {
  /** Canonical id derived from the path (not from frontmatter, which LR-02 checks against it). */
  id: string;
  /** Under `archive/` or `status: archived`; such pages drop out of the index (04 §4). */
  archived: boolean;
}

export interface PageError {
  path: string;
  kind: 'parse' | 'duplicate';
  issues: readonly PageIssue[];
}

export interface LedgerLineError {
  /** 1-based line number in ledger.jsonl. */
  line: number;
  message: string;
}

export interface Wiki {
  root: string;
  /** Pages that parsed, by canonical id. */
  pages: Map<string, WikiPage>;
  /** Every text file (`.md`, `.jsonl`) by wiki-relative posix path, including non-page files. */
  files: Map<string, string>;
  /** Every file of any kind, so relative links to images or other assets resolve (LR-03). */
  paths: Set<string>;
  index?: string;
  log?: string;
  skillImpact?: string;
  ledger: LedgerEvent[];
  ledgerErrors: LedgerLineError[];
  pageErrors: PageError[];
}

export const INDEX_FILE = 'index.md';
export const LOG_FILE = 'log.md';
export const LEDGER_FILE = 'ledger.jsonl';
export const SKILL_IMPACT_FILE = 'skill-impact.md';

const TEXT_FILE = /\.(md|jsonl)$/;

/** Reads every file under `root` (dot-directories and node_modules skipped) and builds the wiki. */
export function loadWiki(root: string): Wiki {
  const files = new Map<string, string>();
  const paths = new Set<string>();
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join('/');
    paths.add(rel);
    if (TEXT_FILE.test(rel)) files.set(rel, readFileSync(abs, 'utf8'));
  }
  return wikiFromFiles(root, files, paths);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (entry.isFile()) yield abs;
  }
}

/** Builds a wiki from in-memory files, so a changeset can be linted before it is written. */
export function wikiFromFiles(
  root: string,
  files: ReadonlyMap<string, string>,
  paths: Iterable<string> = files.keys(),
): Wiki {
  const pages = new Map<string, WikiPage>();
  const pageErrors: PageError[] = [];
  // Sorted so that which of two duplicate paths "wins" never depends on directory order.
  for (const [rel, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const id = pathToId(rel);
    if (id === undefined) continue;
    let parsed: ParsedPage;
    try {
      parsed = parsePage(rel, text);
    } catch (err) {
      if (!(err instanceof PageParseError)) throw err;
      pageErrors.push({ path: rel, kind: 'parse', issues: err.issues });
      continue;
    }
    const existing = pages.get(id);
    if (existing) {
      pageErrors.push({
        path: rel,
        kind: 'duplicate',
        issues: [{ path: '', message: `page id "${id}" is also used by ${existing.path}` }],
      });
      continue;
    }
    const archived = isArchivedPath(rel) || parsed.frontmatter.status === 'archived';
    pages.set(id, { ...parsed, id, archived });
  }
  const { events, errors } = parseLedger(files.get(LEDGER_FILE) ?? '');
  return {
    root,
    pages,
    files: new Map(files),
    paths: new Set(paths),
    index: files.get(INDEX_FILE),
    log: files.get(LOG_FILE),
    skillImpact: files.get(SKILL_IMPACT_FILE),
    ledger: events,
    ledgerErrors: errors,
    pageErrors,
  };
}

/** Parses ledger.jsonl: one `LedgerEvent` per non-blank line, in file (append) order. */
export function parseLedger(text: string): { events: LedgerEvent[]; errors: LedgerLineError[] } {
  const events: LedgerEvent[] = [];
  const errors: LedgerLineError[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const problem = (message: string) => errors.push({ line: i + 1, message });
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      problem('not valid JSON');
      return;
    }
    // Checked before the schema so the message names the rule, not a zod literal mismatch.
    if ((json as { writer?: unknown } | null)?.writer !== 'harness') {
      problem('writer must be "harness": only the harness writes the ledger');
      return;
    }
    const result = LedgerEventSchema.safeParse(json);
    if (result.success) events.push(result.data);
    else problem(result.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
  });
  return { events, errors };
}

/** Applies a changeset's writes to an in-memory copy of `wiki` (the scratch copy of 06 §2.3). */
export function withWrites(wiki: Wiki, writes: readonly { path: string; content: string }[]): Wiki {
  const files = new Map(wiki.files);
  const paths = new Set(wiki.paths);
  for (const w of writes) {
    files.set(w.path, w.content);
    paths.add(w.path);
  }
  return wikiFromFiles(wiki.root, files, paths);
}
