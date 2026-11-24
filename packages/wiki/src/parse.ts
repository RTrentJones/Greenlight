import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { type Page, PageSchema } from './schema';
import { canonicalJson } from './schema/common';

/**
 * Page parsing (vision 03 §3 `parse.ts`). A page is `---\n<yaml>---\n<body>`. The body is kept
 * byte-for-byte, and so is the frontmatter block while its values are unchanged, so that
 * `serializePage(parsePage(p, t)) === t` and maintainer patch targets stay stable across a
 * load/save cycle.
 */

export interface ParsedPage {
  /** Wiki-relative path the page was read from; named in every error. */
  path: string;
  frontmatter: Page;
  /** The exact frontmatter block, both `---` delimiters included. */
  frontmatterBlock: string;
  /** Everything after the closing delimiter, unchanged. */
  body: string;
  /** The full original text. */
  raw: string;
}

export interface PageIssue {
  /** JSON path into the frontmatter (`remediation.0.verified`), or `''` for the page as a whole. */
  path: string;
  message: string;
  /** The lint rule the schema tagged this issue with (zod custom `params.rule`), if any. */
  rule?: string;
}

export class PageParseError extends Error {
  constructor(
    readonly file: string,
    readonly issues: readonly PageIssue[],
  ) {
    super(
      `${file}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`,
    );
    this.name = 'PageParseError';
  }
}

// The closing delimiter may end the file without a newline; CRLF files are accepted as written.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

/** Splits a page into its frontmatter block, the YAML inside it, and the body. */
export function splitFrontmatter(
  file: string,
  text: string,
): { block: string; yaml: string; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m || m.index !== 0) {
    throw new PageParseError(file, [
      { path: '', message: 'page must start with a "---" YAML frontmatter block closed by "---"' },
    ]);
  }
  const block = m[0];
  return { block, yaml: m[1] ?? '', body: text.slice(block.length) };
}

/** Parses YAML with duplicate keys refused: a repeated key would silently drop one value. */
function readYaml(file: string, yaml: string): unknown {
  try {
    return parseYaml(yaml, { uniqueKeys: true, prettyErrors: true });
  } catch (err) {
    throw new PageParseError(file, [
      { path: '', message: `frontmatter is not valid YAML: ${(err as Error).message}` },
    ]);
  }
}

/** Parses and validates one page against `PageSchema` (LR-01). Throws `PageParseError`. */
export function parsePage(path: string, text: string): ParsedPage {
  const { block, yaml, body } = splitFrontmatter(path, text);
  const data = readYaml(path, yaml);
  const result = PageSchema.safeParse(data ?? {});
  if (!result.success) {
    throw new PageParseError(
      path,
      result.error.issues.map((i) => {
        const rule =
          i.code === 'custom' ? (i.params as { rule?: unknown } | undefined)?.rule : undefined;
        return {
          path: i.path.join('.'),
          message: i.message,
          ...(typeof rule === 'string' ? { rule } : {}),
        };
      }),
    );
  }
  return { path, frontmatter: result.data, frontmatterBlock: block, body, raw: text };
}

/**
 * Serializes a page. The original frontmatter block is reused while it still says the same thing
 * as `frontmatter` (comments and formatting survive); otherwise the frontmatter is re-emitted.
 */
export function serializePage(
  page: Pick<ParsedPage, 'frontmatter' | 'body'> & { frontmatterBlock?: string },
): string {
  if (page.frontmatterBlock !== undefined && blockSays(page.frontmatterBlock, page.frontmatter)) {
    return page.frontmatterBlock + page.body;
  }
  return `---\n${stringifyYaml(page.frontmatter)}---\n${page.body}`;
}

function blockSays(block: string, frontmatter: Page): boolean {
  try {
    const { yaml } = splitFrontmatter('', block);
    return canonicalJson(parseYaml(yaml)) === canonicalJson(frontmatter);
  } catch {
    return false;
  }
}
