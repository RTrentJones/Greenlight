/**
 * Grader-side host for the AGENT's keepalive Worker (hidden). It runs as its own child process
 * (`ctx.spawnNode`), never inside the grader: whatever the agent's `keepalive/worker.mjs` does at
 * import or during a sweep (patch `fetch`, patch timers, read the environment) stays in this
 * process, whose environment is scrubbed and whose only channel is IPC to the grader.
 *
 * The worker's `fetch` is a proxy: every subrequest is sent to the grader, which runs it on the
 * simulated Workers runtime (workers-runtime.mjs: edge cache, routing to the fake store) and sends
 * back the response. So the store sees exactly the requests the worker made; a worker that skips
 * the network cannot make the store see a query.
 *
 * Protocol (IPC messages):
 *   grader → host  { type: 'load', url }                    → { type: 'loaded' } | { type: 'load-error', error }
 *   grader → host  { type: 'sweep', id, targets }           → { type: 'swept', id, results } | { type: 'sweep-error', id, error }
 *   host → grader  { type: 'fetch', id, url, method, headers, cache, cf, body }
 *   grader → host  { type: 'fetched', id, status, headers, body } | { type: 'fetch-error', id, name, message }
 */

const send = process.send?.bind(process);
if (!send) {
  console.error('worker-host: no IPC channel');
  process.exit(2);
}

let nextId = 0;
const pending = new Map();

async function proxyFetch(input, init = {}) {
  const req = typeof input === 'string' || input instanceof URL ? null : input;
  const url = req ? req.url : String(input);
  const headers = Object.fromEntries(new Headers(init.headers ?? req?.headers ?? {}));
  let body;
  if (init.body !== undefined && init.body !== null) body = String(init.body);
  else if (req?.body) body = await req.text();
  const cache = init.cache ?? (req && req.cache !== 'default' ? req.cache : undefined);
  const id = nextId++;
  const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({
    type: 'fetch',
    id,
    url,
    method: init.method ?? req?.method ?? 'GET',
    headers,
    cache,
    cf: init.cf && typeof init.cf === 'object' ? JSON.parse(JSON.stringify(init.cf)) : undefined,
    body,
  });
  const r = await reply;
  return new Response(r.body, { status: r.status, headers: r.headers });
}

const settle = (msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'fetched') p.resolve(msg);
  else {
    const E = msg.name === 'TypeError' ? TypeError : Error;
    p.reject(new E(msg.message));
  }
};

// Installed BEFORE the worker is imported: the worker sees only the proxy.
globalThis.fetch = proxyFetch;
const quiet = () => {};
console.log = quiet;
console.info = quiet;

let mod;
process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'fetched' || msg.type === 'fetch-error') return settle(msg);
  if (msg.type === 'load') {
    try {
      mod = await import(msg.url);
      send({ type: 'loaded' });
    } catch (e) {
      send({ type: 'load-error', error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (msg.type === 'sweep') {
    try {
      let results;
      const env = { KEEPALIVE_TARGETS: JSON.stringify(msg.targets) };
      if (mod?.default && typeof mod.default.fetch === 'function') {
        const res = await mod.default.fetch(new Request('https://keepalive.local/run'), env, {
          waitUntil() {},
          passThroughOnException() {},
        });
        results = JSON.parse(await res.text());
      } else if (typeof mod?.runKeepalive === 'function') {
        results = await mod.runKeepalive(msg.targets, globalThis.fetch);
      } else {
        throw new Error('worker module has neither a default fetch handler nor runKeepalive');
      }
      send({ type: 'swept', id: msg.id, results: JSON.parse(JSON.stringify(results ?? null)) });
    } catch (e) {
      send({ type: 'sweep-error', id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
});
