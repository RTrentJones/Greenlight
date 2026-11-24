/**
 * Fake-clock shim, preloaded into the agent's app (hidden, grader-side). The grader passes it in
 * NODE_OPTIONS (`--import <this file>`), so every Node process the app starts loads it too, and
 * the shim carries itself into every worker thread the app creates.
 *
 * The idle-window grader simulates ten minutes in a few real seconds. Real timers would make an
 * app's `setInterval(poll, 30_000)` (the real Polyphony cadence) fire zero times in that window
 * and pass, so every thread of every process of the app runs on ONE simulated clock instead,
 * served by fake-clock-coordinator.mjs over a unix socket:
 *
 * - faked: `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` (global,
 *   `node:timers`, `node:timers/promises` incl. `scheduler.wait`), `Date` / `Date.now()`,
 *   `performance.now()` / `performance.timeOrigin`, `process.hrtime()` / `process.hrtime.bigint()`,
 *   `process.uptime()` and `AbortSignal.timeout()`. `setImmediate` / `process.nextTick` /
 *   microtasks take no time and stay real (their order relative to timers is unchanged);
 * - propagated: `worker_threads.Worker` boots each worker through this shim first (an eval
 *   bootstrap that imports the shim, then the worker's own entry, unchanged); every child process
 *   (`spawn`, `exec`, `execFile`, `fork`, so also `cluster`) gets NODE_OPTIONS `--import` and the
 *   clock channel re-injected into its environment, even when the app passes its own `env`; the
 *   parent tells the coordinator to expect the child, and the child starts at the parent's
 *   simulated time;
 * - between grader steps each clock flows at real speed (so a short `await sleep(10)` in a request
 *   handler still resolves);
 * - the coordinator advances every participant to the same instant: `{ op: 'advance', id, to }`
 *   fires every timer due at or before `to` in due order, the clock pinned at each timer's due
 *   time, waits for the work it starts (in-flight `fetch`es) to settle, and replies
 *   `{ op: 'advanced', id, now, next }` (`next`: the earliest pending due time, or null).
 *   Intervals fire once per period, as a real process left running for that long would.
 *
 * Protocol (newline-delimited JSON over the socket in BENCH_FAKE_CLOCK_SOCKET):
 *   → { op: 'hello', keys, pid }       ← { op: 'welcome', now }   (the participant rebases to now)
 *   → { op: 'next', next }             (whenever the earliest pending timer changes)
 *   → { op: 'expect', key, now }       (a child / worker is starting at simulated `now`)
 *   → { op: 'unexpect', key }          (it exited before joining)
 *   ← { op: 'advance', id, to }        → { op: 'advanced', id, now, next }
 *
 * Inert unless BENCH_FAKE_CLOCK_SOCKET and BENCH_FAKE_CLOCK_START (epoch ms) are set (or a worker
 * bootstrap passed them). The variables carry no secret and nothing about the task: a socket path
 * and a timestamp. Known limits: timers inside native code and Node internals (socket/server
 * timeouts, `Atomics.wait`, `Intl` defaults, `performance.mark`), `spawnSync`/`execSync`
 * children (they block the app while they run), non-Node children, and code that defeats the
 * shim on purpose (detecting it, closing its socket) are out of scope; the sandbox, not this
 * shim, is the isolation boundary.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';

const KEY = Symbol.for('greenlight.bench.fakeClock');
const CONFIG = Symbol.for('greenlight.bench.fakeClockConfig');
const SHIM_URL = import.meta.url;

const boot = globalThis[CONFIG] ?? {
  socket: process.env.BENCH_FAKE_CLOCK_SOCKET,
  start: Number(process.env.BENCH_FAKE_CLOCK_START),
};
if (!globalThis[KEY] && boot.socket && Number.isFinite(boot.start)) {
  globalThis[KEY] = true;
  install(boot);
}

function install({ socket: socketPath, start, key: bootKey }) {
  const require = createRequire(import.meta.url);
  const timers = require('node:timers');
  const timersPromises = require('node:timers/promises');
  const net = require('node:net');
  const { pathToFileURL } = require('node:url');
  const { resolve: resolvePath } = require('node:path');
  const workerThreads = require('node:worker_threads');
  const childProcess = require('node:child_process');
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setImmediate: globalThis.setImmediate,
    Date: globalThis.Date,
    perf: performance.now.bind(performance),
    hrtimeBigint: process.hrtime.bigint.bind(process.hrtime),
    uptime: process.uptime.bind(process),
    fetch: globalThis.fetch,
  };
  const realStart = real.perf();
  let jumped = 0;
  let pinned = null;
  let advancing = false;
  const flowing = () => start + (real.perf() - realStart) + jumped;
  const now = () => pinned ?? flowing();
  // Monotonic readings never go back, even when a rebase moves the clock backwards a little.
  let lastMono = Number.NEGATIVE_INFINITY;
  const mono = () => {
    lastMono = Math.max(lastMono, now());
    return lastMono;
  };
  const t0 = mono();

  // ---- timers ------------------------------------------------------------------------------
  let seq = 1;
  const pending = new Map(); // id -> { id, due, fn, args, interval, order, ref }
  let order = 0;
  let driver = null;

  class FakeTimeout {
    constructor(id, ms) {
      this._id = id;
      this._ms = ms;
    }
    ref() {
      const t = pending.get(this._id);
      if (t) t.ref = true;
      arm();
      return this;
    }
    unref() {
      const t = pending.get(this._id);
      if (t) t.ref = false;
      arm();
      return this;
    }
    hasRef() {
      return pending.get(this._id)?.ref ?? false;
    }
    refresh() {
      const t = pending.get(this._id);
      if (t) {
        t.due = now() + this._ms;
        t.order = order++;
        arm();
      }
      return this;
    }
    close() {
      clear(this);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  const delayOf = (ms) => {
    const n = Number(ms);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };
  function schedule(fn, ms, args, interval) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be a function');
    const id = seq++;
    const d = delayOf(ms);
    pending.set(id, {
      id,
      due: now() + d,
      fn,
      args,
      interval: interval ? d : 0,
      order: order++,
      ref: true,
    });
    arm();
    return new FakeTimeout(id, d);
  }
  function clear(h) {
    if (h instanceof FakeTimeout) pending.delete(h._id);
    else if (typeof h === 'number' && pending.has(h)) pending.delete(h);
    else if (h !== undefined && h !== null) real.clearTimeout(h);
    arm();
  }
  const earliest = () => {
    let best = null;
    for (const t of pending.values()) {
      if (!best || t.due < best.due || (t.due === best.due && t.order < best.order)) best = t;
    }
    return best;
  };
  function fire(t) {
    if (t.interval) {
      t.due += t.interval;
      t.order = order++;
    } else pending.delete(t.id);
    try {
      t.fn(...t.args);
    } catch (e) {
      queueMicrotask(() => {
        throw e;
      });
    }
  }
  /** Keeps one real timer armed for the earliest fake timer (real-speed flow between steps). It
   * holds the process open exactly when a ref'd fake timer is pending, as a real timer would. */
  function arm() {
    if (driver) real.clearTimeout(driver);
    driver = null;
    reportNext();
    if (advancing) return;
    const t = earliest();
    if (!t) return;
    driver = real.setTimeout(
      () => {
        driver = null;
        for (let n = 0; n < 1000; n++) {
          const e = earliest();
          if (!e || e.due > now()) break;
          fire(e);
        }
        arm();
      },
      Math.max(0, Math.min(t.due - now(), 2 ** 31 - 1)),
    );
    let anyRef = false;
    for (const p of pending.values()) anyRef ||= p.ref;
    if (!anyRef) driver.unref?.();
  }

  const fakeSetTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
  const fakeSetInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
  const promisified = (ms, value, opts = {}) =>
    new Promise((resolve, reject) => {
      if (opts?.signal?.aborted) return reject(opts.signal.reason);
      const h = fakeSetTimeout(() => resolve(value), ms);
      if (opts?.ref === false) h.unref();
      opts?.signal?.addEventListener('abort', () => {
        clear(h);
        reject(opts.signal.reason);
      });
    });
  fakeSetTimeout[Symbol.for('nodejs.util.promisify.custom')] = promisified;
  async function* promisedInterval(ms, value, opts = {}) {
    const queue = [];
    let wake = null;
    const h = fakeSetInterval(() => {
      queue.push(value);
      wake?.();
    }, ms);
    if (opts?.ref === false) h.unref();
    try {
      for (;;) {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (queue.length === 0) {
          await new Promise((r) => {
            wake = r;
          });
        }
        wake = null;
        yield queue.shift();
      }
    } finally {
      clear(h);
    }
  }

  globalThis.setTimeout = fakeSetTimeout;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  timers.setTimeout = fakeSetTimeout;
  timers.setInterval = fakeSetInterval;
  timers.clearTimeout = clear;
  timers.clearInterval = clear;
  timersPromises.setTimeout = promisified;
  timersPromises.setInterval = promisedInterval;
  if (timersPromises.scheduler) {
    timersPromises.scheduler.wait = (ms, opts) => promisified(ms, undefined, opts);
  }

  // ---- AbortSignal.timeout -----------------------------------------------------------------
  AbortSignal.timeout = function timeout(ms) {
    if (typeof ms !== 'number') throw new TypeError('The "delay" argument must be of type number');
    if (!(ms >= 0 && ms <= Number.MAX_SAFE_INTEGER)) throw new RangeError('Invalid "delay"');
    const ac = new AbortController();
    fakeSetTimeout(() => {
      ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, ms).unref();
    return ac.signal;
  };

  // ---- Date --------------------------------------------------------------------------------
  const RealDate = real.Date;
  function FakeDate(...a) {
    if (!new.target) return new RealDate(Math.floor(now())).toString();
    return a.length === 0 ? new RealDate(Math.floor(now())) : new RealDate(...a);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => Math.floor(now());
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;

  // ---- monotonic clocks --------------------------------------------------------------------
  const fakeOrigin = t0 - realStart; // performance.now() reads the real value at install
  Object.defineProperty(performance, 'now', {
    value: function now() {
      return mono() - fakeOrigin;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(performance, 'timeOrigin', {
    get: () => fakeOrigin,
    configurable: true,
  });
  const hr0 = real.hrtimeBigint();
  const hrBig = () => hr0 + BigInt(Math.round((mono() - t0) * 1e6));
  const hrtime = function hrtime(prev) {
    const b = hrBig();
    let s = Number(b / 1_000_000_000n);
    let ns = Number(b % 1_000_000_000n);
    if (Array.isArray(prev)) {
      s -= prev[0];
      ns -= prev[1];
      if (ns < 0) {
        s--;
        ns += 1e9;
      }
    }
    return [s, ns];
  };
  hrtime.bigint = hrBig;
  process.hrtime = hrtime;
  const up0 = real.uptime();
  process.uptime = () => up0 + (mono() - t0) / 1000;

  // ---- in-flight work, for settling after a timer fires ------------------------------------
  let inflight = 0;
  if (typeof real.fetch === 'function') {
    globalThis.fetch = function trackedFetch(...a) {
      inflight++;
      let p;
      try {
        p = real.fetch.apply(this, a);
      } catch (e) {
        inflight--;
        throw e;
      }
      return p.then(
        async (res) => {
          // Count the request until its body is read or a turn passes, so a caller awaiting
          // `res.json()` is still in flight.
          real.setImmediate(() => inflight--);
          return res;
        },
        (e) => {
          inflight--;
          throw e;
        },
      );
    };
  }
  const turn = () => new Promise((r) => real.setImmediate(r));
  const realSleep = (ms) => new Promise((r) => real.setTimeout(r, ms));
  async function settle() {
    const deadline = real.perf() + 3000;
    let quiet = 0;
    while (quiet < 3 && real.perf() < deadline) {
      await turn();
      if (inflight === 0) quiet++;
      else {
        quiet = 0;
        await realSleep(1);
      }
    }
  }

  // ---- the clock channel -------------------------------------------------------------------
  let sock = null;
  const outbox = [];
  const send = (msg) => {
    const line = `${JSON.stringify(msg)}\n`;
    if (sock?.writable && !sock.connecting) sock.write(line);
    else outbox.push(line);
  };
  let lastNext;
  let nextQueued = false;
  function reportNext() {
    if (advancing || nextQueued) return;
    nextQueued = true;
    queueMicrotask(() => {
      nextQueued = false;
      const n = earliest()?.due ?? null;
      if (n !== lastNext) {
        lastNext = n;
        send({ op: 'next', next: n });
      }
    });
  }

  function rebase(to) {
    const delta = to - now();
    if (!Number.isFinite(delta) || delta === 0) return;
    jumped += delta;
    for (const t of pending.values()) t.due += delta;
    arm();
  }

  async function advance(to) {
    advancing = true;
    if (driver) real.clearTimeout(driver);
    driver = null;
    try {
      for (let n = 0; n < 100_000; n++) {
        const t = earliest();
        if (!t || t.due > to) break;
        pinned = Math.max(t.due, flowing());
        fire(t);
        await settle();
      }
      pinned = null;
      if (to > flowing()) jumped += to - flowing();
    } finally {
      pinned = null;
      advancing = false;
      arm();
    }
    lastNext = earliest()?.due ?? null;
    return { now: Math.floor(now()), next: lastNext };
  }

  const keys = workerThreads.isMainThread
    ? [`p:${process.pid}`, `p:${process.ppid}`]
    : [`t:${process.pid}:${workerThreads.threadId}`];
  if (bootKey) keys.unshift(bootKey);
  let chain = Promise.resolve();
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'welcome') {
      rebase(Number(msg.now));
      lastNext = undefined;
      reportNext();
    } else if (msg.op === 'advance') {
      chain = chain.then(async () => {
        const r = await advance(Number(msg.to));
        send({ op: 'advanced', id: msg.id, ...r });
      });
    }
  }
  try {
    sock = net.connect(socketPath);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ op: 'hello', keys, pid: process.pid })}\n`);
      for (const line of outbox.splice(0)) sock.write(line);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          onMessage(JSON.parse(line));
        } catch {
          // a malformed line is ignored
        }
      }
    });
    sock.on('error', () => {});
    // The channel never holds the process open on its own.
    sock.unref();
  } catch {
    sock = null;
  }

  // ---- propagation: worker threads ---------------------------------------------------------
  const RealWorker = workerThreads.Worker;
  class Worker extends RealWorker {
    constructor(filename, options = {}) {
      const opts = options ?? {};
      const config = { socket: socketPath, start: Math.floor(now()) };
      let entry;
      if (opts.eval) entry = { code: String(filename) };
      else if (filename instanceof URL) entry = { url: filename.href };
      else if (typeof filename === 'string' && /^(?:file|data):/.test(filename))
        entry = { url: filename };
      else entry = { url: pathToFileURL(resolvePath(String(filename))).href };
      const bootstrap = `
const config = ${JSON.stringify(config)};
const entry = ${JSON.stringify(entry)};
globalThis[Symbol.for('greenlight.bench.fakeClockConfig')] = config;
import(${JSON.stringify(SHIM_URL)}).then(() => {
  if (entry.url) return import(entry.url);
  const vm = require('node:vm');
  return vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + entry.code + '\\n})', { filename: '[worker eval]' })(exports, require, module, '[worker eval]', '.');
}).catch((e) => { process.nextTick(() => { throw e; }); });
`;
      super(bootstrap, { ...opts, eval: true });
      send({ op: 'expect', key: `t:${process.pid}:${this.threadId}`, now: config.start });
      this.once('exit', () => send({ op: 'unexpect', key: `t:${process.pid}:${this.threadId}` }));
    }
  }
  workerThreads.Worker = Worker;

  // ---- propagation: child processes --------------------------------------------------------
  const importFlag = `--import=${SHIM_URL}`;
  const proto = childProcess.ChildProcess.prototype;
  const realSpawn = proto.spawn;
  proto.spawn = function spawn(options) {
    if (options && Array.isArray(options.envPairs)) {
      const kept = [];
      let nodeOptions = '';
      for (const pair of options.envPairs) {
        const name = String(pair).split('=', 1)[0];
        if (name === 'NODE_OPTIONS') nodeOptions = String(pair).slice(name.length + 1);
        else if (!name.startsWith('BENCH_FAKE_CLOCK_')) kept.push(pair);
      }
      if (!nodeOptions.includes(SHIM_URL)) nodeOptions = `${nodeOptions} ${importFlag}`.trim();
      kept.push(
        `NODE_OPTIONS=${nodeOptions}`,
        `BENCH_FAKE_CLOCK_SOCKET=${socketPath}`,
        `BENCH_FAKE_CLOCK_START=${Math.floor(now())}`,
      );
      options.envPairs = kept;
    }
    const startedAt = Math.floor(now());
    const r = realSpawn.call(this, options);
    if (this.pid) {
      const key = `p:${this.pid}`;
      send({ op: 'expect', key, now: startedAt });
      this.once('exit', () => send({ op: 'unexpect', key }));
    }
    return r;
  };

  syncBuiltinESMExports();
}
