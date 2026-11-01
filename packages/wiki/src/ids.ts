import { posix } from 'node:path';

/**
 * Page id ↔ path mapping (vision 04 §2.1, §2.2). A page's canonical id is singular
 * (`pattern/x`, as the seed frontmatter and every reference write it), while its file lives under a
 * plural folder (`patterns/x.md`). Lint accepts both spellings, so everything that compares ids
 * goes through `normalizeId` first.
 */

/** Root folders that hold pages, and the singular type each one names. */
const FOLDER_TYPE: Readonly<Record<string, string>> = {
  patterns: 'pattern',
  facts: 'fact',
  decisions: 'decision',
  incidents: 'incident',
  contract: 'contract',
};
const TYPE_FOLDER: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FOLDER_TYPE).map(([folder, type]) => [type, folder]),
);

/** Fixed per-tool pages in a project wiki: `tools/<name>/<file>.md` → `<type>/<name>`. */
const TOOL_FILE_TYPE: Readonly<Record<string, string>> = {
  intent: 'intent',
  liveness: 'liveness',
  decisions: 'tool-decisions',
};
const TOOL_TYPE_FILE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TOOL_FILE_TYPE).map(([file, type]) => [type, file]),
);

export const ARCHIVE_DIR = 'archive';

/** True when a wiki-relative path sits under `archive/` (04 §4: archived pages keep their path). */
export const isArchivedPath = (relPath: string): boolean => relPath.startsWith(`${ARCHIVE_DIR}/`);

/**
 * The canonical id of the page stored at `relPath` (posix, relative to the wiki root), or
 * `undefined` when the file is not a page (index.md, log.md, proposals/, …). An archived page keeps
 * the id of its original path.
 */
export function pathToId(relPath: string): string | undefined {
  if (!relPath.endsWith('.md')) return undefined;
  const stem = relPath.slice(0, -'.md'.length);
  if (isArchivedPath(stem)) return pathToId(relPath.slice(ARCHIVE_DIR.length + 1));
  const parts = stem.split('/');
  const [head, name, file, slug] = parts;
  if (head === 'tools' && name) {
    const toolType = file === undefined ? undefined : TOOL_FILE_TYPE[file];
    if (parts.length === 3 && toolType) return `${toolType}/${name}`;
    // Tool-scoped incidents carry the tool in the id so they cannot collide with root incidents.
    if (parts.length === 4 && file === 'incidents' && slug) return `incident/${name}/${slug}`;
    return undefined;
  }
  const type = head === undefined ? undefined : FOLDER_TYPE[head];
  if (!type || parts.length < 2) return undefined;
  return [type, ...parts.slice(1)].join('/');
}

/** The wiki-relative path of the page with canonical `id` (inverse of `pathToId`). */
export function idToPath(id: string, opts: { archived?: boolean } = {}): string {
  const canonical = normalizeId(id);
  const [type = '', ...rest] = canonical.split('/');
  const toolFile = TOOL_TYPE_FILE[type];
  let path: string;
  if (toolFile && rest.length === 1) path = `tools/${rest[0]}/${toolFile}.md`;
  else if (type === 'incident' && rest.length === 2)
    path = `tools/${rest[0]}/incidents/${rest[1]}.md`;
  else {
    const folder = TYPE_FOLDER[type];
    if (!folder || rest.length === 0) throw new Error(`"${id}" is not a page id`);
    path = `${folder}/${rest.join('/')}.md`;
  }
  return opts.archived ? `${ARCHIVE_DIR}/${path}` : path;
}

/**
 * Normalizes any way of naming a page to its canonical id: `patterns/x`, `pattern/x`,
 * `wiki/patterns/x.md`, `tools/blog/intent.md` and `fact/x#anchor` (a quota anchor) all reduce to
 * the id alone. Strings that are not page-shaped come back trimmed but otherwise unchanged.
 */
export function normalizeId(ref: string): string {
  const bare = ref
    .trim()
    .replace(/#.*$/, '')
    .replace(/^\.\//, '')
    .replace(/^wiki\//, '')
    .replace(/\.md$/, '');
  return pathToId(`${bare}.md`) ?? bare;
}

/** Resolves a reference to a page of `wiki`, through `normalizeId`. */
export function resolveId<P>(wiki: { pages: ReadonlyMap<string, P> }, ref: string): P | undefined {
  return wiki.pages.get(normalizeId(ref));
}

/** Resolves a relative link written in the page at `fromPath`, to a wiki-relative path. Returns
 * a path starting with `../` when the link leaves the wiki. */
export function resolveLink(fromPath: string, target: string): string {
  const withoutFragment = target.replace(/#.*$/, '');
  return posix.normalize(posix.join(posix.dirname(fromPath), withoutFragment));
}
