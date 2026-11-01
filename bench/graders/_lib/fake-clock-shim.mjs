/**
 * Fake-clock shim, preloaded into the agent's app with `node --import` (hidden, grader-side).
 *
 * The idle-window grader simulates ten minutes in a few real seconds. Real timers would make an
 * app's `setInterval(poll, 30_000)` (the real Polyphony cadence) fire zero times in that window
 * and pass, so the app runs on this clock instead:
 *
 * - `setTimeout` / `setInterval` (global, `node:timers`, `node:timers/promises`, `scheduler.wait`)
 *   and `Date` / `Date.now()` follow a simulated clock (`setImmediate` and `process.nextTick`
 *   take no time and stay real);
 * - between grader steps the clock flows at real speed (so a short `await sleep(10)` in a request
 *   handler still resolves);
 * - the grader advances it over IPC: `{ __fakeClock: 'advance', id, to }` fires every timer due at
 *   or before `to` in due order, the clock pinned at each timer's due time, waits for the work it
 *   starts (in-flight `fetch`es) to settle, and replies `{ __fakeClock: 'advanced', id, now, next }`
 *   (`next`: the earliest pending due time, or null). Intervals fire once per period, as a real
 *   process left running for that long would.
 *
 * Inert unless the process has an IPC channel and BENCH_FAKE_CLOCK_START (epoch ms) is set.
 * Known limits: `performance.now()`/`process.hrtime()` stay real, and code that defeats the shim
 * on purpose (detecting it, or scheduling through a native addon) is out of scope; the sandbox,
 * not this shim, is the isolation boundary.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';

const KEY = Symbol.for('greenlight.bench.fakeClock');
const START = Number(process.env.BENCH_FAKE_CLOCK_START);

if (!globalThis[KEY] && typeof process.send === 'function' && Number.isFinite(START)) {
  globalThis[KEY] = true;
  Reflect.deleteProperty(process.env, 'BENCH_FAKE_CLOCK_START');
  install(START);
}

function install(start) {
  const require = createRequire(import.meta.url);
  const timers = require('node:timers');
  const timersPromises = require('node:timers/promises');
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setImmediate: globalThis.setImmediate,
    Date: globalThis.Date,
    perf: performance.now.bind(performance),
    fetch: globalThis.fetch,
  };
  const realStart = real.perf();
  let jumped = 0;
  let pinned = null;
  let advancing = false;
  const flowing = () => start + (real.perf() - realStart) + jumped;
  const now = () => pinned ?? flowing();

  // ---- timers ------------------------------------------------------------------------------
  let seq = 1;
  const pending = new Map(); // id -> { id, due, fn, args, interval, order }
  let order = 0;
  let driver = null;

  class FakeTimeout {
    constructor(id, ms) {
      this._id = id;
      this._ms = ms;
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
    hasRef() {
      return true;
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
    pending.set(id, { id, due: now() + d, fn, args, interval: interval ? d : 0, order: order++ });
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
  /** Keeps one real timer armed for the earliest fake timer (real-speed flow between steps). */
  function arm() {
    if (driver) real.clearTimeout(driver);
    driver = null;
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
    driver.unref?.();
  }

  const fakeSetTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
  const fakeSetInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
  const promisified = (ms, value, opts = {}) =>
    new Promise((resolve, reject) => {
      if (opts?.signal?.aborted) return reject(opts.signal.reason);
      const h = fakeSetTimeout(() => resolve(value), ms);
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
  syncBuiltinESMExports();

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

  // ---- grader control ----------------------------------------------------------------------
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
    return { now: Math.floor(now()), next: earliest()?.due ?? null };
  }

  let chain = Promise.resolve();
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.__fakeClock !== 'string') return;
    chain = chain.then(async () => {
      const r =
        msg.__fakeClock === 'advance'
          ? await advance(Number(msg.to))
          : { now: Math.floor(now()), next: earliest()?.due ?? null };
      process.send?.({ __fakeClock: 'advanced', id: msg.id, ...r });
    });
  });
  // Keep the IPC channel from holding the app open on its own.
  process.channel?.unref?.();
}
