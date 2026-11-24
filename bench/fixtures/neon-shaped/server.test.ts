import { afterEach, describe, expect, it } from 'vitest';
import { MINUTE_MS, createClock, createNeonStore, start } from './server.mjs';

// Roadmap M1-03: the fake's query counting, suspension and awake-time accounting (15 §8.2).

function store() {
  const clock = createClock();
  return { clock, s: createNeonStore({ suspendAfterMs: 5 * MINUTE_MS }, { clock }) };
}

describe('neon-shaped fake: queries and suspension', () => {
  it('starts suspended and wakes on the first query', () => {
    const { s } = store();
    expect(s.suspended()).toBe(true);
    expect(s.query('SELECT 1', 'web')).toMatchObject({ status: 200 });
    expect(s.suspended()).toBe(false);
    expect(s.state.wakes).toBe(1);
  });

  it('suspends after the quiet window and counts a new wake', () => {
    const { s, clock } = store();
    s.query('SELECT 1');
    clock.advance(5 * MINUTE_MS - 1);
    expect(s.suspended()).toBe(false);
    clock.advance(1);
    expect(s.suspended()).toBe(true);
    s.query('SELECT 1');
    expect(s.state.wakes).toBe(2);
  });

  it('a query while awake extends the window without a new wake', () => {
    const { s, clock } = store();
    s.query('SELECT 1');
    clock.advance(4 * MINUTE_MS);
    s.query('SELECT 1');
    clock.advance(4 * MINUTE_MS);
    expect(s.suspended()).toBe(false);
    expect(s.state.wakes).toBe(1);
  });

  it('reports awake time over a window, clipped to it and to now', () => {
    const { s, clock } = store();
    const t0 = clock.now();
    s.query('SELECT 1'); // awake [t0, t0+5m)
    clock.advance(20 * MINUTE_MS);
    s.query('SELECT 1'); // awake [t0+20m, t0+25m)
    clock.advance(2 * MINUTE_MS);
    expect(s.awakeMs(t0, t0 + 30 * MINUTE_MS)).toBe(7 * MINUTE_MS);
    expect(s.awakeMs(t0 + 3 * MINUTE_MS, t0 + 21 * MINUTE_MS)).toBe(3 * MINUTE_MS);
  });

  it('a 2-second poll over a 10-minute window keeps the compute awake the whole time', () => {
    const { s, clock } = store();
    const t0 = clock.now();
    for (let t = 0; t < 10 * MINUTE_MS; t += 2000) {
      s.query('SELECT id FROM jobs', 'worker');
      clock.advance(2000);
    }
    const st = s.stats({ from: t0, to: t0 + 10 * MINUTE_MS });
    expect(st.queries).toBe(300);
    expect(st.byApp).toEqual({ worker: 300 });
    expect(st.awakeMs).toBe(10 * MINUTE_MS);
    expect(st.suspended).toBe(false);
  });

  it('counts per application_name and filters by window', () => {
    const { s, clock } = store();
    s.query('SELECT 1', 'boot');
    clock.advance(MINUTE_MS);
    const t1 = clock.now();
    s.query('SELECT 1', 'health');
    s.query('SELECT 1', 'health');
    expect(s.stats({ from: t1 }).byApp).toEqual({ health: 2 });
    expect(s.stats().totalQueries).toBe(3);
  });

  it('refuses queries while stopped and does not count them', () => {
    const { s } = store();
    s.setStopped(true);
    expect(s.query('SELECT 1').status).toBe(503);
    expect(s.state.queries).toBe(0);
    expect(s.state.refused).toBe(1);
    expect(s.suspended()).toBe(true);
  });

  it("answers the fixture apps' query shapes", () => {
    const { s } = store();
    expect(s.query('SELECT 1').body.rows).toEqual([{ '?column?': 1 }]);
    expect(s.query("INSERT INTO jobs (prompt) VALUES ('x')").body.rowCount).toBe(1);
    expect(s.query('SELECT id FROM jobs').body.rows).toEqual([]);
    expect(s.query('').status).toBe(400);
  });
});

describe('neon-shaped fake over HTTP', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('runs SQL, records the origin header and guards control endpoints', async () => {
    const s = await start({ variant: 'train' });
    stop = s.stop;
    const r = await fetch(`${s.url}/sql`, {
      method: 'POST',
      headers: { 'x-application-name': 'scenesmith-health' },
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    expect(r.status).toBe(200);
    expect((await fetch(`${s.url}/__fake/stats`)).status).toBe(403);
    const adm = { 'x-fake-admin': s.adminToken };
    await fetch(`${s.url}/__fake/stop`, { method: 'POST', headers: adm, body: '{}' });
    const refused = await fetch(`${s.url}/sql`, {
      method: 'POST',
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    expect(refused.status).toBe(503);
    await fetch(`${s.url}/__fake/clock`, {
      method: 'POST',
      headers: adm,
      body: JSON.stringify({ advanceMs: 6 * MINUTE_MS }),
    });
    const st = await (await fetch(`${s.url}/__fake/stats`, { headers: adm })).json();
    expect(st).toMatchObject({
      queries: 1,
      refused: 1,
      suspended: true,
      stopped: true,
      byApp: { 'scenesmith-health': 1 },
    });
  });
});
