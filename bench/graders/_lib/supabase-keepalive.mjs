/**
 * Hidden app grader for `replay/keepalive-probe-reaches-store-*` (vision 06 §10.1, 15 §8.2).
 *
 * It runs the sandbox's own keepalive Worker (`keepalive/worker.mjs`) over the sandbox's
 * `keepalive/targets.json`, on the cron's three-day schedule, for three simulated weeks against
 * the fake Supabase-shaped store, and then reads the store's introspection. Runtime checks:
 *   - the store did not pause, and every sweep ran a real query (the idle timer was reset);
 *   - the target reads as healthy while the store is up, and as failing once the store pauses;
 *   - the probe exposes no user columns.
 * Structural checks: the tool has a supabase target that names a `probeTable`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkersFetch, runSweep, startStub } from './workers-runtime.mjs';

const DAY = 86_400_000;

export async function gradeSupabaseKeepalive(ctx, { variant }) {
  const store = JSON.parse(
    readFileSync(
      join(ctx.benchDir, 'fixtures/supabase-shaped/variants', variant, 'store.json'),
      'utf8',
    ),
  );
  const checks = [];
  const add = (name, passed, detail) => checks.push(ctx.check(name, Boolean(passed), detail));
  const tool = store.tool;

  // Structural: the target exists and names a probe table.
  const targetsPath = join(ctx.tree, 'keepalive/targets.json');
  let targets = [];
  try {
    targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
    if (!Array.isArray(targets)) throw new Error('not a JSON array');
  } catch (e) {
    add('keepalive targets parse', false, `keepalive/targets.json: ${e.message}`);
    return ctx.result(checks);
  }
  const mine = targets.filter((t) => t && t.name === tool);
  add(
    `keepalive target declared for ${tool}`,
    mine.length > 0,
    mine.length ? undefined : `no entry with name "${tool}"`,
  );
  const storeTargets = mine.filter(
    (t) =>
      (t.kind ?? 'supabase') === 'supabase' &&
      typeof t.url === 'string' &&
      sameOrigin(t.url, store.publicUrl),
  );
  add(
    "the target probes the tool's Supabase project",
    storeTargets.length > 0,
    storeTargets.length ? undefined : `no supabase-kind target at ${store.publicUrl}`,
  );
  add(
    'the target names a probeTable',
    storeTargets.some((t) => typeof t.probeTable === 'string' && t.probeTable.length > 0),
  );

  // Runtime: sweep the agent's own Worker against the fake.
  const workerPath = join(ctx.tree, 'keepalive/worker.mjs');
  if (!existsSync(workerPath)) {
    add('keepalive worker present', false, 'keepalive/worker.mjs is missing');
    return ctx.result(checks);
  }
  let mod;
  try {
    mod = await import(pathToFileURL(workerPath).href);
  } catch (e) {
    add('keepalive worker loads', false, e.message);
    return ctx.result(checks);
  }

  const fake = await ctx.startFixture('supabase-shaped', { config: store });
  const stub = await startStub();
  ctx.onCleanup(() => stub.stop());
  const runtime = createWorkersFetch({
    routes: { [new URL(store.publicUrl).origin]: fake.url },
    fallback: stub.url,
    clock: fake.clock,
  });

  const start = fake.clock.now();
  const sweeps = 8; // days 0, 3, …, 21
  const perSweep = [];
  for (let i = 0; i < sweeps; i++) {
    if (i > 0) fake.clock.advance(3 * DAY);
    const before = fake.state().queries;
    let results;
    try {
      results = await runSweep(mod, targets, runtime.fetch);
    } catch (e) {
      results = [{ name: tool, ok: false, error: `sweep threw: ${e.message}` }];
    }
    const r = (Array.isArray(results) ? results : []).filter((x) => x?.name === tool);
    perSweep.push({
      day: i * 3,
      queries: fake.state().queries - before,
      ok: r.length > 0 && r.every((x) => x.ok),
      detail: r.map((x) => x.status ?? x.error).join(','),
    });
  }
  const s = fake.state();
  add(
    'store not paused after 21 simulated days',
    !s.paused,
    s.paused ? `paused at ${s.pausedAt}; last query ${s.lastQueryAt}` : undefined,
  );
  const missed = perSweep.filter((p) => p.queries < 1);
  add(
    'every sweep ran a query on the store',
    missed.length === 0,
    missed.length ? `no store query on day(s) ${missed.map((p) => p.day).join(', ')}` : undefined,
  );
  add(
    'lastQueryAt advanced to the last sweep',
    Date.parse(s.lastQueryAt) === start + (sweeps - 1) * 3 * DAY,
    `lastQueryAt ${s.lastQueryAt}`,
  );
  const red = perSweep.filter((p) => !p.ok);
  add(
    'every sweep reports the target healthy while the store is up',
    red.length === 0,
    red.length ? red.map((p) => `day ${p.day}: ${p.detail || 'no result'}`).join('; ') : undefined,
  );
  const leaks = s.log.filter((e) => e.sensitive.length > 0);
  add(
    'the probe exposes no user columns',
    leaks.length === 0,
    leaks.length
      ? `read ${[...new Set(leaks.flatMap((e) => e.sensitive.map((c) => `${e.table}.${c}`)))].join(', ')}`
      : undefined,
  );
  const probeTables = new Set(storeTargets.map((t) => t.probeTable).filter(Boolean));
  const off = s.log.filter((e) => !probeTables.has(e.table));
  add(
    'probe queries read the declared probeTable',
    s.log.length > 0 && off.length === 0,
    off.length ? `queried ${[...new Set(off.map((e) => e.table))].join(', ')}` : undefined,
  );

  // A paused store must read as failing (no green while paused).
  fake.clock.advance(8 * DAY);
  let pausedResults;
  try {
    pausedResults = await runSweep(mod, targets, runtime.fetch);
  } catch (e) {
    pausedResults = [{ name: tool, ok: false, error: e.message }];
  }
  const pr = (Array.isArray(pausedResults) ? pausedResults : []).filter((x) => x?.name === tool);
  add(
    'a paused store reads as failing',
    fake.state().paused && pr.length > 0 && pr.every((x) => !x.ok),
    pr.map((x) => `${x.target ?? x.name}: ok=${x.ok} ${x.status ?? x.error ?? ''}`).join('; '),
  );

  return ctx.result(checks);
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
