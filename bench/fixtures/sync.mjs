#!/usr/bin/env node
/**
 * Builds each task's agent-visible `fixture/` from the fixture variants (bench/README.md).
 *
 * The canonical tool trees live under `bench/fixtures/<fixture>/variants/<split>/tool/`, plus files
 * shared by several variants under `bench/fixtures/_shared/`. A task's `fixture/` is a byte-for-byte
 * copy of its variant (so `tasks/<id>/` is self-contained for the sandbox builder and the task-set
 * hash), and this script is the only writer.
 *
 *   node bench/fixtures/sync.mjs           # rewrite every task fixture
 *   node bench/fixtures/sync.mjs --check   # exit 1 if any task fixture drifted
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const BENCH = dirname(FIXTURES);

const KEEPALIVE_WORKER = { from: '_shared/keepalive/worker.mjs', to: 'keepalive/worker.mjs' };

/** task id → { variant tool dir (relative to bench/fixtures), shared files }. */
export const FIXTURE_TASKS = {
  'replay/keepalive-probe-reaches-store-train': {
    variant: 'supabase-shaped/variants/train/tool',
    shared: [KEEPALIVE_WORKER],
  },
  'replay/keepalive-probe-reaches-store-val': {
    variant: 'supabase-shaped/variants/val/tool',
    shared: [KEEPALIVE_WORKER],
  },
  'replay/idle-probe-leaves-store-asleep-train': {
    variant: 'neon-shaped/variants/train/tool',
    shared: [KEEPALIVE_WORKER],
  },
  'replay/idle-probe-leaves-store-asleep-val': {
    variant: 'neon-shaped/variants/val/tool',
    shared: [KEEPALIVE_WORKER],
  },
  'loop/fixture-preview-before-push-train': {
    variant: 'loop-tool/variants/train/tool',
    shared: [],
  },
  'loop/fixture-preview-before-push-val': { variant: 'loop-tool/variants/val/tool', shared: [] },
};

function compose(spec, out) {
  cpSync(join(FIXTURES, spec.variant), out, { recursive: true });
  for (const s of spec.shared) {
    mkdirSync(dirname(join(out, s.to)), { recursive: true });
    cpSync(join(FIXTURES, s.from), join(out, s.to));
  }
}

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p));
  }
  return out.sort();
}

/** Returns one line per drifted file; empty when every task fixture matches its variant. */
export function checkFixtures() {
  const drift = [];
  const tmp = mkdtempSync(join(tmpdir(), 'bench-fixtures-'));
  try {
    for (const [task, spec] of Object.entries(FIXTURE_TASKS)) {
      const want = join(tmp, task);
      compose(spec, want);
      const have = join(BENCH, 'tasks', task, 'fixture');
      const a = listFiles(want);
      const b = listFiles(have);
      for (const f of a) {
        if (!b.includes(f)) drift.push(`${task}: fixture/${f} is missing`);
        else if (!readFileSync(join(want, f)).equals(readFileSync(join(have, f))))
          drift.push(`${task}: fixture/${f} differs from ${spec.variant}`);
      }
      for (const f of b)
        if (!a.includes(f)) drift.push(`${task}: fixture/${f} is not in the variant`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return drift;
}

export function syncFixtures() {
  for (const [task, spec] of Object.entries(FIXTURE_TASKS)) {
    const out = join(BENCH, 'tasks', task, 'fixture');
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    compose(spec, out);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const drift = checkFixtures();
    if (drift.length > 0) {
      console.error(drift.join('\n'));
      console.error('\nrun: node bench/fixtures/sync.mjs');
      process.exit(1);
    }
    console.log('task fixtures match their variants');
  } else {
    syncFixtures();
    console.log(`synced ${Object.keys(FIXTURE_TASKS).length} task fixtures`);
  }
}
