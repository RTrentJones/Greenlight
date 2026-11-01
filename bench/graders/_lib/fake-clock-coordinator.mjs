/**
 * The grader's end of fake-clock-shim.mjs (hidden, grader-side): one simulated clock shared by
 * every thread of every Node process the app runs, served over a unix socket in a fresh temp dir.
 *
 * Every process / worker that loads the shim connects as a PARTICIPANT. `advance(to)` moves all
 * of them to `to` together: each fires its own timers due by then, in due order, and settles;
 * a participant that starts during the step (a child spawned by a timer, a new worker) is
 * waited for (its parent announced it with `expect`), starts at its parent's simulated time and
 * is advanced to `to` as well. A participant that does not answer in `answerTimeoutMs` (a thread
 * busy-waiting on the clock, say) makes `advance` throw: the grader then fails the window,
 * because time did not pass for that participant.
 *
 * The socket path is the only thing handed to the app (in BENCH_FAKE_CLOCK_SOCKET): no secret,
 * nothing about the task.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realNow = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startClockCoordinator({
  start,
  answerTimeoutMs = 10_000,
  joinTimeoutMs = 5000,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-clock-'));
  const socketPath = join(dir, 'clock.sock');
  let committed = start;
  let committedAt = realNow();
  const current = () => committed + (realNow() - committedAt);
  const participants = new Set();
  /** key -> { now, deadline } : a child / worker announced by its parent, not yet joined. */
  const expects = new Map();
  let nextId = 1;
  let joined = 0;
  const problems = [];

  const server = createServer((sock) => {
    const p = { sock, keys: [], welcomed: false, next: null, waiting: new Map(), gone: false };
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        onMessage(p, msg);
      }
    });
    const drop = () => {
      if (p.gone) return;
      p.gone = true;
      participants.delete(p);
      for (const resolve of p.waiting.values()) resolve(null);
      p.waiting.clear();
    };
    sock.on('close', drop);
    sock.on('error', drop);
  });
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(socketPath, res);
  });
  // The app may run as another uid than the grader (the bench grading container runs agent code
  // as the unprivileged agent user): let it reach the socket, and nothing else in the dir.
  chmodSync(dir, 0o711);
  chmodSync(socketPath, 0o666);

  const write = (p, msg) => {
    if (!p.gone) p.sock.write(`${JSON.stringify(msg)}\n`);
  };

  function onMessage(p, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.op) {
      case 'hello': {
        p.keys = Array.isArray(msg.keys) ? msg.keys.map(String) : [];
        let at = current();
        for (const k of p.keys) {
          const e = expects.get(k);
          if (e) {
            at = e.now;
            expects.delete(k);
            break;
          }
        }
        p.welcomed = true;
        participants.add(p);
        joined++;
        write(p, { op: 'welcome', now: at });
        break;
      }
      case 'next':
        p.next = typeof msg.next === 'number' ? msg.next : null;
        break;
      case 'expect':
        if (typeof msg.key === 'string' && Number.isFinite(msg.now)) {
          expects.set(msg.key, { now: msg.now, deadline: realNow() + joinTimeoutMs });
        }
        break;
      case 'unexpect':
        expects.delete(String(msg.key));
        break;
      case 'advanced': {
        const resolve = p.waiting.get(msg.id);
        p.waiting.delete(msg.id);
        if (typeof msg.next === 'number' || msg.next === null) p.next = msg.next;
        resolve?.(msg);
        break;
      }
    }
  }

  function ask(p, to) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        p.waiting.delete(id);
        reject(
          new Error(
            `clock participant ${p.keys[0] ?? '?'} did not finish a step in ${answerTimeoutMs} ms`,
          ),
        );
      }, answerTimeoutMs);
      p.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      write(p, { op: 'advance', id, to });
    });
  }

  /** Waits until every announced child / worker has joined, exited, or timed out. */
  async function waitForJoins() {
    for (;;) {
      const t = realNow();
      for (const [k, e] of expects) {
        if (e.deadline <= t) {
          expects.delete(k);
          problems.push(`${k} was announced but never joined the clock`);
        }
      }
      if (expects.size === 0) return;
      await sleep(5);
    }
  }

  async function advance(to) {
    await waitForJoins();
    const done = new Set();
    for (let round = 0; round < 100; round++) {
      const targets = [...participants].filter((p) => p.welcomed && !done.has(p));
      if (targets.length === 0) break;
      await Promise.all(targets.map((p) => ask(p, to)));
      for (const p of targets) done.add(p);
      await waitForJoins();
    }
    committed = Math.max(committed, to);
    committedAt = realNow();
    return state();
  }

  function state() {
    let next = null;
    for (const p of participants) {
      if (p.next !== null && (next === null || p.next < next)) next = p.next;
    }
    return { now: Math.floor(current()), next, participants: participants.size };
  }

  return {
    socketPath,
    /** The clock channel for a process that preloads the shim (spawnApp `preload`, which puts
     * it in NODE_OPTIONS so everything the app starts loads it too). */
    env: () => ({
      BENCH_FAKE_CLOCK_SOCKET: socketPath,
      BENCH_FAKE_CLOCK_START: String(Math.floor(current())),
    }),
    async waitForParticipant(timeoutMs = 5000) {
      const deadline = realNow() + timeoutMs;
      while (participants.size === 0) {
        if (realNow() > deadline) throw new Error(`no process joined the clock in ${timeoutMs} ms`);
        await sleep(5);
      }
      await waitForJoins();
      return state();
    },
    advance,
    state,
    /** How many participants have joined so far (processes and threads). */
    joined: () => joined,
    problems: () => [...problems],
    async stop() {
      for (const p of participants) p.sock.destroy();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
