#!/usr/bin/env node
/**
 * A fake Neon-shaped store: scale-to-zero Postgres behind an HTTP SQL endpoint, the shape of
 * Neon's serverless driver over HTTP (vision 15 §8.2). Plain Node, no dependencies. Grader-side
 * only: never copied into a rollout sandbox.
 *
 * What it models:
 * - `POST /sql` `{ query, params? }` runs one query. Every query is counted and logged with its
 *   origin, taken from the `x-application-name` header (the HTTP stand-in for a connection's
 *   `application_name`).
 * - The compute suspends after `suspendAfterMs` of simulated time with no query (Neon: five quiet
 *   minutes). A query against a suspended compute wakes it (`wakes` counts that).
 * - Awake time over any simulated window is reported (`awakeMs(from, to)`), so a grader can tell an
 *   app that lets the store sleep from one that keeps it up.
 * - The database can be STOPPED by the grader: queries then fail with 503 and are not counted, to
 *   check that a liveness route answers without the store.
 * - Time is a simulated clock the grader advances or sets; `/__fake/*` is the grader's
 *   introspection and control surface, guarded by an admin token the agent never sees:
 *   `GET /__fake/stats?from=&to=`, `POST /__fake/clock {advanceMs}`, `POST /__fake/stop {stopped}`.
 *
 * The SQL itself is not interpreted beyond a few shapes the fixture apps use: `SELECT 1` returns
 * one row, INSERT/UPDATE/DELETE report a row count, and any other SELECT returns no rows (an empty
 * queue).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINUTE_MS = 60_000;
export const DEFAULT_START = Date.parse('2026-11-01T00:00:00.000Z');

export function createClock(start = DEFAULT_START) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError('advance takes ms >= 0');
      t += ms;
      return t;
    },
    set(ms) {
      if (!(Number.isFinite(ms) && ms >= t)) throw new RangeError('the clock never goes back');
      t = ms;
      return t;
    },
  };
}

export function loadVariant(name) {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, 'variants', name, 'store.json'), 'utf8'));
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function respond(query) {
  const q = String(query).trim();
  if (/^select\s+1\b/i.test(q))
    return { command: 'SELECT', rowCount: 1, rows: [{ '?column?': 1 }] };
  if (/^select\s+now\(\)/i.test(q))
    return { command: 'SELECT', rowCount: 1, rows: [{ now: null }] };
  const m = /^(insert|update|delete)\b/i.exec(q);
  if (m) return { command: m[1].toUpperCase(), rowCount: /^insert/i.test(q) ? 1 : 0, rows: [] };
  if (/^(create|alter|drop)\b/i.test(q)) return { command: 'DDL', rowCount: 0, rows: [] };
  return { command: 'SELECT', rowCount: 0, rows: [] };
}

/** config: { suspendAfterMs?, tables? } (tables are documentation for the fixture's schema). */
export function createNeonStore(config = {}, { clock = createClock() } = {}) {
  const suspendAfterMs = config.suspendAfterMs ?? 5 * MINUTE_MS;
  /** Awake intervals [start, end): a query at t keeps the compute up until t + suspendAfterMs. */
  const intervals = [];
  const state = { queries: 0, refused: 0, wakes: 0, stopped: false, lastQueryAt: null, log: [] };

  const last = () => intervals[intervals.length - 1];
  const awakeAt = (t) => {
    const l = last();
    return l !== undefined && t >= l.start && t < l.end;
  };

  function query(sql, app = 'unknown') {
    const now = clock.now();
    if (state.stopped) {
      state.refused++;
      return { status: 503, body: { message: 'database unavailable' } };
    }
    if (typeof sql !== 'string' || sql.trim() === '') {
      return { status: 400, body: { message: 'query must be a non-empty string' } };
    }
    const l = last();
    if (l && now < l.end) {
      l.end = now + suspendAfterMs;
    } else {
      intervals.push({ start: now, end: now + suspendAfterMs });
      state.wakes++;
    }
    state.queries++;
    state.lastQueryAt = now;
    state.log.push({ at: now, app, query: sql.slice(0, 200) });
    return { status: 200, body: respond(sql) };
  }

  /** Awake time within [from, to), never counting time after `now`. */
  function awakeMs(from, to = clock.now()) {
    const hi = Math.min(to, clock.now());
    let sum = 0;
    for (const i of intervals) sum += Math.max(0, Math.min(i.end, hi) - Math.max(i.start, from));
    return sum;
  }

  function stats({ from, to } = {}) {
    const lo = from ?? Number.NEGATIVE_INFINITY;
    const hi = to ?? Number.POSITIVE_INFINITY;
    const inWindow = state.log.filter((e) => e.at >= lo && e.at < hi);
    const byApp = {};
    for (const e of inWindow) byApp[e.app] = (byApp[e.app] ?? 0) + 1;
    return {
      now: iso(clock.now()),
      suspended: !awakeAt(clock.now()),
      suspendAfterMs,
      stopped: state.stopped,
      queries: inWindow.length,
      totalQueries: state.queries,
      refused: state.refused,
      wakes: state.wakes,
      lastQueryAt: iso(state.lastQueryAt),
      byApp,
      awakeMs: from === undefined ? null : awakeMs(from, to),
      log: inWindow.map((e) => ({ ...e, at: iso(e.at) })),
    };
  }

  const setStopped = (v) => {
    state.stopped = Boolean(v);
  };

  return {
    clock,
    state,
    query,
    awakeMs,
    stats,
    setStopped,
    suspended: () => !awakeAt(clock.now()),
  };
}

const readBody = (req) =>
  new Promise((res) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => res(b));
  });

/**
 * Starts the fake on 127.0.0.1. options: { config | variant, clock?, port?, adminToken? }.
 * Returns { url, adminToken, clock, store, stats(), setStopped(), stop() }.
 */
export async function start(options = {}) {
  const config = options.config ?? loadVariant(options.variant ?? 'train');
  const clock = options.clock ?? createClock(options.start);
  const store = createNeonStore(config, { clock });
  const adminToken = options.adminToken ?? randomBytes(16).toString('hex');
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://store.local');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const raw = await readBody(req);
    if (u.pathname.startsWith('/__fake/')) {
      if (req.headers['x-fake-admin'] !== adminToken) return send(403, { message: 'grader only' });
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'GET' && u.pathname === '/__fake/stats') {
        const num = (k) => (u.searchParams.has(k) ? Number(u.searchParams.get(k)) : undefined);
        return send(200, store.stats({ from: num('from'), to: num('to') }));
      }
      if (req.method === 'POST' && u.pathname === '/__fake/clock') {
        clock.advance(Number(body.advanceMs ?? 0));
        return send(200, { now: iso(clock.now()) });
      }
      if (req.method === 'POST' && u.pathname === '/__fake/stop') {
        store.setStopped(body.stopped !== false);
        return send(200, { stopped: store.state.stopped });
      }
      return send(404, { message: 'unknown control endpoint' });
    }
    if (req.method === 'POST' && u.pathname === '/sql') {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(400, { message: 'body must be JSON' });
      }
      const app = String(req.headers['x-application-name'] ?? 'unknown');
      const r = store.query(body.query, app);
      return send(r.status, r.body);
    }
    return send(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(options.port ?? 0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    adminToken,
    clock,
    store,
    config,
    stats: (w) => store.stats(w),
    setStopped: (v) => store.setStopped(v),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const s = await start({ variant: arg('variant', 'train'), port: Number(arg('port', '0')) });
  console.log(`neon-shaped fake on ${s.url} (admin token ${s.adminToken})`);
}
