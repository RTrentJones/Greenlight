#!/usr/bin/env node
/**
 * `node scripts/evo-restore.mjs <opened-state-dir> <checkout>` (run with tsx in evo.yml, which
 * loads the ledger validator) — restores an earlier evo run's state into the checkout (vision
 * 06 §9; evo.yml). The directory is what `scripts/evo-state.mjs open` unpacked from an
 * AES-256-GCM-authenticated blob, so it is what an earlier evo run of this repository sealed.
 * Even so, only the paths an iteration writes are copied, and only when they are consistent with
 * the checkout:
 *
 * - `.greenlight/bench/**`, `.greenlight/raw/**`, `.greenlight/quota/**` (iteration state, bench
 *   run progress, raw records, quota) — never `.greenlight/bundle-keys/**` and never a `.lock`;
 * - `wiki/ledger.jsonl`: the checkout's ledger BYTES must be a prefix of the restored one, and
 *   every restored line must parse as a ledger event and the whole must pass the stage machine
 *   (`validateLedger`); `wiki/evidence/eval/*.json`;
 * - wiki pages: only those a restored iteration's maintainer wrote (`state.maintainer.writes`),
 *   plus `wiki/log.md` and `wiki/skill-impact.md`, and each only when the checkout's copy still
 *   equals the copy at that state's `baseCommit` (absent at both counts as equal): a page a human
 *   committed since is never reverted. A state with pages to restore but no `baseCommit` refuses.
 *   evo.yml then runs `greenlight wiki lint --strict` before the iteration uses them.
 *
 * Nothing else is restored: no code, no `bench/`, no skills, no node_modules. A symlink anywhere
 * is refused. Any refusal copies nothing. Exit 0 restored, 1 refused.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const STATE_ROOTS = ['.greenlight/bench/', '.greenlight/raw/', '.greenlight/quota/'];
const ALWAYS_PAGES = ['wiki/log.md', 'wiki/skill-impact.md'];
const STATE_RE = /^\.greenlight\/bench\/iterations\/[^/]+\/state\.json$/;

/** Whether a path (relative, `/`-separated) may be in the state at all. */
export function restorable(rel) {
  if (rel.split('/').some((p) => p === '' || p === '.' || p === '..')) return false;
  if (rel.split('/').at(-1) === '.lock' || rel.endsWith('.lock')) return false;
  if (STATE_ROOTS.some((r) => rel.startsWith(r))) return true;
  if (rel === 'wiki/ledger.jsonl') return true;
  if (/^wiki\/evidence\/eval\/[^/]+\.json$/.test(rel)) return true;
  if (/^wiki\/(?:[^/]+\/)*[^/]+\.md$/.test(rel)) return true;
  return false;
}

function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    const rel = relative(root, abs).split(sep).join('/');
    if (st.isSymbolicLink()) throw new Error(`refusing a symlink in the state: ${rel}`);
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(rel);
    else throw new Error(`refusing a non-regular file in the state: ${rel}`);
  }
  return out;
}

/** The checkout's file at `commit` (a Buffer), or null when it is absent there. */
function atCommit(checkout, commit, rel) {
  try {
    execFileSync('git', ['-C', checkout, 'cat-file', '-e', `${commit}^{commit}`], {
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`the state's base commit ${commit} is not in this checkout's history`);
  }
  try {
    return execFileSync('git', ['-C', checkout, 'show', `${commit}:${rel}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Returns `{ restored, skipped }`, or throws without copying anything. `validateLedger(text)`
 * returns the problems of a ledger text (unparsable lines, schema failures, duplicate eventIds,
 * stage-machine violations); `atBase(rel, commit)` reads a file at a commit (default: git).
 */
export function restore(artifact, checkout, opts = {}) {
  const validateLedger = opts.validateLedger;
  if (typeof validateLedger !== 'function') throw new Error('restore needs a ledger validator');
  const atBase = opts.atBase ?? ((rel, commit) => atCommit(checkout, commit, rel));
  const files = walk(artifact);
  const inState = files.filter(restorable);

  // Pages: the maintainer's writes of every restored state, plus log and skill-impact.
  const bases = new Map(); // page -> [baseCommit|undefined, ...]
  for (const rel of inState.filter((f) => STATE_RE.test(f))) {
    let s;
    try {
      s = JSON.parse(readFileSync(join(artifact, ...rel.split('/')), 'utf8'));
    } catch {
      throw new Error(`${rel} is not JSON`);
    }
    const pages = [
      ...(s?.maintainer?.writes ?? []).map((w) => `wiki/${String(w?.path ?? '')}`),
      ...ALWAYS_PAGES,
    ];
    for (const p of pages) {
      if (
        !/^wiki\/(?:[^/]+\/)*[^/]+\.md$/.test(p) ||
        p.split('/').some((x) => x === '..' || x === '.')
      )
        throw new Error(`${rel} lists a maintainer write outside the wiki pages: ${p}`);
      bases.set(p, [
        ...(bases.get(p) ?? []),
        typeof s.baseCommit === 'string' ? s.baseCommit : undefined,
      ]);
    }
  }
  const isPage = (f) => /^wiki\/(?:[^/]+\/)*[^/]+\.md$/.test(f);
  const keep = inState.filter((f) => !isPage(f) || bases.has(f));
  for (const page of keep.filter(isPage)) {
    const cur = existsSync(join(checkout, ...page.split('/')))
      ? readFileSync(join(checkout, ...page.split('/')))
      : null;
    for (const base of bases.get(page) ?? []) {
      if (base === undefined || !/^[0-9a-f]{40,64}$/.test(base)) {
        throw new Error(
          `the state that wrote ${page} records no base commit: refusing to restore wiki pages from it`,
        );
      }
      const then = atBase(page, base);
      const same = cur === null ? then === null : then !== null && Buffer.compare(cur, then) === 0;
      if (!same) {
        throw new Error(
          `${page} changed in the checkout since the iteration's base commit ${base.slice(0, 12)} (a human commit): refusing to overwrite it. Start a new iteration, or reconcile the page by hand`,
        );
      }
    }
  }

  // The ledger: the checkout's bytes are a prefix of the restored bytes, and the result is valid.
  const ourFile = join(checkout, 'wiki', 'ledger.jsonl');
  const ours = existsSync(ourFile) ? readFileSync(ourFile) : Buffer.alloc(0);
  if (keep.includes('wiki/ledger.jsonl')) {
    const theirs = readFileSync(join(artifact, 'wiki', 'ledger.jsonl'));
    if (
      theirs.length < ours.length ||
      Buffer.compare(theirs.subarray(0, ours.length), ours) !== 0
    ) {
      throw new Error(
        "the state's wiki/ledger.jsonl does not extend the checkout's ledger byte for byte: refusing to restore",
      );
    }
    const problems = validateLedger(theirs.toString('utf8'));
    if (problems.length > 0) {
      throw new Error(
        `the state's wiki/ledger.jsonl is not a valid ledger: ${problems.slice(0, 5).join('; ')}`,
      );
    }
  } else if (ours.length > 0) {
    throw new Error('the state has no wiki/ledger.jsonl, but the checkout has a ledger');
  }

  for (const rel of keep) {
    const to = join(checkout, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(artifact, ...rel.split('/')), to);
  }
  return { restored: keep, skipped: files.filter((f) => !keep.includes(f)) };
}

/** The ledger validator from the wiki package (needs a TypeScript loader: run under tsx). */
export async function wikiLedgerValidator() {
  const load = await import(new URL('../packages/wiki/src/load.ts', import.meta.url).href);
  const ledger = await import(new URL('../packages/wiki/src/ledger.ts', import.meta.url).href);
  return (text) => {
    const { events, errors } = load.parseLedger(text);
    return [...errors.map((e) => `line ${e.line}: ${e.message}`), ...ledger.ledgerProblems(events)];
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [artifact, checkout] = process.argv.slice(2);
  if (!artifact || !checkout) {
    console.error('usage: tsx scripts/evo-restore.mjs <opened-state-dir> <checkout>');
    process.exit(2);
  }
  try {
    const r = restore(artifact, checkout, { validateLedger: await wikiLedgerValidator() });
    console.log(`restored ${r.restored.length} file(s); skipped ${r.skipped.length}`);
    for (const f of r.skipped) console.log(`  skipped ${f}`);
  } catch (e) {
    console.error(`evo-restore: ${e.message}`);
    process.exit(1);
  }
}
