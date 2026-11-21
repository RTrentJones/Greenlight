/**
 * A port for the app a grader is about to start (hidden, grader-side), reserved so that nothing
 * else on the machine can end up listening on it.
 *
 * The app is told its port (`PORT`) before it binds it, so the number has to be chosen first.
 * Choosing it the usual way (bind port 0, read the number, close) leaves it up for grabs until
 * the app has booted: any `listen(0)` on the machine (another grading's fake store or stub
 * origin, another grading's own port pick) and any outgoing connection can be assigned that very
 * number in between. The app then dies on EADDRINUSE while the stranger answers the grader's
 * readiness poll, and the grader goes on to grade the stranger: a stub that answers 200 to
 * everything passes the liveness checks, makes no store query, and fails only the checks that
 * need the real app (seen as a mutant failing `/health still reports the database` alone, with
 * `up: 200 (0 query), stopped: 200`).
 *
 * So the port is taken where the kernel never assigns one by itself (outside the ephemeral
 * range), and it is claimed against every other grading on the machine by holding its GUARD port
 * (`port + zone.size`) bound for as long as the reservation lives. Binding is atomic, and the
 * kernel drops the claim when the grader process dies, however it dies: no lock file to go
 * stale. Whoever holds the guard owns the port; the port itself stays unbound, for the app.
 *
 * When no port can be reserved, `reserveAppPort` throws `AppPortError`, a HARNESS error
 * (`harness: true`): the grader lets it propagate (a grader error, never a failing check),
 * because nothing was learnt about the app.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

export class AppPortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppPortError';
    this.harness = true;
  }
}

/** Binds `port` and resolves the listening server, or null when the port is taken. With no
 * `host` it binds the wildcard address, as an app's `server.listen(port)` does, so a holder on
 * any local address counts. */
function bindPort(port, host) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', (e) =>
      e?.code === 'EADDRINUSE' || e?.code === 'EACCES' ? resolve(null) : reject(e),
    );
    const onListening = () => {
      srv.unref();
      resolve(srv);
    };
    if (host === undefined) srv.listen(port, onListening);
    else srv.listen(port, host, onListening);
  });
}

const closeServer = (srv) => new Promise((r) => srv.close(() => r()));

/** The range the kernel assigns ports from for `listen(0)` and outgoing connections, inclusive.
 * Linux says; elsewhere, Linux's default and the IANA dynamic range together (a superset). */
export function ephemeralPortRange() {
  try {
    const [lo, hi] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    if (Number.isInteger(lo) && Number.isInteger(hi) && lo > 0 && lo <= hi) return [lo, hi];
  } catch {
    // not Linux
  }
  return [32_768, 65_535];
}

/** The zone app ports come from, `{ start, size }`: `size` app ports from `start`, each paired
 * with the guard port `size` above it. It is the larger run of unprivileged ports on either side
 * of the ephemeral range, split in two halves; null when neither run is worth using. */
export function defaultAppPortZone() {
  const [lo, hi] = ephemeralPortRange();
  const below = { from: 10_240, to: Math.min(lo, 65_536) };
  const above = { from: Math.max(hi + 1, 10_240), to: 65_536 };
  const best = below.to - below.from >= above.to - above.from ? below : above;
  const size = Math.floor((best.to - best.from) / 2);
  return size >= 64 ? { start: best.from, size } : null;
}

/**
 * Reserves a port for an app: `{ port, release() }`. The reservation lasts until `release()` (or
 * the end of the process). The port is free when this returns, and stays the caller's: no other
 * reservation gets it, and the kernel hands it to nobody. `zone` is for tests.
 */
export async function reserveAppPort({ zone = defaultAppPortZone() } = {}) {
  if (!zone) {
    throw new AppPortError(
      'no run of ports outside the ephemeral range to reserve an app port from',
    );
  }
  const first = Math.floor(Math.random() * zone.size);
  for (let i = 0; i < zone.size; i++) {
    const port = zone.start + ((first + i) % zone.size);
    const guard = await bindPort(port + zone.size, '127.0.0.1');
    if (!guard) continue; // another grading owns this port (or something sits on its guard)
    const probe = await bindPort(port);
    if (probe) {
      await closeServer(probe);
      let released = false;
      return {
        port,
        release: async () => {
          if (released) return;
          released = true;
          await closeServer(guard);
        },
      };
    }
    await closeServer(guard); // something outside the bench listens on the port itself
  }
  throw new AppPortError(
    `every app port in ${zone.start}..${zone.start + zone.size - 1} is reserved or in use`,
  );
}
