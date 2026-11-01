/**
 * A simulated Cloudflare Workers `fetch` for running the agent's keepalive Worker locally
 * (hidden, grader-side). It reproduces the two runtime behaviours the keepalive incidents turned
 * on (vision 15 §2.2, §2.3):
 *
 * - GET subrequests go through an edge cache: a 2xx response is stored and replayed for
 *   `cacheTtlMs` of simulated time, never reaching the origin, unless the request sets
 *   `cache: 'no-store'`;
 * - `cache: 'no-store'` together with `cf.cacheTtl` is rejected, and the request throws before it
 *   leaves the Worker.
 *
 * Requests are routed by origin: `routes[origin]` maps a public origin (the store's
 * `https://<ref>.supabase.co`, a tool's public URL) to a local base URL; any other origin goes to
 * `fallback` (a stub that answers 200, standing in for the rest of the internet being up).
 */
import { createServer } from 'node:http';

// The real fetch, captured before runSweep swaps the global for the simulated one.
const realFetch = globalThis.fetch;

export function createWorkersFetch({ routes, fallback, clock, cacheTtlMs = 30 * 86_400_000 }) {
  const cache = new Map();
  const log = [];
  const workersFetch = async (input, init = {}) => {
    const req = typeof input === 'string' || input instanceof URL ? null : input;
    const url = new URL(req ? req.url : String(input));
    const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
    if (init.cache === 'no-store' && init.cf && init.cf.cacheTtl !== undefined) {
      throw new TypeError(
        `CacheTtl: ${init.cf.cacheTtl}, is not compatible with cache: no-store. Please use cache: no-cache instead.`,
      );
    }
    const key = url.href;
    const cacheable = method === 'GET' && init.cache !== 'no-store';
    if (cacheable) {
      const hit = cache.get(key);
      if (hit && clock.now() < hit.expires) {
        log.push({ at: clock.now(), url: key, cached: true, status: hit.status });
        return new Response(hit.body, { status: hit.status, headers: hit.headers });
      }
    }
    const base = routes[url.origin] ?? fallback;
    const target = `${base.replace(/\/+$/, '')}${url.pathname}${url.search}`;
    const { cache: _c, cf: _cf, ...rest } = init;
    const res = await realFetch(target, { ...rest, method, signal: init.signal });
    const body = await res.text();
    const headers = Object.fromEntries(res.headers);
    log.push({ at: clock.now(), url: key, cached: false, status: res.status });
    if (cacheable && res.status >= 200 && res.status < 300) {
      cache.set(key, { status: res.status, headers, body, expires: clock.now() + cacheTtlMs });
    }
    return new Response(body, { status: res.status, headers });
  };
  return { fetch: workersFetch, log, cache };
}

/** Runs one keepalive sweep of `mod` (an imported worker module) with the simulated fetch. */
export async function runSweep(mod, targets, workersFetch) {
  const env = { KEEPALIVE_TARGETS: JSON.stringify(targets) };
  const saved = globalThis.fetch;
  const savedLog = console.log;
  globalThis.fetch = workersFetch;
  console.log = () => {};
  try {
    if (mod?.default && typeof mod.default.fetch === 'function') {
      const res = await mod.default.fetch(new Request('https://keepalive.local/run'), env);
      return JSON.parse(await res.text());
    }
    if (typeof mod?.runKeepalive === 'function')
      return await mod.runKeepalive(targets, workersFetch);
    throw new Error('worker module has neither a default fetch handler nor runKeepalive');
  } finally {
    globalThis.fetch = saved;
    console.log = savedLog;
  }
}

/** A stub origin that answers 200 `{ ok: true }` to everything. */
export async function startStub() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export const readJsonFile = async (path) => {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8'));
};
