import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../api';
import { verify, verifyAll } from '../index';
import type { ApiSpec } from '../types';

let server: http.Server;
let base: string;
let flakyHits = 0; // 404 until the 2nd hit — exercises attempts counting through the settle loop
const order: string[] = []; // request arrival order — proves parallel specs overlap

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    order.push(url);
    if (url === '/flaky') {
      flakyHits += 1;
      res.writeHead(flakyHits >= 2 ? 200 : 404);
      res.end(flakyHits >= 2 ? 'ok' : 'not yet');
    } else if (url.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow ok');
      }, 150);
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => server.close());

describe('pool', () => {
  it('bounds in-flight tasks to the limit and preserves result order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return i;
    });
    const results = await pool(tasks, 4);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('handles more workers than tasks', async () => {
    expect(await pool([async () => 'a'], 8)).toEqual(['a']);
  });
});

describe('per-check metrics (M1)', () => {
  it('stamps durationMs and attempts=1 on a first-try pass', async () => {
    const report = await verify(base, {
      mode: 'api',
      checks: [{ path: '/', status: 200 }],
    });
    const check = report.checks[0];
    expect(check?.pass).toBe(true);
    expect(check?.attempts).toBe(1);
    expect(check?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts settle-loop re-runs in attempts (the flakiness signal)', async () => {
    flakyHits = 0;
    const report = await verify(base, {
      mode: 'api',
      checks: [{ path: '/flaky', status: 200 }],
      settleRetries: 3,
      settleMs: 10,
    });
    const check = report.checks[0];
    expect(check?.pass).toBe(true);
    expect(check?.attempts).toBe(2); // failed once, passed on the settle re-run
  });
});

describe('verifyAll concurrency (P2)', () => {
  it('overlaps adjacent parallel-marked specs (both start before either finishes)', async () => {
    order.length = 0;
    const specs: ApiSpec[] = [
      { mode: 'api', checks: [{ path: '/slow-a', status: 200 }], concurrency: 'parallel' },
      { mode: 'api', checks: [{ path: '/slow-b', status: 200 }], concurrency: 'parallel' },
    ];
    const reports = await verifyAll(base, specs);
    expect(reports.map((r) => r.pass)).toEqual([true, true]);
    // Serial execution would show /slow-a completing before /slow-b is requested; overlap means
    // both requests ARRIVED before either 150ms response fired.
    expect(order.slice(0, 2).sort()).toEqual(['/slow-a', '/slow-b']);
  });

  it('preserves report order and default-serial behavior', async () => {
    const specs: ApiSpec[] = [
      { mode: 'api', checks: [{ path: '/slow-a', status: 200 }] },
      { mode: 'api', checks: [{ path: '/', status: 200 }], concurrency: 'parallel' },
      { mode: 'api', checks: [{ path: '/slow-b', status: 200 }], concurrency: 'parallel' },
    ];
    const reports = await verifyAll(base, specs);
    expect(reports).toHaveLength(3);
    expect(reports[0]?.checks[0]?.name).toBe('GET /slow-a');
    expect(reports[1]?.checks[0]?.name).toBe('GET /');
    expect(reports[2]?.checks[0]?.name).toBe('GET /slow-b');
    expect(reports.every((r) => r.pass)).toBe(true);
  });
});
