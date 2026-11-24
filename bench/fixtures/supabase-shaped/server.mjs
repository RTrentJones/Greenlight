#!/usr/bin/env node
/**
 * A fake Supabase-shaped store: PostgREST in front of Postgres, with Supabase's free-tier idle
 * pause (vision 15 §8.2). Plain Node, no dependencies. Grader-side only: never copied into a
 * rollout sandbox.
 *
 * What it models:
 * - `GET /rest/v1/` (the PostgREST root) is answered from an in-memory schema document. It does
 *   NOT touch the store, so it never resets the idle timer.
 * - `GET /rest/v1/<table>?select=…&limit=1` executes a query against the store. Only a query that
 *   executes counts as database activity and resets the idle timer. A request refused before any
 *   query runs (bad key, no grant, unknown table or column, unknown schema) does not count.
 * - The project pauses once `idleLimitMs` of simulated time passes without a query (Supabase: 7
 *   days). A paused project answers every request with 530 until restored.
 * - Time is a simulated clock the grader advances (`clock.advance(ms)`); nothing depends on wall
 *   time.
 * - `/__fake/*` is the introspection and control surface for the grader, guarded by an admin token
 *   the agent never sees: `GET /__fake/idle` → `{ lastQueryAt, paused, … }`, `POST /__fake/clock`
 *   `{ advanceMs }`, `POST /__fake/restore`.
 *
 * Unknown query parameters are read as column filters, as PostgREST does, so a cache-busting
 * `?_=123` answers 400 and runs no query.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAY_MS = 86_400_000;
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

/** Loads `variants/<name>/store.json`. */
export function loadVariant(name) {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, 'variants', name, 'store.json'), 'utf8'));
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(body),
});
const RESERVED = new Set(['select', 'limit', 'offset', 'order']);

/**
 * The store without a socket, for unit tests and for `start()`.
 * config: { anonKey, idleLimitMs?, exposedSchemas?, schemas: { <schema>: { <table>: {
 *   columns: string[], sensitive?: string[], anon?: boolean, rows: object[] } } } }
 */
export function createSupabaseStore(config, { clock = createClock() } = {}) {
  const idleLimitMs = config.idleLimitMs ?? 7 * DAY_MS;
  const schemas = config.schemas ?? {};
  const exposed = config.exposedSchemas ?? Object.keys(schemas);
  const state = {
    lastQueryAt: clock.now(),
    paused: false,
    pausedAt: null,
    queries: 0,
    rootHits: 0,
    refused: 0,
    pausedHits: 0,
    log: [],
  };

  function settle() {
    if (!state.paused && clock.now() - state.lastQueryAt >= idleLimitMs) {
      state.paused = true;
      state.pausedAt = state.lastQueryAt + idleLimitMs;
    }
  }

  function snapshot() {
    settle();
    return {
      now: iso(clock.now()),
      lastQueryAt: iso(state.lastQueryAt),
      paused: state.paused,
      pausedAt: iso(state.pausedAt),
      idleMs: clock.now() - state.lastQueryAt,
      idleLimitMs,
      queries: state.queries,
      rootHits: state.rootHits,
      refused: state.refused,
      pausedHits: state.pausedHits,
      log: state.log.map((e) => ({ ...e, at: iso(e.at) })),
    };
  }

  function restore() {
    state.paused = false;
    state.pausedAt = null;
    state.lastQueryAt = clock.now();
  }

  function schemaDocument() {
    const definitions = {};
    for (const s of exposed) {
      for (const [name, t] of Object.entries(schemas[s] ?? {})) {
        definitions[name] = {
          type: 'object',
          properties: Object.fromEntries(t.columns.map((c) => [c, { type: 'string' }])),
        };
      }
    }
    return { swagger: '2.0', info: { title: 'PostgREST API', version: '12.2.3' }, definitions };
  }

  const refuse = (status, body) => {
    state.refused++;
    return json(status, body);
  };

  /** method: string; url: URL (or path string); headers: lower-cased header record. */
  function handle(method, url, headers = {}) {
    const u = typeof url === 'string' ? new URL(url, 'http://store.local') : url;
    settle();
    if (state.paused) {
      state.pausedHits++;
      return json(530, { message: 'project is paused' });
    }
    if (!u.pathname.startsWith('/rest/v1')) return json(404, { message: 'not found' });
    if (headers.apikey !== config.anonKey) return refuse(401, { message: 'Invalid API key' });
    const rest = u.pathname.replace(/^\/rest\/v1\/?/, '');
    if (rest === '') {
      // Answered from PostgREST's schema cache: no SQL reaches the store.
      state.rootHits++;
      return json(200, schemaDocument(), { 'content-type': 'application/openapi+json' });
    }
    if (method !== 'GET' && method !== 'HEAD') return refuse(405, { message: 'read-only fake' });
    const schema = headers['accept-profile'] ?? 'public';
    if (!exposed.includes(schema) || !schemas[schema]) {
      return refuse(406, { code: 'PGRST106', message: `schema "${schema}" is not exposed` });
    }
    const name = decodeURIComponent(rest);
    const table = schemas[schema][name];
    if (!table) {
      return refuse(404, { code: 'PGRST205', message: `table "${schema}.${name}" not found` });
    }
    const select = (u.searchParams.get('select') ?? '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const columns = select.includes('*') ? [...table.columns] : select;
    for (const c of columns) {
      if (!table.columns.includes(c)) {
        return refuse(400, { code: '42703', message: `column ${name}.${c} does not exist` });
      }
    }
    const filters = [];
    for (const [k, v] of u.searchParams) {
      if (RESERVED.has(k)) continue;
      if (!table.columns.includes(k)) {
        return refuse(400, { code: '42703', message: `column ${name}.${k} does not exist` });
      }
      filters.push([k, v]);
    }
    if (table.anon !== true) {
      return refuse(401, { code: '42501', message: `permission denied for table ${name}` });
    }
    // The query executes: this is database activity.
    let rows = table.rows ?? [];
    for (const [k, v] of filters) {
      if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
    }
    const offset = Number(u.searchParams.get('offset') ?? 0) || 0;
    const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : rows.length;
    rows = rows
      .slice(offset, offset + limit)
      .map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
    state.queries++;
    state.lastQueryAt = clock.now();
    const sensitive = (table.sensitive ?? []).filter((c) => columns.includes(c));
    state.log.push({ at: clock.now(), schema, table: name, columns, sensitive, rows: rows.length });
    return json(200, method === 'HEAD' ? [] : rows, {
      'content-range': `${offset}-${offset + Math.max(rows.length - 1, 0)}/*`,
    });
  }

  return { clock, state, settle, snapshot, restore, handle, config };
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
 * Returns { url, adminToken, clock, store, state(), stop() }.
 */
export async function start(options = {}) {
  const config = options.config ?? loadVariant(options.variant ?? 'train');
  const clock = options.clock ?? createClock(options.start);
  const store = createSupabaseStore(config, { clock });
  const adminToken = options.adminToken ?? randomBytes(16).toString('hex');
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://store.local');
    let out;
    if (u.pathname.startsWith('/__fake/')) {
      if (req.headers['x-fake-admin'] !== adminToken) {
        out = json(403, { message: 'introspection is for the grader' });
      } else if (req.method === 'GET' && u.pathname === '/__fake/idle') {
        out = json(200, store.snapshot());
      } else if (req.method === 'POST' && u.pathname === '/__fake/clock') {
        const body = JSON.parse((await readBody(req)) || '{}');
        clock.advance(Number(body.advanceMs ?? 0));
        out = json(200, { now: new Date(clock.now()).toISOString() });
      } else if (req.method === 'POST' && u.pathname === '/__fake/restore') {
        store.restore();
        out = json(200, store.snapshot());
      } else {
        out = json(404, { message: 'unknown control endpoint' });
      }
    } else {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      );
      out = store.handle(req.method ?? 'GET', u, headers);
    }
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
  await new Promise((r) => server.listen(options.port ?? 0, '127.0.0.1', r));
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    adminToken,
    clock,
    store,
    config,
    state: () => store.snapshot(),
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
  console.log(`supabase-shaped fake on ${s.url} (admin token ${s.adminToken})`);
}
