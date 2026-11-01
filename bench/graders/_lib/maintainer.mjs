/**
 * Hidden maintainer grader for `wiki/probe-layer-incidents-*` (vision 06 §4.6, 15 §8.4). Every
 * check is structural or keyword-based; no LLM is called (an `eval` judge can be layered on later).
 *
 * RUBRIC
 * 1. Valid output: `MaintainerOutput` validates; every updated page exists in the bundle and every
 *    created page does not; every op's target occurs exactly once (08 §9.1).
 * 2. Cited claims: the output is applied to the bundle's pages. A CLAIM is a paragraph or list item
 *    of new body text (a block of a created page, or a block of an updated page that was not in the
 *    original). Headings, code, HTML comments and lead-in lines ending in ":" are not claims. Every
 *    claim cites at least one evidence ref, and every ref the output adds (in claims or in
 *    frontmatter) occurs somewhere in the bundle.
 * 3. No evidence removed: every evidence ref in an updated page's original text is still in it.
 * 4. Status changes follow 04 §4: a created page is `hypothesis`; an update may not move a page to
 *    `confirmed` unless the page already had a verified remediation (the maintainer can never set
 *    `verified: true`, that is a ledger-stage fact), may not move `confirmed` back to
 *    `hypothesis`, and `superseded` needs `supersededBy`.
 * 5. Required distinction: one created page, or an update to one of `rubric.ruleHomes`, contains
 *    a rule CONDITIONAL ON THE LIVENESS MODEL: a claim naming `needs-traffic` that says the probe
 *    reaches/queries the store, and a claim naming `needs-silence` that says the probe stops at the
 *    application / does not touch the store. That page's new claims cite at least one ref unique
 *    to each of the two incidents in `rubric.incidents` (a ref in both incidents counts for
 *    neither).
 * 6. No overgeneral rule: no new claim that names no liveness model states either
 *    "every healthcheck/probe/keepalive queries the database" or "probes never touch the database".
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

/** Pages by id (from frontmatter `id:`), the bundle's evidence refs, and raw record ids. */
export function readBundle(bundleDir) {
  const pages = new Map();
  const refs = new Set();
  for (const file of walk(bundleDir)) {
    const text = readFileSync(file, 'utf8');
    for (const r of refsIn(text)) refs.add(r);
    const rel = relative(bundleDir, file);
    if (rel.startsWith('raw/') && file.endsWith('.json')) {
      try {
        const id = JSON.parse(text).rawId;
        if (id) refs.add(`raw:${id}`);
      } catch {
        // not a raw record
      }
    }
    if (file.endsWith('.md')) {
      const m = /^---\n[\s\S]*?^id:\s*(\S+)/m.exec(text);
      if (m && text.startsWith('---\n')) pages.set(m[1], { file: rel, text });
    }
  }
  return { pages, refs };
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

const count = (hay, needle) => {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
};

/** Applies PatchOps with 08 §9.1 semantics; throws on a target that is absent or repeated. */
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

const MODEL_RE = /\bneeds-(traffic|silence|heal)\b/i;
const STORE_RE = /\b(store|stores|database|databases|postgres|db|table)\b/i;
const REACH_RE =
  /\b(reach(es|ing)?|quer(y|ies|ying)|read(s|ing)?|select(s)?|hit(s)?|touch(es)?)\b/i;
const STOP_RE =
  /\b(stops? at|never|must not|mustn't|does not|doesn't|do not|don't|without|store-free|leaves? the store|application|\/health\/live)\b/i;
const NEG_RE = /\b(never|not|n't|without|no)\b/i;
const UNIVERSAL_RE = /\b(every|all|always|any)\b/i;
const PROBE_RE = /\b(health ?checks?|probes?|keepalives?|liveness)\b/i;

const sentences = (claim) => claim.split(/(?<=[.;])\s+/);
const clauses = (claim) => claim.split(/(?<=[.;,])\s+|\s+(?:so|because|while|but)\s+/i);

/** Overgeneral A: "every healthcheck/probe queries the database"; B: "probes never touch it". */
export function overgeneral(claim) {
  if (MODEL_RE.test(claim)) return null;
  for (const s of clauses(claim)) {
    if (!PROBE_RE.test(s) || !STORE_RE.test(s) || !REACH_RE.test(s)) continue;
    if (UNIVERSAL_RE.test(s) && !NEG_RE.test(s)) return 'A';
    if (/\b(never|must not|mustn't|should not|shouldn't|do not|don't|cannot)\b/i.test(s))
      return 'B';
  }
  return null;
}

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
    skip(LATER, 'no output');
    return ctx.result(checks);
  }
  const v = ctx.validateMaintainerOutput(ctx.maintainerOutput);
  add('output validates against MaintainerOutput', v.success, v.error);
  if (!v.success) {
    skip(LATER, 'invalid output');
    return ctx.result(checks);
  }
  const out = ctx.maintainerOutput;
  const { pages, refs: bundleRefs } = readBundle(ctx.bundleDir);

  // Apply.
  const changed = []; // { id, oldText, newText, created }
  const applyErrors = [];
  for (const p of out.create_pages) {
    if (pages.has(p.id)) applyErrors.push(`create ${p.id}: page already exists`);
    else changed.push({ id: p.id, oldText: '', newText: p.content, created: true });
  }
  for (const u of out.update_pages) {
    const page = pages.get(u.id);
    if (!page) {
      applyErrors.push(`update ${u.id}: no such page in the bundle`);
      continue;
    }
    try {
      changed.push({
        id: u.id,
        oldText: page.text,
        newText: applyOps(page.text, u.ops),
        created: false,
      });
    } catch (e) {
      applyErrors.push(`update ${u.id}: ${e.message}`);
    }
  }
  add(
    'pages and patch targets resolve',
    applyErrors.length === 0,
    applyErrors.join('; ') || undefined,
  );
  if (applyErrors.length > 0) {
    skip(LATER, 'the output does not apply');
    return ctx.result(checks);
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
      for (const r of cited) if (!bundleRefs.has(r)) foreign.add(r);
    }
    const oldFrontRefs = refsIn(o.front);
    for (const r of refsIn(n.front)) if (!oldFrontRefs.has(r) && !bundleRefs.has(r)) foreign.add(r);
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

  // 5. Required distinction.
  const incidentRefs = rubric.incidents.map((id) => {
    const p = pages.get(id);
    return p ? refsIn(splitPage(p.text).front) : new Set();
  });
  const unique = incidentRefs.map((set, i) => {
    const others = incidentRefs.filter((_, j) => j !== i);
    return new Set([...set].filter((r) => !others.some((o) => o.has(r))));
  });
  const homes = changed.filter((c) => c.created || rubric.ruleHomes.includes(c.id));
  const findings = [];
  let distinct = false;
  for (const c of homes) {
    const claims = claimsByPage.get(c.id) ?? [];
    const traffic = claims.some((cl) =>
      sentences(cl).some(
        (s) => /\bneeds-traffic\b/i.test(s) && REACH_RE.test(s) && STORE_RE.test(s),
      ),
    );
    const silence = claims.some((cl) =>
      sentences(cl).some((s) => /\bneeds-silence\b/i.test(s) && STOP_RE.test(s)),
    );
    // The rule itself must carry the citations: refs in the new claims, not in old page text.
    const pageRefs = new Set(claims.flatMap((cl) => [...refsIn(cl)]));
    const citesEach = unique.map((u) => [...u].some((r) => pageRefs.has(r)));
    findings.push(
      `${c.id}: needs-traffic→reach ${traffic ? 'yes' : 'no'}, needs-silence→stop ${silence ? 'yes' : 'no'}, cites ${rubric.incidents
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

  // 6. No overgeneral rule.
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
