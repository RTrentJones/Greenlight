/**
 * Hidden app grader for `replay/idle-probe-leaves-store-asleep-*` (vision 06 §10.1, 15 §8.2).
 *
 * It starts the sandbox's app the way its container would (the Dockerfile's `CMD`, run locally)
 * against the fake Neon-shaped store, with fake-clock-shim.mjs preloaded, and then simulates a
 * 10-minute idle window step by step: the store's clock and the app's clock advance together,
 * every app timer due in the window fires at its simulated time (a 30-second poll fires twenty
 * times), the container healthcheck fires on its declared interval, and one keepalive sweep runs
 * the sandbox's own Worker over its targets in a separate process (worker-host.mjs). Runtime
 * checks:
 *   - zero store queries from the healthcheck, from the keepalive, and from the idle app overall;
 *   - the store's compute is suspended at the end of the window;
 *   - the healthcheck and keepalive routes answer 200 while the database is stopped;
 *   - `/health` still reports the database (the readiness check verify calls).
 * Structural checks: a container healthcheck whose local URL the grader can read, and a keepalive
 * target with a usable URL (whether the Worker can probe it is decided by running the Worker).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveAppPort } from './app-port.mjs';
import { startClockCoordinator } from './fake-clock-coordinator.mjs';
import { createWorkersFetch, startStub, startWorkerHost } from './workers-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, 'fake-clock-shim.mjs');
const UNIT = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
/** Smallest simulated step: timers due within one step fire in order inside it. */
const STEP_MS = 1000;
const MAX_STEPS = 2000;
const REAL_BUDGET_MS = 30_000;

/** A Dockerfile's instructions: comments dropped, `\` continuations joined, one per entry. */
function instructions(dockerfile) {
  return dockerfile
    .replace(/\\[ \t]*\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const LOCAL_HOST = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/;
/** The forms a port takes in a healthcheck command: a number, a shell or template variable
 * (`$PORT`, `${PORT:-3000}`, `${process.env.PORT}`), or a string concatenation
 * (`'http://localhost:' + process.env.PORT + '/live'`). */
const PORT_FORMS = [/^\d+/, /^\$\{[^}\n]*\}/, /^\$[A-Za-z_]\w*/, /^['"`]\s*\+[^'"`\n]+?\+\s*['"`]/];
const PATH_FORM = /^\/[^\s"'`\\)|;&]*/;

/**
 * The local URL path a healthcheck command probes, or null when there is none the grader can
 * read. A URL with no path probes `/`. A port written as an expression the grader does not
 * recognise yields null (the check then FAILS with the command quoted): guessing `/` there would
 * grade a different route than the one the container probes.
 */
export function healthcheckPath(text) {
  const m = LOCAL_HOST.exec(text);
  if (!m) return null;
  let rest = text.slice(m.index + m[0].length);
  if (rest.startsWith(':')) {
    rest = rest.slice(1);
    const port = PORT_FORMS.map((re) => re.exec(rest)).find(Boolean);
    if (!port) return null;
    rest = rest.slice(port[0].length);
  }
  return PATH_FORM.exec(rest)?.[0] ?? '/';
}

/** Reads the HEALTHCHECK instruction from a Dockerfile (or a compose healthcheck). The last
 * HEALTHCHECK wins, as in Docker. */
export function parseHealthcheck(dockerfile, compose = '') {
  const line = instructions(dockerfile)
    .filter((l) => /^HEALTHCHECK\s+/i.test(l))
    .pop();
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
  return { path: healthcheckPath(text), intervalMs: interval, raw: text.trim() };
}

/**
 * The command the container runs: the LAST `CMD` instruction (Docker's rule), as argv. The
 * `CMD` that belongs to a `HEALTHCHECK` (also when it sits on a continuation line) is not an
 * instruction of its own and is never read as the app command. Exec form (`CMD ["node", "x"]`) is
 * used as written; shell form (`CMD node x`) runs under `/bin/sh -c`, as Docker runs it.
 */
export function parseCmd(dockerfile) {
  const line = instructions(dockerfile)
    .filter((l) => /^CMD\s+/i.test(l))
    .pop();
  if (!line) return null;
  const body = line.replace(/^CMD\s+/i, '').trim();
  if (body.startsWith('[')) {
    try {
      const argv = JSON.parse(body);
      return Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')
        ? argv
        : null;
    } catch {
      return null;
    }
  }
  return body === '' ? null : ['/bin/sh', '-c', body];
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
    hc
      ? hc.path
        ? `${hc.path} every ${hc.intervalMs} ms`
        : `no local URL the grader can read (http://localhost[:port]/path) in: ${hc.raw}`
      : 'none',
  );
  let targets = [];
  try {
    targets = JSON.parse(read(join(ctx.tree, 'keepalive/targets.json')) || '[]');
  } catch (e) {
    add('keepalive targets parse', false, e.message);
  }
  const target = (Array.isArray(targets) ? targets : []).find((t) => t?.name === cfg.tool);
  // Which `kind` the target carries is the Worker's business, not this check's: the vendored
  // Worker (keepalive/worker.mjs, the contract of infra/modules/keepalive/worker.js) probes
  // `kind: "oci"` targets as a plain service URL and everything else as a Supabase API (anon key
  // required, 2xx only). The sweep below runs that Worker, so a target it cannot probe fails
  // there, with the Worker's own error. Here the target only has to exist with a usable URL.
  let targetOrigin = null;
  try {
    if (typeof target?.url === 'string') targetOrigin = new URL(target.url).origin;
  } catch {
    // not a URL: the check below says so
  }
  add(
    `keepalive target declared for ${cfg.tool}`,
    target && targetOrigin,
    target
      ? targetOrigin
        ? `kind ${target.kind ?? 'supabase'}, probePath ${target.probePath ?? '/'}`
        : `url is not an absolute URL: ${JSON.stringify(target.url)?.slice(0, 120)}`
      : 'none',
  );
  const cmd = parseCmd(dockerfile);
  if (!cmd) {
    add('container CMD runnable', false, 'no CMD instruction in the Dockerfile');
    return ctx.result(checks);
  }

  // Runtime: the app on the simulated clock, against the fake store.
  const fake = await ctx.startFixture('neon-shaped', { config: cfg });
  // One simulated clock for every process and thread the app runs (fake-clock-coordinator.mjs).
  const clock = await startClockCoordinator({ start: fake.clock.now() });
  ctx.onCleanup(() => clock.stop());
  // The app's port is reserved, never merely picked (app-port.mjs): whatever else listened on it
  // would answer in the app's place, and be graded.
  const reserved = await reserveAppPort();
  ctx.onCleanup(() => reserved.release());
  let app;
  try {
    app = await ctx.spawnApp({
      cwd: toolDir,
      command: cmd,
      env: { [cfg.dbEnv]: fake.url, NODE_ENV: 'production', ...clock.env() },
      preload: [SHIM],
      port: reserved.port,
      readyPath: '/',
    });
  } catch (e) {
    add('app starts', false, e.message);
    return ctx.result(checks);
  }
  let next = null;
  try {
    ({ next } = await clock.waitForParticipant());
  } catch (e) {
    if (e?.harness) throw e; // a harness error is a grader error, never a failing check
    add('app runs on the simulated clock', false, e.message);
    return ctx.result(checks);
  }

  const stub = await startStub();
  ctx.onCleanup(() => stub.stop());
  let worker = null;
  const workerPath = join(ctx.tree, 'keepalive/worker.mjs');
  if (targetOrigin && existsSync(workerPath)) {
    const h = await startWorkerHost(ctx, workerPath);
    if (h.error) add('keepalive worker loads', false, h.error);
    else worker = h;
  }
  const runtime = createWorkersFetch({
    routes: targetOrigin ? { [targetOrigin]: app.url } : {},
    fallback: stub.url,
    clock: fake.clock,
  });

  // Steps both clocks to `end`, firing the app's timers at their due times and each grader event
  // at its own time.
  const realStart = Date.now();
  let steps = 0;
  let truncated = '';
  const simStart = fake.clock.now();
  async function runUntil(end, events, onEvent) {
    const queue = [...events].sort((a, b) => a.at - b.at);
    let t = fake.clock.now();
    for (;;) {
      while (queue.length > 0 && queue[0].at <= t) await onEvent(queue.shift());
      if (t >= end) return;
      const candidates = [end];
      if (queue.length > 0) candidates.push(queue[0].at);
      if (next !== null) candidates.push(Math.max(next, t + STEP_MS));
      const to = Math.min(...candidates);
      fake.clock.set(Math.max(fake.clock.now(), to));
      try {
        ({ next } = await clock.advance(to));
      } catch (e) {
        if (e?.harness) throw e;
        truncated = `${e.message} at +${Math.round((to - simStart) / 1000)} s simulated`;
        return;
      }
      t = to;
      steps++;
      if (steps > MAX_STEPS || Date.now() - realStart > REAL_BUDGET_MS) {
        truncated = `stopped after ${steps} steps / ${Date.now() - realStart} ms real at +${Math.round((t - simStart) / 1000)} s simulated`;
        return;
      }
    }
  }

  // Boot-time queries (migrations, leftover work) land before the window, which opens one simulated
  // minute after boot.
  await runUntil(fake.clock.now() + 60_000, [], async () => {});
  const windowMs = cfg.idleWindowMs;
  const t0 = fake.clock.now();
  const events = [];
  if (hc?.path) {
    for (let at = 0; at < windowMs; at += hc.intervalMs)
      events.push({ at: t0 + at, kind: 'healthcheck' });
  }
  if (target && worker) events.push({ at: t0 + windowMs / 2, kind: 'keepalive' });

  const caused = { healthcheck: 0, keepalive: 0 };
  const bad = { healthcheck: [], keepalive: [] };
  await runUntil(t0 + windowMs, events, async (ev) => {
    const before = fake.store.state.queries;
    if (ev.kind === 'healthcheck') {
      const r = await get(app.url + hc.path);
      if (r.status !== 200) bad.healthcheck.push(r.status);
    } else {
      let results = [];
      try {
        results = await worker.sweep(targets, runtime.fetch);
      } catch (e) {
        results = [{ name: cfg.tool, ok: false, error: e.message }];
      }
      for (const r of (Array.isArray(results) ? results : []).filter((x) => x?.name === cfg.tool)) {
        if (!r.ok) bad.keepalive.push(r.status ?? r.error);
      }
    }
    caused[ev.kind] += fake.store.state.queries - before;
  });
  // Work a step started in another thread or process (a message to a worker, say) may still be
  // in flight: let it land, stamped inside the window, before reading the store.
  await new Promise((r) => setTimeout(r, 250));
  const idle = fake.stats({ from: t0, to: t0 + windowMs + 1 });

  add(
    'the idle window was simulated in full',
    !truncated && fake.clock.now() >= t0 + windowMs,
    truncated ||
      `${steps} steps, ${Date.now() - realStart} ms real, ${clock.joined()} clock participant(s)`,
  );
  const strays = clock.problems();
  add(
    'every process and thread the app started ran on the simulated clock',
    strays.length === 0,
    strays.join('; ') || undefined,
  );
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
