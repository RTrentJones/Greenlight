import { idToPath, normalizeId } from './ids';
import type { Wiki, WikiPage } from './load';
import type { Page } from './schema';

/**
 * `wiki lookup` and `wiki context` (vision 07 §3.6, §3.6a; 04 §6). Both are pure reads over one or
 * two loaded wikis: the project's own and the framework wiki the installed CLI carries. Neither
 * ever returns an incident page (ADR-10), and a `hypothesis` page is returned only on request.
 */

export type WikiOrigin = 'project' | 'framework';

export interface LookupSource {
  wiki: Wiki;
  origin: WikiOrigin;
}

export interface LookupQuery {
  /** Failing check ids or names; each is tested against a page's `catches.checkSignature`. */
  checks?: readonly string[];
  class?: string;
  /** The tool's `lane/target/data` cell. */
  cell?: string;
  /** Installed framework version (`0.11.0`), for `affects`. Unknown means nothing is dropped. */
  installed?: string;
  includeHypothesis?: boolean;
  /** Return every page the cell and version rules keep, scored or not (the on-start form). */
  all?: boolean;
  limit?: number;
}

export interface LookupHit {
  id: string;
  title: string;
  score: number;
  /** Wiki-relative path of the page. */
  path: string;
  origin: WikiOrigin;
  status: 'confirmed' | 'hypothesis';
  /** The page's `## Fix / workaround` section, without its heading. */
  fix: string;
  /** What the installed version means for this lesson (04 §6), when it means anything. */
  note?: string;
  /** Set when the matching page was superseded and this one replaced it. */
  replaces?: string;
}

type PatternPage = WikiPage & { frontmatter: Extract<Page, { type: 'pattern' }> };

const isPattern = (p: WikiPage): p is PatternPage => p.frontmatter.type === 'pattern';

// ---- version ranges ----------------------------------------------------------------------------

const parseVersion = (v: string): [number, number, number] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

const compare = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * Whether `version` lies in `range`: `*`, or comparators (`<0.10.1`, `>=0.8.0 <0.10.0`, a bare
 * version for equality) joined by spaces for "and" and `||` for "or". A range or version that
 * cannot be read counts as covering the version, so a malformed page is shown rather than hidden.
 */
export function versionInRange(version: string | undefined, range: string | undefined): boolean {
  if (range === undefined || version === undefined) return true;
  const v = parseVersion(version);
  if (!v) return true;
  return range.split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return true;
    return parts.every((part) => {
      if (part === '*') return true;
      const m = /^(<=|>=|<|>|=)?(.+)$/.exec(part);
      const bound = m?.[2] === undefined ? undefined : parseVersion(m[2]);
      if (!bound) return true;
      const c = compare(v, bound);
      switch (m?.[1] ?? '=') {
        case '<':
          return c < 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '>=':
          return c >= 0;
        default:
          return c === 0;
      }
    });
  });
}

/** 04 §6: whether a lesson is surfaced on the installed version, and what to say beside it. */
function applicability(
  page: PatternPage,
  installed: string | undefined,
): { keep: boolean; note?: string } {
  const { relevance, affects } = page.frontmatter;
  if (relevance === 'app-code') return { keep: true };
  const universal = affects === undefined || affects.trim() === '*';
  const affected = versionInRange(installed, affects);
  if (relevance === 'framework-version') {
    if (!affected) return { keep: false };
    return universal || installed === undefined
      ? { keep: true }
      : { keep: true, note: `upgrade fixes this (affects ${affects})` };
  }
  if (!affected) return { keep: true, note: 'the app-code half only; the framework half is fixed' };
  return universal || installed === undefined
    ? { keep: true }
    : { keep: true, note: `upgrade fixes the framework half (affects ${affects})` };
}

// ---- matching ----------------------------------------------------------------------------------

/** Segment-wise glob: `*` on either side matches any one segment. */
export function cellMatches(pattern: string, cell: string): boolean {
  const a = pattern.split('/');
  const b = cell.split('/');
  if (a.length !== 3 || b.length !== 3) return false;
  return a.every((seg, i) => seg === '*' || b[i] === '*' || seg === b[i]);
}

function signatureMatches(signature: string | undefined, check: string): boolean {
  if (!signature) return false;
  try {
    return new RegExp(signature).test(check);
  } catch {
    // An unreadable signature is a lint finding; here it falls back to a literal comparison.
    return signature === check;
  }
}

/** The body of a `## <heading>` section, up to the next `## ` heading. */
export function sectionOf(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

function score(page: PatternPage, q: LookupQuery): number {
  const fm = page.frontmatter;
  let s = 0;
  for (const check of q.checks ?? []) {
    if (signatureMatches(fm.catches?.checkSignature, check)) s += 3;
  }
  if (q.class && fm.class === q.class) s += 2;
  if (q.cell && fm.cells.some((c) => cellMatches(c, q.cell as string))) s += 1;
  return s;
}

/** Follows `supersededBy` to a live pattern, or returns nothing when the chain breaks or loops. */
function replacement(page: PatternPage, wiki: Wiki): PatternPage | undefined {
  const seen = new Set<string>([page.id]);
  let at: PatternPage = page;
  while (at.frontmatter.status === 'superseded') {
    const next = at.frontmatter.supersededBy
      ? wiki.pages.get(normalizeId(at.frontmatter.supersededBy))
      : undefined;
    if (!next || !isPattern(next) || seen.has(next.id)) return undefined;
    seen.add(next.id);
    at = next;
  }
  return at;
}

/**
 * Selection of 07 §3.6. The project wiki is read first, so a project page shadows a framework page
 * with the same id. A page with no `--cell` match is still returned when a check or class matched;
 * with `all`, every applicable page whose cells match is returned (or every page, with no cell).
 */
export function lookupPatterns(sources: readonly LookupSource[], q: LookupQuery = {}): LookupHit[] {
  const hits = new Map<string, LookupHit & { updated: string }>();
  const shadowed = new Set<string>();
  for (const { wiki, origin } of sources) {
    const local = new Set<string>();
    for (const page of wiki.pages.values()) {
      if (!isPattern(page) || page.archived) continue;
      local.add(page.id);
      if (shadowed.has(page.id)) continue;
      const s = score(page, q);
      const cellOk = !q.cell || page.frontmatter.cells.some((c) => cellMatches(c, q.cell ?? ''));
      if (q.all ? !cellOk : s === 0) continue;

      let target: PatternPage | undefined = page;
      let replaces: string | undefined;
      if (page.frontmatter.status === 'superseded') {
        target = replacement(page, wiki);
        replaces = page.id;
      }
      if (!target || target.archived) continue;
      const status = target.frontmatter.status;
      if (status !== 'confirmed' && !(status === 'hypothesis' && q.includeHypothesis)) continue;
      const { keep, note } = applicability(target, q.installed);
      if (!keep) continue;

      const prior = hits.get(target.id);
      if (prior && prior.score >= s) continue;
      hits.set(target.id, {
        id: target.id,
        title: target.frontmatter.title,
        score: s,
        path: idToPath(target.id),
        origin,
        status,
        fix: sectionOf(target.body, 'Fix / workaround'),
        ...(note ? { note } : {}),
        ...(replaces && replaces !== target.id ? { replaces } : {}),
        updated: target.frontmatter.updated,
      });
    }
    for (const id of local) shadowed.add(id);
  }
  return [...hits.values()]
    .sort(
      (a, b) => b.score - a.score || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id),
    )
    .slice(0, q.limit ?? 5)
    .map(({ updated: _updated, ...hit }) => hit);
}

/** The pattern ids a failing run should link (FR-LOOP-02): confirmed pages only, check matches only. */
export function failureLinks(
  sources: readonly LookupSource[],
  failing: readonly string[],
  q: Pick<LookupQuery, 'installed'> = {},
): LookupHit[] {
  if (failing.length === 0) return [];
  return lookupPatterns(sources, { ...q, checks: failing });
}

// ---- context -----------------------------------------------------------------------------------

export const DECISIONS_HEAD_LINES = 40;

export interface ToolStartContext {
  tool: string;
  /** `intent.md` and `liveness.md` in full, and the head of `decisions.md`; absent when unwritten. */
  intent?: string;
  liveness?: string;
  decisions?: string;
  /** One line from the liveness page: its model and what is at risk. */
  livenessSummary?: string;
  /** Applicable confirmed patterns for the tool's cell, as index entries. */
  patterns: Pick<LookupHit, 'id' | 'title' | 'origin' | 'note'>[];
  hasPages: boolean;
}

/** One line that says how a tool stays alive, from its liveness page. */
export function livenessSummary(wiki: Wiki | undefined, tool: string): string | undefined {
  const page = wiki?.pages.get(`liveness/${tool}`);
  if (!page || page.frontmatter.type !== 'liveness') return undefined;
  const { model, atRisk, probe } = page.frontmatter;
  return `liveness: ${model} — at risk: ${atRisk}${probe ? ` — probe: ${probe}` : ''}`;
}

/** The on-start bundle (07 §3.6a) without the parts only the CLI knows (manifest, alerts). */
export function toolContext(
  project: Wiki | undefined,
  framework: Wiki | undefined,
  tool: string,
  q: Pick<LookupQuery, 'cell' | 'installed'> = {},
): ToolStartContext {
  const raw = (file: string) => project?.files.get(`tools/${tool}/${file}.md`);
  const intent = raw('intent');
  const liveness = raw('liveness');
  const decisionsFull = raw('decisions');
  const decisions = decisionsFull?.split('\n').slice(0, DECISIONS_HEAD_LINES).join('\n');
  const sources: LookupSource[] = [
    ...(project ? [{ wiki: project, origin: 'project' as const }] : []),
    ...(framework && framework !== project
      ? [{ wiki: framework, origin: 'framework' as const }]
      : []),
  ];
  const patterns = lookupPatterns(sources, { ...q, all: true, limit: 50 }).map(
    ({ id, title, origin, note }) => ({ id, title, origin, ...(note ? { note } : {}) }),
  );
  const summary = livenessSummary(project, tool);
  return {
    tool,
    ...(intent !== undefined ? { intent } : {}),
    ...(liveness !== undefined ? { liveness } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
    ...(summary ? { livenessSummary: summary } : {}),
    patterns,
    hasPages: intent !== undefined || liveness !== undefined || decisionsFull !== undefined,
  };
}
