/**
 * Hidden app grader for `replay/idle-probe-leaves-store-asleep-*` (vision 06 §10.1, 15 §8.2).
 *
 * It starts the sandbox's app the way its container would (the Dockerfile's `CMD`, run locally)
 * against the fake Neon-shaped store, then simulates a 10-minute idle window in a few real
 * seconds: the container healthcheck fires on its declared interval (compressed), and one
 * keepalive sweep runs the sandbox's own Worker over its targets. Runtime checks:
 *   - zero store queries from the healthcheck, from the keepalive, and from the idle app overall;
 *   - the store's compute is suspended at the end of the window;
 *   - the healthcheck and keepalive routes answer 200 while the database is stopped;
 *   - `/health` still reports the database (the readiness check verify calls).
 * Structural checks: a container healthcheck and an oci keepalive target are declared.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkersFetch, runSweep, startStub } from './workers-runtime.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UNIT = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Reads the HEALTHCHECK instruction from a Dockerfile (or a compose healthcheck). */
export function parseHealthcheck(dockerfile, compose = '') {
  const joined = dockerfile.replace(/\\\r?\n/g, ' ');
  const line = joined.split(/\r?\n/).find((l) => /^\s*HEALTHCHECK\s+/i.test(l));
  let text;
  let interval = 30_000;
  if (line) {
    if (/^\s*HEALTHCHECK\s+NONE\b/i.test(line)) return null;
    text = line;
    const m = /--interval=(\d+(?:\.\d+)?)(ms|s|m|h)/i.exec(line);
    if (m) interval = Number(m[1]) * UNIT[m[2].toLowerCase()];
  } else {
    const c = /healthcheck:\s*\n((?:\s+.*\n?)+)/.exec(compose);
    if (!c) return null;
    text = c[1];
    const m = /interval:\s*["']?(\d+(?:\.\d+)?)(ms|s|m|h)/i.exec(text);
    if (m) interval = Number(m[1]) * UNIT[m[2].toLowerCase()];
  }
  const u =
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(?:\d+|\$\{?PORT\}?))?(\/[^\s"'\\)|;&]*)?/.exec(
      text,
    );
  if (!u) return { path: null, intervalMs: interval, raw: text.trim() };
  return { path: u[1] ?? '/', intervalMs: interval, raw: text.trim() };
}

export function parseCmd(dockerfile) {
  const m = /^\s*CMD\s+(\[.*\])\s*$/im.exec(dockerfile);
  if (!m) return null;
  try {
    const argv = JSON.parse(m[1]);
    return Array.isArray(argv) && argv.every((a) => typeof a === 'string') ? argv : null;
  } catch {
    return null;
  }
}

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e.message) };
  }
}

export async function gradeNeonIdle(ctx, { variant }) {
  const cfg = JSON.parse(
    readFileSync(
      join(ctx.benchDir, 'fixtures/neon-shaped/variants', variant, 'store.json'),
      'utf8',
    ),
  );
  const checks = [];
  const add = (name, passed, detail) => checks.push(ctx.check(name, Boolean(passed), detail));
  const toolDir = join(ctx.tree, cfg.toolDir);
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

  // Structural: the container declares liveness; the keepalive has a target for the tool.
  const dockerfile = read(join(toolDir, 'Dockerfile'));
  const hc = parseHealthcheck(dockerfile, read(join(toolDir, 'compose.yaml')));
  add(
    'container healthcheck declared',
    hc?.path,
    hc ? (hc.path ? `${hc.path} every ${hc.intervalMs} ms` : `no local URL in: ${hc.raw}`) : 'none',
  );
  let targets = [];
  try {
    targets = JSON.parse(read(join(ctx.tree, 'keepalive/targets.json')) || '[]');
  } catch (e) {
    add('keepalive targets parse', false, e.message);
  }
  const target = (Array.isArray(targets) ? targets : []).find((t) => t?.name === cfg.tool);
  add(
    `keepalive target declared for ${cfg.tool}`,
    target && target.kind === 'oci' && typeof target.url === 'string',
    target ? `kind ${target.kind ?? 'supabase'}, probePath ${target.probePath ?? '/'}` : 'none',
  );
  const cmd = parseCmd(dockerfile);
  if (!cmd) {
    add('container CMD runnable', false, 'no exec-form CMD in the Dockerfile');
    return ctx.result(checks);
  }

  // Runtime.
  const fake = await ctx.startFixture('neon-shaped', { config: cfg });
  let app;
  try {
    app = await ctx.spawnApp({
      cwd: toolDir,
      command: cmd,
      env: { [cfg.dbEnv]: fake.url, NODE_ENV: 'production' },
      readyPath: '/',
    });
  } catch (e) {
    add('app starts', false, e.message);
    return ctx.result(checks);
  }
  const stub = await startStub();
  ctx.onCleanup(() => stub.stop());
  let worker = null;
  const workerPath = join(ctx.tree, 'keepalive/worker.mjs');
  if (target && existsSync(workerPath)) {
    try {
      worker = await import(pathToFileURL(workerPath).href);
    } catch (e) {
      add('keepalive worker loads', false, e.message);
    }
  }
  const runtime = createWorkersFetch({
    routes: target ? { [new URL(target.url).origin]: app.url } : {},
    fallback: stub.url,
    clock: fake.clock,
  });

  // Boot-time queries (migrations, leftover work) land before the window, which opens one simulated
  // minute after boot.
  await sleep(300);
  fake.clock.advance(60_000);
  const windowMs = cfg.idleWindowMs;
  const realMs = cfg.realWindowMs;
  const t0 = fake.clock.now();
  const realStart = Date.now();
  const events = [];
  if (hc?.path) {
    const n = Math.max(1, Math.floor(windowMs / hc.intervalMs));
    for (let i = 0; i < n; i++)
      events.push({ at: Math.round((i * windowMs) / n), kind: 'healthcheck' });
  }
  if (target && worker) events.push({ at: windowMs / 2, kind: 'keepalive' });
  events.sort((a, b) => a.at - b.at);

  const caused = { healthcheck: 0, keepalive: 0 };
  const bad = { healthcheck: [], keepalive: [] };
  for (const ev of events) {
    const due = realStart + (ev.at / windowMs) * realMs;
    if (due > Date.now()) await sleep(due - Date.now());
    fake.clock.set(Math.max(fake.clock.now(), t0 + ev.at));
    const before = fake.store.state.queries;
    if (ev.kind === 'healthcheck') {
      const r = await get(app.url + hc.path);
      if (r.status !== 200) bad.healthcheck.push(r.status);
    } else {
      let results = [];
      try {
        results = await runSweep(worker, targets, runtime.fetch);
      } catch (e) {
        results = [{ name: cfg.tool, ok: false, error: e.message }];
      }
      for (const r of results.filter((x) => x?.name === cfg.tool)) {
        if (!r.ok) bad.keepalive.push(r.status ?? r.error);
      }
    }
    caused[ev.kind] += fake.store.state.queries - before;
  }
  const rest = realStart + realMs - Date.now();
  if (rest > 0) await sleep(rest);
  fake.clock.set(Math.max(fake.clock.now(), t0 + windowMs));
  const idle = fake.stats({ from: t0, to: t0 + windowMs + 1 });

  add(
    'zero store queries from the healthcheck',
    hc?.path && caused.healthcheck === 0,
    `${caused.healthcheck} query(ies) while the healthcheck ran`,
  );
  add(
    'zero store queries from the keepalive',
    target && worker && caused.keepalive === 0,
    `${caused.keepalive} query(ies) while the keepalive swept`,
  );
  add(
    'zero store queries over the idle window',
    idle.queries === 0,
    idle.queries ? `${idle.queries} query(ies): ${JSON.stringify(idle.byApp)}` : undefined,
  );
  add(
    'store suspended at the end of the idle window',
    idle.suspended && idle.awakeMs <= cfg.suspendAfterMs,
    `awake ${Math.round(idle.awakeMs / 1000)} s of ${windowMs / 1000} s`,
  );
  add(
    'healthcheck and keepalive answer 200 while the store is up',
    events.length > 0 && bad.healthcheck.length === 0 && bad.keepalive.length === 0,
    [
      ...bad.healthcheck.map((s) => `healthcheck ${s}`),
      ...bad.keepalive.map((s) => `keepalive ${s}`),
    ].join('; ') || undefined,
  );

  // Liveness must not depend on the database; readiness must.
  fake.setStopped(true);
  const liveHc = hc?.path ? await get(app.url + hc.path) : { status: 0 };
  const liveKa = target ? await get(app.url + (target.probePath ?? '/')) : { status: 0 };
  add(
    'liveness answers 200 while the database is stopped',
    liveHc.status === 200 && liveKa.status === 200,
    `healthcheck ${liveHc.status}, keepalive probe ${liveKa.status}`,
  );
  const downHealth = await get(`${app.url}/health`);
  fake.setStopped(false);
  const before = fake.store.state.queries;
  const upHealth = await get(`${app.url}/health`);
  const hit = fake.store.state.queries - before;
  add(
    '/health still reports the database',
    upHealth.status === 200 && hit >= 1 && downHealth.status >= 500,
    `up: ${upHealth.status} (${hit} query), stopped: ${downHealth.status}`,
  );
  return ctx.result(checks);
}
