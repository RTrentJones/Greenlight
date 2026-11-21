import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTasks, materialize } from '../check-graders';
import { type GraderContext, type SpawnAppOptions, createGraderContext } from '../grader-api';

// The port of the app under grading (bench/graders/_lib/app-port.mjs).
//
// The flake this pins: the app's port was picked by binding port 0 and closing it. Under a
// parallel `bench check-graders`, another grading's `listen(0)` (its stub origin, which answers
// 200 to everything) was now and then assigned that number before the app bound it. The app died
// on EADDRINUSE, the stub answered the readiness poll, and the mutant was graded on the stub:
// no store query, liveness 200, and only `/health still reports the database` failing
// (`up: 200 (0 query), stopped: 200`).

const here = dirname(new URL(import.meta.url).pathname);
const BENCH = join(here, '../../../../../bench');
const LIB = join(BENCH, 'graders/_lib');
const APP_PORT = join(LIB, 'app-port.mjs');

interface Reservation {
  port: number;
  release(): Promise<void>;
}
interface Zone {
  start: number;
  size: number;
}
interface AppPortLib {
  reserveAppPort(o?: { zone?: Zone | null }): Promise<Reservation>;
  ephemeralPortRange(): [number, number];
  defaultAppPortZone(): Zone | null;
}
const lib = (): Promise<AppPortLib> => import(APP_PORT);

const work = mkdtempSync(join(tmpdir(), 'app-port-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A listening server on `port`, or null when the port is taken. */
const listen = (port: number, host?: string) =>
  new Promise<Server | null>((res) => {
    const srv = createServer();
    srv.once('error', () => res(null));
    if (host) srv.listen(port, host, () => res(srv));
    else srv.listen(port, () => res(srv));
  });
const close = (srv: Server | null) => new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: Error & { harness?: boolean }) => e,
  );

describe('reserveAppPort', () => {
  it('reserves a free port that the kernel never assigns by itself', async () => {
    const { reserveAppPort, ephemeralPortRange } = await lib();
    const [lo, hi] = ephemeralPortRange();
    const r = await reserveAppPort();
    try {
      expect(r.port < lo || r.port > hi, `${r.port} is in ${lo}..${hi}`).toBe(true);
      expect(r.port).toBeGreaterThanOrEqual(10_240);
      // Left unbound, for the app.
      const app = await listen(r.port);
      expect(app).not.toBeNull();
      await close(app);
    } finally {
      await r.release();
    }
  });

  it('never hands one port to two gradings, in this process or another', async () => {
    const { reserveAppPort } = await lib();
    const many = await Promise.all(Array.from({ length: 24 }, () => reserveAppPort()));
    try {
      expect(new Set(many.map((r) => r.port)).size).toBe(many.length);
    } finally {
      await Promise.all(many.map((r) => r.release()));
    }

    // A zone of one port, held here: nobody else gets it until it is released.
    const probe = await reserveAppPort();
    await probe.release();
    const one = { zone: { start: probe.port, size: 1 } };
    const mine = await reserveAppPort(one);
    try {
      expect(mine.port).toBe(probe.port);
      const again = await failure(reserveAppPort(one));
      expect(again?.name).toBe('AppPortError');
      expect(again?.harness).toBe(true);
      const script = `import(${JSON.stringify(pathToFileURL(APP_PORT).href)}).then((m) => m.reserveAppPort(${JSON.stringify(one)})).then((r) => console.log('got ' + r.port), (e) => console.log(e.name + ' ' + e.harness));`;
      const other = await new Promise<string>((res) =>
        execFile(process.execPath, ['--input-type=module', '-e', script], (_e, out) => res(out)),
      );
      expect(other.trim()).toBe('AppPortError true');
    } finally {
      await mine.release();
    }
    const after = await reserveAppPort(one);
    expect(after.port).toBe(probe.port);
    await after.release();
  });

  it('skips a port something else already listens on', async () => {
    const { reserveAppPort } = await lib();
    const probe = await reserveAppPort();
    const start = probe.port;
    await probe.release();
    // Two app ports (start, start + 1), their guards two above.
    const squatter = await listen(start, '127.0.0.1');
    expect(squatter).not.toBeNull();
    try {
      for (let i = 0; i < 4; i++) {
        const r = await reserveAppPort({ zone: { start, size: 2 } });
        expect(r.port).toBe(start + 1);
        await r.release();
      }
    } finally {
      await close(squatter);
    }
  });

  it('is a harness error when there is nowhere to reserve from', async () => {
    const { reserveAppPort } = await lib();
    const err = await failure(reserveAppPort({ zone: null }));
    expect(err?.name).toBe('AppPortError');
    expect(err?.harness).toBe(true);
  });
});

describe('the idle-window grader starts the app on a reserved port', () => {
  const TASK = 'replay/idle-probe-leaves-store-asleep-train';

  it('holds the reservation for the whole grading, so no stranger can answer for the app', async () => {
    const { ephemeralPortRange, defaultAppPortZone } = await lib();
    const task = loadTasks(BENCH).tasks.find((t) => t.id === TASK);
    if (!task) throw new Error(`no task ${TASK}`);
    const dir = mkdtempSync(join(work, 'idle-'));
    const paths = materialize(BENCH, task, [join(BENCH, 'references', TASK)], dir);
    const { ctx, cleanup } = createGraderContext({
      taskId: TASK,
      benchDir: BENCH,
      graderPath: join(BENCH, 'graders', TASK, 'grade.mjs'),
      ...paths,
    });
    const seen: (number | undefined)[] = [];
    const spying: GraderContext = {
      ...ctx,
      spawnApp: (o: SpawnAppOptions) => {
        seen.push(o.port);
        return ctx.spawnApp(o);
      },
    };
    try {
      const { gradeNeonIdle } = await import(join(LIB, 'neon-idle.mjs'));
      const result = await gradeNeonIdle(spying, { variant: 'train' });
      expect(result.checks.filter((c: { passed: boolean }) => !c.passed)).toEqual([]);
      expect(seen).toHaveLength(1);
      // Before the fix the grader left the choice to spawnApp (no port): bind port 0, close, and
      // hope nobody is assigned the number before the app has booted.
      expect(seen[0], 'the grader reserves the port itself').toBeTypeOf('number');
      const port = seen[0] as number;
      const [lo, hi] = ephemeralPortRange();
      expect(port < lo || port > hi, `${port} is in ${lo}..${hi}`).toBe(true);
      // Its guard is held for as long as the grading lives ...
      const zone = defaultAppPortZone() as Zone;
      const guard = await listen(port + zone.size, '127.0.0.1');
      expect(guard, 'the guard port is still bound by the grading').toBeNull();
      await close(guard);
      await cleanup();
      // ... and is given back with it.
      const freed = await listen(port + zone.size, '127.0.0.1');
      expect(freed).not.toBeNull();
      await close(freed);
    } finally {
      await cleanup();
    }
  }, 30_000);
});
