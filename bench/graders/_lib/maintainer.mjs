/**
 * Hidden maintainer grader for `wiki/probe-layer-incidents-*` (vision 06 §4.6, 15 §8.4). Every
 * check is structural or keyword-based; no LLM is called (an `eval` judge can be layered on later).
 *
 * RUBRIC
 * 1. Valid output: `MaintainerOutput` validates, and the REAL patch engine
 *    (`ctx.wiki.applyMaintainerOutput`, packages/wiki/src/patch.ts) applies it to the bundle's wiki:
 *    ids resolve as production resolves them (`normalizeId`), every op target occurs exactly once
 *    (overlapping occurrences counted), created pages are new and parse, updated pages still parse.
 * 2. Cited claims: a CLAIM is a paragraph or list item of new body text (a block of a created
 *    page, or a block of an updated page that was not in the original). Headings, code, HTML
 *    comments and lead-in lines ending in ":" are not claims. Every claim cites at least one
 *    evidence ref, and every ref the output adds (in claims or in frontmatter) occurs somewhere
 *    in the bundle.
 * 3. No evidence removed: every evidence ref in an updated page's original text is still in it.
 * 4. Status changes follow 04 §4: a created page is `hypothesis`; an update may not move a page to
 *    `confirmed` unless the page already had a verified remediation (the maintainer can never set
 *    `verified: true`, that is a ledger-stage fact), may not move `confirmed` back to
 *    `hypothesis`, and `superseded` needs `supersededBy`.
 * 5. Required distinction: one created page, or an update to one of `rubric.ruleHomes`, contains
 *    a rule CONDITIONAL ON THE LIVENESS MODEL, with the right POLARITY on each branch: a statement
 *    naming `needs-traffic` (and not the other models) in which the probe reaches the store and
 *    no reach is negated, and a statement naming `needs-silence` (not `needs-traffic`) that names
 *    the store and only negates reaching it ("never queries the store", "stops at the
 *    application", "store-free"). That page's new claims cite at least one ref unique to each of
 *    the two incidents in `rubric.incidents` (a ref in both incidents counts for neither).
 * 6. No overgeneral or inverted rule, checked per STATEMENT (claims split at sentence ends and at
 *    while/but/whereas and at a comma that introduces another model):
 *    - a statement naming no model may not say "every healthcheck/probe/keepalive queries the
 *      database" (A) or "probes never touch the database" (B);
 *    - a statement naming a model may not prescribe the opposite of that model: a store reach for
 *      `needs-silence`/`needs-heal`, or a negated reach for `needs-traffic`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REF_RE =
  /\b(?:issue|pr):[\w.-]+\/[\w.-]+#\d+|\bcommit:[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}|\brun:[\w.-]+\/[\w.-]+\/\d+|\braw:\d{8}T\d{6}Z-[0-9a-f]{8}|\btracer:[\w-]+|\bpost:https?:\/\/[^\s)\]>,"'`]+/g;

export const refsIn = (text) =>
  new Set((String(text).match(REF_RE) ?? []).map((r) => r.replace(/[.;:]+$/, '')));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every evidence ref the bundle carries (pages, raw records, context). */
export function bundleRefs(bundleDir) {
  const refs = new Set();
  for (const file of walk(bundleDir)) {
    const text = readFileSync(file, 'utf8');
    for (const r of refsIn(text)) refs.add(r);
    if (relative(bundleDir, file).startsWith('raw/') && file.endsWith('.json')) {
      try {
        const id = JSON.parse(text).rawId;
        if (id) refs.add(`raw:${id}`);
      } catch {
        // not a raw record
      }
    }
  }
  return refs;
}

export function splitPage(text) {
  if (!text.startsWith('---\n')) return { front: '', body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { front: text, body: '' };
  const after = text.indexOf('\n', end + 1);
  return { front: text.slice(0, end + 1), body: after < 0 ? '' : text.slice(after + 1) };
}

export const statusOf = (front) => /^status:\s*([a-z-]+)/m.exec(front)?.[1] ?? null;
const supersededBy = (front) => /^supersededBy:\s*\S+/m.test(front);
const verifiedRemediations = (front) => (front.match(/verified:\s*true/g) ?? []).length;

/** Occurrences of `needle`, overlapping ones included (the patch engine's count). */
const count = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};

/** PatchOps with 08 §9.1 semantics (a standalone helper; grading uses the real engine). */
export function applyOps(text, ops) {
  let out = text;
  for (const [i, op] of ops.entries()) {
    if (op.op === 'append') {
      out += op.text;
      continue;
    }
    const n = count(out, op.target);
    if (n !== 1) throw new Error(`op ${i} (${op.op}): target occurs ${n} times`);
    const at = out.indexOf(op.target);
    out =
      op.op === 'replace'
        ? out.slice(0, at) + op.text + out.slice(at + op.target.length)
        : out.slice(0, at + op.target.length) + op.text + out.slice(at + op.target.length);
  }
  return out;
}

/** Paragraphs and list items of a markdown body (see RUBRIC 2). */
export function blocks(body) {
  const out = [];
  let inCode = false;
  let cur = [];
  const flush = () => {
    const t = cur.join(' ').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
    cur = [];
  };
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s*<!--/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) flush();
    cur.push(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
  }
  flush();
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

export function claimsOf(oldBody, newBody) {
  const before = new Set(blocks(oldBody).map(norm));
  return blocks(newBody).filter((b) => !before.has(norm(b)) && !/:\s*$/.test(b));
}

// ---- statement polarity (RUBRIC 5, 6) -----------------------------------------------------

const MODEL_G = /\bneeds-(traffic|silence|heal)\b/gi;
const STORE_RE = /\b(store|stores|database|databases|postgres|db|table)\b/i;
const REACH_G =
  /\b(?:reach(?:es|ing)?|quer(?:y|ies|ying)|reads?|reading|selects?|hits?|touch(?:es|ing)?|wakes?|waking)\b/gi;
const NEG_WORD = /\b(?:never|not|cannot|without|no)\b|n't\b/i;
const STOP_RE =
  /\bstops?\s+at\s+the\s+(?:app|application|process|server|service)\b|\bstore-free\b|\bleaves?\s+the\s+(?:store|database|db)\s+(?:alone|asleep|idle)\b/i;
const UNIVERSAL_RE = /\b(every|all|always|any)\b/i;
const PRESCRIPTIVE_RE =
  /\b(every|all|always|any|never|must|should|shall|cannot|only|has to|have to|needs? to)\b/i;
const NEG_PRESCRIPTION_RE =
  /\b(never|must not|mustn't|should not|shouldn't|do not|don't|cannot)\b/i;
const PROBE_RE = /\b(health ?checks?|probes?|keepalives?|liveness)\b/i;

/** A claim's statements: sentences, split again at while/but/whereas and at a comma that
 * introduces another liveness model ("…, and for `needs-silence` …"). */
export const statements = (claim) =>
  claim
    .split(
      /(?<=[.;])\s+|\s+(?:while|whereas|whilst|but)\s+|,\s+(?=(?:and\s+|but\s+)?(?:for\s+|with\s+|under\s+|in\s+)?`?needs-)/i,
    )
    .filter((s) => s.trim());

/** Models named, and whether the statement reaches the store (pos) and/or negates a reach. */
export function polarity(s) {
  const models = new Set([...s.matchAll(MODEL_G)].map((m) => m[1].toLowerCase()));
  let pos = false;
  let neg = false;
  for (const m of s.matchAll(REACH_G)) {
    const window = s.slice(0, m.index).split(/\s+/).slice(-4).join(' ');
    if (NEG_WORD.test(window)) neg = true;
    else pos = true;
  }
  if (STOP_RE.test(s)) neg = true;
  return { models, pos, neg, store: STORE_RE.test(s) };
}

/** The required branches of the distinction (RUBRIC 5). */
export function trafficBranch(s) {
  const p = polarity(s);
  return (
    p.models.has('traffic') &&
    !p.models.has('silence') &&
    !p.models.has('heal') &&
    p.store &&
    p.pos &&
    !p.neg
  );
}
export function silenceBranch(s) {
  const p = polarity(s);
  return p.models.has('silence') && !p.models.has('traffic') && p.store && p.neg && !p.pos;
}

/**
 * RUBRIC 6 for one claim: null, or why it is overgeneral. A: "every healthcheck queries the
 * database"; B: "probes never touch the database"; or an inversion of the model it names.
 */
export function overgeneral(claim) {
  for (const s of statements(claim)) {
    const p = polarity(s);
    if (p.models.size === 0) {
      if (!PROBE_RE.test(s) || !p.store) continue;
      if (p.pos && !p.neg && UNIVERSAL_RE.test(s)) return 'A';
      if (p.neg && NEG_PRESCRIPTION_RE.test(s)) return 'B';
      continue;
    }
    if (!p.store || !PRESCRIPTIVE_RE.test(s)) continue;
    if ((p.models.has('silence') || p.models.has('heal')) && p.pos)
      return 'inverts needs-silence (prescribes a store reach)';
    if (p.models.has('traffic') && p.neg && !p.pos)
      return 'inverts needs-traffic (prescribes no store reach)';
  }
  return null;
}

// ---- the grader ----------------------------------------------------------------------------

export function gradeMaintainer(ctx, rubric) {
  const checks = [];
  const add = (name, passed, detail) => checks.push(ctx.check(name, Boolean(passed), detail));
  const skip = (names, why) => {
    for (const n of names) add(n, false, `skipped: ${why}`);
  };
  const LATER = [
    'every new or changed claim cites evidence present in the bundle',
    'no existing evidence ref is removed',
    'status changes follow the lifecycle (04 §4)',
    'a rule conditional on the liveness model, citing both incidents',
    'no overgeneral rule',
  ];

  if (ctx.maintainerOutputError || ctx.maintainerOutput === undefined) {
    add(
      'output validates against MaintainerOutput',
      false,
      ctx.maintainerOutputError ?? 'no output.json',
    );
    skip(['pages and patch targets resolve', ...LATER], 'no output');
    return ctx.result(checks);
  }
  const v = ctx.validateMaintainerOutput(ctx.maintainerOutput);
  add('output validates against MaintainerOutput', v.success, v.error);
  if (!v.success) {
    skip(['pages and patch targets resolve', ...LATER], 'invalid output');
    return ctx.result(checks);
  }
  const out = ctx.maintainerOutput;
  const refsInBundle = bundleRefs(ctx.bundleDir);
  const wiki = ctx.wiki.load(join(ctx.bundleDir, 'wiki'));

  // 1. Apply with the production engine.
  const applied = ctx.wiki.applyMaintainerOutput(wiki, out, {
    actor: 'bench-grader',
    now: new Date('2026-11-01T00:00:00Z'),
  });
  add(
    'pages and patch targets resolve',
    applied.ok,
    applied.ok ? undefined : applied.errors.join('; '),
  );
  if (!applied.ok) {
    skip(LATER, 'the output does not apply');
    return ctx.result(checks);
  }
  const changed = []; // { id, oldText, newText, created }
  for (const w of applied.changeset.writes) {
    const id = ctx.wiki.pathToId(w.path);
    if (!id || w.path === 'index.md' || w.path === 'log.md') continue;
    const oldText = wiki.files.get(w.path);
    changed.push({
      id,
      oldText: oldText ?? '',
      newText: w.content,
      created: oldText === undefined,
    });
  }

  // 2. Cited claims.
  const uncited = [];
  const foreign = new Set();
  const claimsByPage = new Map();
  for (const c of changed) {
    const o = splitPage(c.oldText);
    const n = splitPage(c.newText);
    const claims = claimsOf(o.body, n.body);
    claimsByPage.set(c.id, claims);
    for (const claim of claims) {
      const cited = refsIn(claim);
      if (cited.size === 0) uncited.push(`${c.id}: "${claim.slice(0, 80)}"`);
      for (const r of cited) if (!refsInBundle.has(r)) foreign.add(r);
    }
    const oldFrontRefs = refsIn(o.front);
    for (const r of refsIn(n.front))
      if (!oldFrontRefs.has(r) && !refsInBundle.has(r)) foreign.add(r);
  }
  add(
    'every new or changed claim cites evidence present in the bundle',
    uncited.length === 0 && foreign.size === 0,
    [
      uncited.length ? `uncited: ${uncited.join(' | ')}` : '',
      foreign.size ? `refs not in the bundle: ${[...foreign].join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ') || undefined,
  );

  // 3. No evidence removed.
  const removed = [];
  for (const c of changed.filter((x) => !x.created)) {
    const now = refsIn(c.newText);
    for (const r of refsIn(c.oldText)) if (!now.has(r)) removed.push(`${c.id}: ${r}`);
  }
  add('no existing evidence ref is removed', removed.length === 0, removed.join('; ') || undefined);

  // 4. Status lifecycle.
  const statusErrors = [];
  for (const c of changed) {
    const nf = splitPage(c.newText).front;
    const to = statusOf(nf);
    if (c.created) {
      if (to !== null && to !== 'hypothesis')
        statusErrors.push(`${c.id}: created as ${to}, not hypothesis`);
      continue;
    }
    const of = splitPage(c.oldText).front;
    const from = statusOf(of);
    if (verifiedRemediations(nf) > verifiedRemediations(of)) {
      statusErrors.push(`${c.id}: sets a remediation verified (only ledger stages verify, 04 §4)`);
    }
    if (from === to) continue;
    if (to === 'confirmed' && verifiedRemediations(of) === 0) {
      statusErrors.push(`${c.id}: ${from} → confirmed without a verified remediation`);
    } else if (from === 'confirmed' && to === 'hypothesis') {
      statusErrors.push(`${c.id}: confirmed → hypothesis is not a lifecycle move`);
    } else if (to === 'superseded' && !supersededBy(nf)) {
      statusErrors.push(`${c.id}: superseded without supersededBy`);
    } else if (!['confirmed', 'superseded', 'archived'].includes(to ?? '')) {
      statusErrors.push(`${c.id}: ${from} → ${to} is not a lifecycle move`);
    }
  }
  add(
    'status changes follow the lifecycle (04 §4)',
    statusErrors.length === 0,
    statusErrors.join('; ') || undefined,
  );

  // 5. Required distinction, with per-branch polarity.
  const incidentRefs = rubric.incidents.map((id) => {
    const p = wiki.pages.get(ctx.wiki.normalizeId(id));
    return p ? refsIn(splitPage(p.raw).front) : new Set();
  });
  const unique = incidentRefs.map((set, i) => {
    const others = incidentRefs.filter((_, j) => j !== i);
    return new Set([...set].filter((r) => !others.some((o) => o.has(r))));
  });
  const homes = new Set(rubric.ruleHomes.map((h) => ctx.wiki.normalizeId(h)));
  const findings = [];
  let distinct = false;
  for (const c of changed.filter((x) => x.created || homes.has(x.id))) {
    const claims = claimsByPage.get(c.id) ?? [];
    const stmts = claims.flatMap(statements);
    const traffic = stmts.some(trafficBranch);
    const silence = stmts.some(silenceBranch);
    // The rule itself must carry the citations: refs in the new claims, not in old page text.
    const pageRefs = new Set(claims.flatMap((cl) => [...refsIn(cl)]));
    const citesEach = unique.map((u) => [...u].some((r) => pageRefs.has(r)));
    findings.push(
      `${c.id}: needs-traffic→reaches the store ${traffic ? 'yes' : 'no'}, needs-silence→stays off the store ${silence ? 'yes' : 'no'}, cites ${rubric.incidents
        .map((id, i) => `${id.split('/')[1]} ${citesEach[i] ? 'yes' : 'no'}`)
        .join(', ')}`,
    );
    if (traffic && silence && citesEach.every(Boolean)) distinct = true;
  }
  add(
    'a rule conditional on the liveness model, citing both incidents',
    distinct,
    findings.join(' | ') || `no new page and no update to ${rubric.ruleHomes.join(', ')}`,
  );

  // 6. No overgeneral or inverted rule.
  const over = [];
  for (const [id, claims] of claimsByPage) {
    for (const cl of claims) {
      const k = overgeneral(cl);
      if (k) over.push(`${id} (${k}): "${cl.slice(0, 90)}"`);
    }
  }
  add('no overgeneral rule', over.length === 0, over.join(' | ') || undefined);

  return ctx.result(checks);
}

export function loadRubric(dir) {
  const p = join(dir, 'rubric.json');
  if (!existsSync(p)) throw new Error(`no rubric at ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}
