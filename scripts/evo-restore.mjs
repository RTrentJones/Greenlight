#!/usr/bin/env node
/**
 * `node scripts/evo-restore.mjs <downloaded-artifact-dir> <checkout>` — restores an earlier evo
 * run's state artifact (vision 06 §1.3; evo.yml) into the checkout, copying ONLY the paths an
 * iteration writes:
 *
 * - `.greenlight/bench/**`, `.greenlight/raw/**`, `.greenlight/quota/**` (iteration state, bench
 *   run progress, raw records, quota) — never `.greenlight/bundle-keys/**` (regenerated per run:
 *   an in-flight proposer step reruns with a fresh bundle) and never a `.lock`;
 * - the wiki's writes: `wiki/ledger.jsonl`, `wiki/evidence/eval/*.json` and `wiki/**\/*.md`.
 *
 * Nothing else is restored: no code, no `bench/` (repros, controls, gate.json), no skills, no
 * node_modules. A symlink anywhere is refused. The restored `wiki/ledger.jsonl` must EXTEND the
 * checkout's (the checkout's events, by eventId, are its prefix); otherwise nothing is copied.
 * Exit 0 restored, 1 refused.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const STATE_ROOTS = ['.greenlight/bench/', '.greenlight/raw/', '.greenlight/quota/'];

/** Whether a path (relative, `/`-separated) of the artifact may be restored. */
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
    if (st.isSymbolicLink()) throw new Error(`refusing a symlink in the artifact: ${rel}`);
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(rel);
    else throw new Error(`refusing a non-regular file in the artifact: ${rel}`);
  }
  return out;
}

const eventIds = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l).eventId ?? null;
          } catch {
            return null;
          }
        })
    : [];

/** Returns the restored paths, or throws without copying anything. */
export function restore(artifact, checkout) {
  const files = walk(artifact);
  const keep = files.filter(restorable);
  const ours = eventIds(join(checkout, 'wiki', 'ledger.jsonl'));
  if (ours.length > 0) {
    if (!keep.includes('wiki/ledger.jsonl')) {
      throw new Error('the artifact has no wiki/ledger.jsonl, but the checkout has a ledger');
    }
    const theirs = eventIds(join(artifact, 'wiki', 'ledger.jsonl'));
    const prefix = ours.every((id, i) => id !== null && theirs[i] === id);
    if (!prefix) {
      throw new Error(
        "the artifact's wiki/ledger.jsonl does not extend the checkout's ledger (its events are not a prefix of the artifact's): refusing to restore",
      );
    }
  }
  for (const rel of keep) {
    const to = join(checkout, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(artifact, ...rel.split('/')), to);
  }
  return { restored: keep, skipped: files.filter((f) => !restorable(f)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [artifact, checkout] = process.argv.slice(2);
  if (!artifact || !checkout) {
    console.error('usage: node scripts/evo-restore.mjs <artifact-dir> <checkout>');
    process.exit(2);
  }
  try {
    const r = restore(artifact, checkout);
    console.log(`restored ${r.restored.length} file(s); skipped ${r.skipped.length}`);
    for (const f of r.skipped) console.log(`  skipped ${f}`);
  } catch (e) {
    console.error(`evo-restore: ${e.message}`);
    process.exit(1);
  }
}
