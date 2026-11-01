/**
 * A simulated Cloudflare Workers `fetch` for running the agent's keepalive Worker locally
 * (hidden, grader-side). It reproduces the two runtime behaviours the keepalive incidents turned
 * on (vision 15 §2.2, §2.3):
 *
 * - GET subrequests go through an edge cache: a 2xx response is stored and replayed for
 *   `cacheTtlMs` of simulated time, never reaching the origin. Standard fetch cache modes that
 *   go to the origin bypass it: `no-store` (no cache at all), `no-cache` (revalidate with the
 *   origin on every request: the request reaches the store) and `reload`;
 * - `cache: 'no-store'` together with `cf.cacheTtl` is rejected, and the request throws before it
 *   leaves the Worker.
 *
 * Requests are routed by origin: `routes[origin]` maps a public origin (the store's
 * `https://<ref>.supabase.co`, a tool's public URL) to a local base URL; any other origin goes to
 * `fallback` (a stub that answers 200, standing in for the rest of the internet being up).
 *
 * The agent's Worker itself never runs in the grader process: `startWorkerHost` loads it in a
 * child (worker-host.mjs) whose `fetch` is proxied back here, request by request.
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN_MODES = new Set(['no-store', 'no-cache', 'reload']);

export function createWorkersFetch({ routes, fallback, clock, cacheTtlMs = 30 * 86_400_000 }) {
  const cache = new Map();
  const log = [];
  const workersFetch = async (input, init = {}) => {
    const req = typeof input === 'string' || input instanceof URL ? null : input;
    const url = new URL(req ? req.url : String(input));
    const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
    if (init.cache === 'no-store' && init.cf && init.cf.cacheTtl !== undefined) {
      throw new TypeError(
        `CacheTtl: ${init.cf.cacheTtl}, is not compatible with cache: no-store. Drop cf.cacheTtl when the request must not be cached.`,
      );
    }
    const key = url.href;
    const cacheable = method === 'GET' && !ORIGIN_MODES.has(init.cache);
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
    const res = await realFetch(target, {
      ...rest,
      method,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    const headers = Object.fromEntries(res.headers);
    log.push({ at: clock.now(), url: key, cached: false, status: res.status });
    // `no-cache` revalidates but may still store the fresh response; `no-store` never stores.
    if (init.cache !== 'no-store' && method === 'GET' && res.status >= 200 && res.status < 300) {
      cache.set(key, { status: res.status, headers, body, expires: clock.now() + cacheTtlMs });
    }
    return new Response(body, { status: res.status, headers });
  };
  return { fetch: workersFetch, log, cache };
}

// The grader's own fetch, captured at load (no agent code ever runs in this process).
const realFetch = globalThis.fetch;

/**
 * Starts the agent's Worker module (`workerPath`, inside the tree) in its own process and returns
 * `{ error }` when it does not load, else `{ sweep(targets, workersFetch) }`. Each sweep runs the
 * Worker's `fetch` handler (or `runKeepalive`) there; every subrequest it makes is answered by
 * `workersFetch` here. A sweep that takes longer than `timeoutMs` reads as an error.
 */
export async function startWorkerHost(ctx, workerPath, { timeoutMs = 20_000 } = {}) {
  const host = ctx.spawnNode({ script: join(HERE, 'worker-host.mjs'), cwd: dirname(workerPath) });
  let runtimeFetch = null;
  const waiting = new Map();
  let nextId = 0;
  const died = host.exited.then(({ code, output }) => {
    const err = new Error(`worker host exited (${code}): ${output.slice(-500)}`);
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    return err;
  });
  host.onMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'fetch') {
      try {
        if (!runtimeFetch) throw new Error('no sweep in progress');
        const res = await runtimeFetch(msg.url, {
          method: msg.method,
          headers: msg.headers,
          body: msg.body,
          ...(msg.cache !== undefined ? { cache: msg.cache } : {}),
          ...(msg.cf !== undefined ? { cf: msg.cf } : {}),
        });
        host.send({
          type: 'fetched',
          id: msg.id,
          status: res.status,
          headers: Object.fromEntries(res.headers),
          body: await res.text(),
        });
      } catch (e) {
        host.send({
          type: 'fetch-error',
          id: msg.id,
          name: e instanceof TypeError ? 'TypeError' : 'Error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
    const key = msg.type === 'loaded' || msg.type === 'load-error' ? 'load' : msg.id;
    const w = waiting.get(key);
    if (!w) return;
    waiting.delete(key);
    if (msg.type === 'loaded') w.resolve(null);
    else if (msg.type === 'swept') w.resolve(msg.results);
    else w.reject(new Error(msg.error));
  });
  const request = (key, message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(key);
        reject(new Error(`worker did not answer in ${timeoutMs} ms`));
      }, timeoutMs);
      waiting.set(key, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        host.send(message);
      } catch {
        // The host is gone (crashed at start, or killed): report how it ended.
        waiting.delete(key);
        clearTimeout(timer);
        died.then(reject);
      }
    });
  try {
    await request('load', { type: 'load', url: pathToFileURL(workerPath).href });
  } catch (e) {
    await host.stop();
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    async sweep(targets, workersFetch) {
      const id = nextId++;
      runtimeFetch = workersFetch;
      try {
        return await request(id, { type: 'sweep', id, targets });
      } finally {
        runtimeFetch = null;
      }
    },
    stop: () => host.stop(),
  };
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
