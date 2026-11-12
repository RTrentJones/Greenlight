import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EVIDENCE_REF_RE } from '@rtrentjones/greenlight-shared';
import { isArchivedPath, normalizeId, pathToId, resolveId, resolveLink } from './ids';
import { generateIndex, indexedPages, parseIndex, reconcileIndex } from './index-gen';
import { ledgerProblems, renderSkillImpact } from './ledger';
import {
  INDEX_FILE,
  LEDGER_FILE,
  SKILL_IMPACT_FILE,
  type Wiki,
  type WikiPage,
  withWrites,
} from './load';
import type { PageIssue } from './parse';
import { findSecrets } from './redact';

/** Structurally `Changeset` from patch.ts, declared here because patch.ts imports lint (06 §2.4). */
type Changeset = { writes: { path: string; content: string }[] };

/**
 * Wiki lint (vision 04 §5). This milestone implements the offline structural rules LR-01, LR-02,
 * LR-03, LR-05, LR-06, LR-08, LR-11, LR-12, LR-14, LR-19 and LR-20; the rest land in M3. Every
 * rule here is an error, so `strict` changes the exit code only once warning rules exist — the
 * semantics are wired now so callers do not change later.
 */

export const RULES = {
  'LR-01': 'error',
  'LR-02': 'error',
  'LR-03': 'error',
  'LR-05': 'error',
  'LR-06': 'error',
  'LR-08': 'error',
  'LR-11': 'error',
  'LR-12': 'error',
  'LR-14': 'error',
  'LR-19': 'error',
  'LR-20': 'error',
} as const;

export type RuleId = keyof typeof RULES;
export type Severity = 'error' | 'warning';

/** One finding, in the shape `wiki lint --json` prints (07 §3.4). */
export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** Wiki-relative file the finding is about (a skill's PURPOSE.md for LR-11/LR-12). */
  page: string;
  message: string;
}

/** A managed skill as lint needs it; `skills.ts` (later) builds these from disk. */
export interface LintSkill {
  name: string;
  /** `version` from SKILL.md frontmatter. */
  version?: string;
  purpose?: {
    /** Where PURPOSE.md lives, for findings; defaults to `<name>/PURPOSE.md`. */
    path?: string;
    version?: string;
    cites: readonly { id: string }[];
  };
}

/** Personal values the framework wiki must not name (LR-19). Supplied from the manifest, because
 * framework code itself may not contain them (rule 15.2.1). */
export interface SeamTerms {
  domains?: readonly string[];
  emails?: readonly string[];
  toolNames?: readonly string[];
}

export interface LintContext {
  /** LR-19 applies only to the framework wiki. */
  kind: 'framework' | 'project';
  skills?: readonly LintSkill[];
  seam?: SeamTerms;
  /** Known secret values, matched literally by LR-20 in addition to secret shapes. */
  secretValues?: readonly string[];
}

type Draft = Omit<Finding, 'severity'>;
type Rule = (wiki: Wiki, ctx: LintContext) => Draft[];

// ---- LR-01 / LR-03 / LR-05 / LR-06 from parse failures -------------------------------------

/** Rules the page schema enforces itself; it tags those issues with zod `params: { rule }`. */
const SCHEMA_RULES: ReadonlySet<string> = new Set<RuleId>(['LR-03', 'LR-05', 'LR-06']);

/** The page schema enforces some rules' conditions itself and tags each such issue with the rule
 * (`schema/pages.ts`); those are reported under that rule, everything else as LR-01. */
function ruleOfIssue(issue: PageIssue): RuleId {
  return issue.rule !== undefined && SCHEMA_RULES.has(issue.rule)
    ? (issue.rule as RuleId)
    : 'LR-01';
}

const issueText = (i: PageIssue): string => (i.path ? `${i.path}: ${i.message}` : i.message);

const parseFailures: Rule = (wiki) => {
  const out: Draft[] = [];
  for (const err of wiki.pageErrors.filter((e) => e.kind === 'parse')) {
    const byRule = new Map<RuleId, string[]>();
    for (const issue of err.issues) {
      const rule = ruleOfIssue(issue);
      byRule.set(rule, [...(byRule.get(rule) ?? []), issueText(issue)]);
    }
    for (const [rule, messages] of byRule) {
      out.push({ rule, page: err.path, message: messages.join('; ') });
    }
  }
  return out;
};

// ---- LR-02 ------------------------------------------------------------------------------------

const idMatchesPath: Rule = (wiki) => [
  ...[...wiki.pages.values()]
    .filter((p) => normalizeId(p.frontmatter.id) !== p.id)
    .map((p) => ({
      rule: 'LR-02' as const,
      page: p.path,
      message: `id "${p.frontmatter.id}" does not match the path; expected "${p.id}"`,
    })),
  ...wiki.pageErrors
    .filter((e) => e.kind === 'duplicate')
    .map((e) => ({
      rule: 'LR-02' as const,
      page: e.path,
      message: e.issues.map(issueText).join('; '),
    })),
];

// ---- LR-03 ------------------------------------------------------------------------------------

/** Removes fenced and inline code, where a bracketed string is an example, not a link. */
const stripCode = (body: string): string =>
  body.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Absolute URLs, site-absolute paths and same-page anchors are not relative links.
const NOT_RELATIVE = /^([a-z][a-z0-9+.-]*:|\/|#)/i;

function decode(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

const linksResolve: Rule = (wiki) => {
  const out: Draft[] = [];
  for (const page of wiki.pages.values()) {
    for (const m of stripCode(page.body).matchAll(LINK_RE)) {
      const target = m[1] ?? '';
      if (NOT_RELATIVE.test(target)) continue;
      const rel = resolveLink(page.path, decode(target));
      const exists = rel.startsWith('../')
        ? existsSync(join(wiki.root, rel))
        : wiki.paths.has(rel) || [...wiki.paths].some((p) => p.startsWith(`${rel}/`));
      if (!exists) {
        out.push({ rule: 'LR-03', page: page.path, message: `link "${target}" does not resolve` });
      }
    }
  }
  return out;
};

// ---- LR-06 ------------------------------------------------------------------------------------

const supersededResolves: Rule = (wiki) => {
  const out: Draft[] = [];
  for (const page of wiki.pages.values()) {
    const by = page.frontmatter.supersededBy;
    if (page.frontmatter.status !== 'superseded' || by === undefined) continue;
    const target = resolveId(wiki, by);
    const why = !target ? 'does not exist' : target.archived ? 'is archived' : undefined;
    if (why) out.push({ rule: 'LR-06', page: page.path, message: `supersededBy "${by}" ${why}` });
  }
  return out;
};

// ---- LR-08 ------------------------------------------------------------------------------------

/** Paths the index must list: parsed non-archived pages, plus page files that failed to parse
 * (LR-01 reports those; their absence from the index would only be noise). */
function expectedIndexTargets(wiki: Wiki): Set<string> {
  const broken = wiki.pageErrors.map((e) => e.path).filter((p) => !isArchivedPath(p));
  return new Set([...indexedPages(wiki).map((p) => p.path), ...broken]);
}

const indexMatchesPages: Rule = (wiki) => {
  if (wiki.index === undefined) {
    return [{ rule: 'LR-08', page: INDEX_FILE, message: 'index.md is missing' }];
  }
  const expected = expectedIndexTargets(wiki);
  const listed = new Set(parseIndex(wiki.index).map((e) => e.target));
  const pageFiles = new Set([...wiki.files.keys()].filter((p) => pathToId(p) !== undefined));
  const out: Draft[] = [];
  for (const t of expected) {
    if (!listed.has(t)) out.push({ rule: 'LR-08', page: t, message: 'page is not in index.md' });
  }
  for (const t of listed) {
    if (expected.has(t)) continue;
    const why = pageFiles.has(t) ? 'points to an archived page' : 'points to no page';
    out.push({ rule: 'LR-08', page: INDEX_FILE, message: `index line for "${t}" ${why}` });
  }
  return out;
};

// ---- LR-11 / LR-12 ----------------------------------------------------------------------------

const purposePath = (s: LintSkill): string => s.purpose?.path ?? `${s.name}/PURPOSE.md`;

/** Why a cited page cannot justify a skill rule, or undefined when it can. */
function citeProblem(page: WikiPage | undefined, skill: string): string | undefined {
  if (!page) return 'does not exist';
  const fm = page.frontmatter;
  if (fm.type !== 'pattern' && fm.type !== 'decision' && fm.type !== 'contract') {
    return `is a ${fm.type} page; only pattern, decision and contract pages may be cited`;
  }
  if (fm.type === 'pattern' && fm.status !== 'confirmed') return `is ${fm.status}, not confirmed`;
  if (page.archived) return 'is archived';
  if (!fm.skills.includes(skill)) return `does not list "${skill}" in its skills (back-link)`;
  return undefined;
}

const citesHold: Rule = (wiki, ctx) =>
  (ctx.skills ?? []).flatMap((skill) =>
    (skill.purpose?.cites ?? []).flatMap((cite) => {
      const why = citeProblem(resolveId(wiki, cite.id), skill.name);
      return why
        ? [
            {
              rule: 'LR-11' as const,
              page: purposePath(skill),
              message: `cites "${cite.id}", which ${why}`,
            },
          ]
        : [];
    }),
  );

const versionsAgree: Rule = (_wiki, ctx) =>
  (ctx.skills ?? [])
    .filter((s) => s.purpose && s.purpose.version !== s.version)
    .map((s) => ({
      rule: 'LR-12' as const,
      page: purposePath(s),
      message: `PURPOSE.md version "${s.purpose?.version ?? ''}" differs from SKILL.md version "${s.version ?? ''}"`,
    }));

// ---- LR-14 ------------------------------------------------------------------------------------

const ledgerHolds: Rule = (wiki) => {
  const out: Draft[] = wiki.ledgerErrors.map((e) => ({
    rule: 'LR-14' as const,
    page: LEDGER_FILE,
    message: `line ${e.line}: ${e.message}`,
  }));
  // Duplicate eventIds and stage-machine violations (06 §6.1) in the lines that did parse.
  for (const problem of ledgerProblems(wiki.ledger)) {
    out.push({ rule: 'LR-14', page: LEDGER_FILE, message: problem });
  }
  const hasLedger = wiki.files.has(LEDGER_FILE);
  if (!hasLedger && wiki.skillImpact === undefined) return out;
  if (wiki.skillImpact !== renderSkillImpact(wiki.ledger)) {
    const what = wiki.skillImpact === undefined ? 'is missing' : 'does not match the ledger render';
    out.push({ rule: 'LR-14', page: SKILL_IMPACT_FILE, message: `skill-impact.md ${what}` });
  }
  return out;
};

// ---- LR-19 ------------------------------------------------------------------------------------

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function seamPatterns(terms: SeamTerms): { re: RegExp; label: string }[] {
  const literal = (label: string) => (v: string) => ({
    re: new RegExp(escapeRegExp(v), 'i'),
    label: `${label} "${v}"`,
  });
  return [
    ...(terms.domains ?? []).map(literal("the owner's domain")),
    ...(terms.emails ?? []).map(literal("the owner's email")),
    // A whole token, where "-", "_" and "." delimit as well as spaces: a tool called "muse" does
    // not flag "museum", but "polyphony-api" and "env-polyphony" still name "polyphony".
    ...(terms.toolNames ?? []).map((v) => ({
      re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(v)}(?![A-Za-z0-9])`, 'i'),
      label: `the owner's tool "${v}"`,
    })),
  ];
}

/** A bench task id (`replay/<slug>`, `loop/<slug>`, … — the kind prefixes of 08 §10.1). */
const BENCH_TASK_ID_RE = /^(?:cap|replay|loop|wiki|route|port|mech)\/[a-z0-9][a-z0-9-]*$/;

/** A file in a repository, `<owner>/<repo>:<path>` (a `verify` remediation pointing at the spec
 * that enforces it): a repository reference, so it may name the owner's repo like evidence does. */
const REPO_FILE_REF_RE = /^[\w.-]+\/[\w.-]+:[\w./-]+$/;

const isRepoRef = (v: string): boolean => EVIDENCE_REF_RE.test(v) || REPO_FILE_REF_RE.test(v);

/** Frontmatter fields that may name the owner's repositories, so evidence stays traceable (LR-19
 * exception, 04 §5 and 15 §1.8). Paths are matched with array indices removed. `evidence` fields
 * are schema-checked `EvidenceRef`s; the other fields are free strings, so they are exempt only
 * while their value has the shape that justifies the exemption (an evidence ref or repository
 * file ref, or a bench task id) — a prose `ref` naming the owner's tool is still a seam leak. */
const EVIDENCE_FIELDS: ReadonlyMap<string, (v: string) => boolean> = new Map([
  ['evidence', () => true],
  ['timeline.evidence', () => true],
  ['remediation.ref', isRepoRef],
  ['enforcedBy.ref', isRepoRef],
  ['catches.graderTask', (v: string) => BENCH_TASK_ID_RE.test(v)],
]);

const exempt = (field: string, text: string): boolean =>
  EVIDENCE_FIELDS.get(field)?.(text) ?? false;

/** Every string value in `value` with its dotted field path (array indices dropped). */
function* strings(value: unknown, path: string[] = []): Generator<{ field: string; text: string }> {
  if (typeof value === 'string') yield { field: path.join('.'), text: value };
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, path);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, [...path, k]);
  }
}

const seamHolds: Rule = (wiki, ctx) => {
  if (ctx.kind !== 'framework' || !ctx.seam) return [];
  const patterns = seamPatterns(ctx.seam);
  const out: Draft[] = [];
  for (const page of wiki.pages.values()) {
    const texts = [
      ...[...strings(page.frontmatter)].filter((s) => !exempt(s.field, s.text)),
      { field: 'body', text: page.body },
    ];
    for (const { field, text } of texts) {
      for (const { re, label } of patterns) {
        if (re.test(text))
          out.push({ rule: 'LR-19', page: page.path, message: `${field} names ${label}` });
      }
    }
  }
  return out;
};

// ---- LR-20 ------------------------------------------------------------------------------------

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const noSecrets: Rule = (wiki, ctx) => {
  const out: Draft[] = [];
  for (const [path, text] of wiki.files) {
    for (const f of findSecrets(text, ctx.secretValues)) {
      // The finding names the kind and line only: echoing the value would leak it into CI logs.
      out.push({
        rule: 'LR-20',
        page: path,
        message: `line ${lineOf(text, f.index)}: ${f.kind}-shaped secret`,
      });
    }
  }
  return out;
};

// ---- driver -----------------------------------------------------------------------------------

const ALL_RULES: readonly Rule[] = [
  parseFailures,
  idMatchesPath,
  linksResolve,
  supersededResolves,
  indexMatchesPages,
  citesHold,
  versionsAgree,
  ledgerHolds,
  seamHolds,
  noSecrets,
];

/** LR-19 and LR-20 only: the checks a maintainer output must pass on the scratch wiki before
 * anything is written (06 §2.4). */
export function lintScratch(wiki: Wiki, ctx: LintContext): Finding[] {
  return [seamHolds, noSecrets]
    .flatMap((rule) => rule(wiki, ctx))
    .map((d) => ({ ...d, severity: RULES[d.rule] }));
}

/** Runs every implemented rule; findings sorted by file, then rule. */
export function lint(wiki: Wiki, ctx: LintContext): Finding[] {
  return ALL_RULES.flatMap((rule) => rule(wiki, ctx))
    .map((d) => ({ ...d, severity: RULES[d.rule] }))
    .sort((a, b) => a.page.localeCompare(b.page) || a.rule.localeCompare(b.rule));
}

/**
 * The error findings `after` has beyond `before`, counted as a multiset by rule, page and message:
 * a finding has no location, so an identical new error on a page that already had one is still
 * introduced (its count went up), never masked by the pre-existing one.
 */
export function introducedErrors(before: readonly Finding[], after: readonly Finding[]): Finding[] {
  const key = (f: Finding) => `${f.rule}\0${f.page}\0${f.message}`;
  const budget = new Map<string, number>();
  for (const f of before) {
    if (f.severity === 'error') budget.set(key(f), (budget.get(key(f)) ?? 0) + 1);
  }
  return after.filter((f) => {
    if (f.severity !== 'error') return false;
    const left = budget.get(key(f)) ?? 0;
    if (left > 0) {
      budget.set(key(f), left - 1);
      return false;
    }
    return true;
  });
}

/** `wiki lint`'s exit code (07 §0): 1 on any error, and on any warning under `--strict`. */
export function lintExitCode(findings: readonly Finding[], opts: { strict?: boolean } = {}): 0 | 1 {
  const fails = (f: Finding) =>
    f.severity === 'error' || (opts.strict === true && f.severity === 'warning');
  return findings.some(fails) ? 1 : 0;
}

// ---- --fix ------------------------------------------------------------------------------------

/** Rewrites the frontmatter `id` line of a page to its path-derived id (LR-02). */
function fixId(page: WikiPage): string {
  const block = page.frontmatterBlock.replace(/^id:[^\n]*$/m, `id: ${page.id}`);
  return block + page.body;
}

/**
 * The automatic fixes 04 §5 marks for these rules: LR-02 (id from path), LR-08 (regenerate the
 * index) and LR-14 (re-render skill-impact.md). Returns only writes that change a file, so a
 * second run is empty. The index is regenerated only when every page parses — a broken page has
 * no title or summary, and regenerating would drop it from the index — and skill-impact.md only
 * when every ledger line validates, so a render never papers over a bad line.
 */
export function fix(wiki: Wiki): Changeset {
  const writes: Changeset['writes'] = [];
  const write = (path: string, content: string) => {
    if (wiki.files.get(path) !== content) writes.push({ path, content });
  };
  for (const page of wiki.pages.values()) {
    if (normalizeId(page.frontmatter.id) !== page.id) write(page.path, fixId(page));
  }
  if (wiki.pageErrors.length === 0) {
    const index =
      wiki.index === undefined ? generateIndex(wiki) : reconcileIndex(wiki.index, wiki).index;
    write(INDEX_FILE, index);
  }
  if (
    wiki.ledgerErrors.length === 0 &&
    (wiki.files.has(LEDGER_FILE) || wiki.skillImpact !== undefined)
  ) {
    write(SKILL_IMPACT_FILE, renderSkillImpact(wiki.ledger));
  }
  return { writes };
}

/** Applies `fix` in memory, for a dry run or a test. */
export const fixInMemory = (wiki: Wiki): Wiki => withWrites(wiki, fix(wiki).writes);
