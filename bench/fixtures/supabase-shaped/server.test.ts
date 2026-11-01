import { afterEach, describe, expect, it } from 'vitest';
import { DAY_MS, createClock, createSupabaseStore, loadVariant, start } from './server.mjs';

// Roadmap M1-03: the fake's idle and query accounting (vision 15 §8.2).

const config = loadVariant('train');
const KEY = { apikey: config.anonKey };

function store() {
  const clock = createClock();
  return { clock, s: createSupabaseStore(config, { clock }) };
}

describe('supabase-shaped fake: what counts as database activity', () => {
  it('answers the PostgREST root from the schema cache without a query', () => {
    const { s } = store();
    const r = s.handle('GET', '/rest/v1/', KEY);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).definitions).toHaveProperty('keepalive_probe');
    const snap = s.snapshot();
    expect(snap.queries).toBe(0);
    expect(snap.rootHits).toBe(1);
  });

  it('counts a table read as a query and resets the idle timer', () => {
    const { s, clock } = store();
    clock.advance(6 * DAY_MS);
    const r = s.handle('GET', '/rest/v1/keepalive_probe?select=id&limit=1', KEY);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([{ id: 1 }]);
    const snap = s.snapshot();
    expect(snap.queries).toBe(1);
    expect(snap.idleMs).toBe(0);
    expect(snap.log[0]).toMatchObject({ table: 'keepalive_probe', columns: ['id'], sensitive: [] });
  });

  it('records the sensitive columns a read returned', () => {
    const { s } = store();
    s.handle('GET', '/rest/v1/quizzes?limit=1', KEY);
    expect(s.snapshot().log[0].sensitive).toEqual(['owner_id']);
    s.handle('GET', '/rest/v1/quizzes?select=id&limit=1', KEY);
    expect(s.snapshot().log[1].sensitive).toEqual([]);
  });

  it('runs no query for refused requests', () => {
    const { s } = store();
    expect(s.handle('GET', '/rest/v1/keepalive_probe?select=id', {}).status).toBe(401);
    expect(s.handle('GET', '/rest/v1/profiles?select=id', KEY).status).toBe(401); // no anon grant
    expect(s.handle('GET', '/rest/v1/nope?select=id', KEY).status).toBe(404);
    expect(s.handle('GET', '/rest/v1/keepalive_probe?select=nope', KEY).status).toBe(400);
    // Unknown params are column filters, so cache-busting runs no query.
    expect(s.handle('GET', '/rest/v1/keepalive_probe?select=id&_=123', KEY).status).toBe(400);
    expect(
      s.handle('GET', '/rest/v1/keepalive_probe?select=id', { ...KEY, 'accept-profile': 'x' })
        .status,
    ).toBe(406);
    const snap = s.snapshot();
    expect(snap.queries).toBe(0);
    expect(snap.refused).toBe(6);
  });
});

describe('supabase-shaped fake: idle pause', () => {
  it('pauses after the idle limit of root-only traffic, and answers 530 from then on', () => {
    const { s, clock } = store();
    for (let d = 0; d < 7; d++) {
      expect(s.handle('GET', '/rest/v1/', KEY).status).toBe(200);
      clock.advance(DAY_MS);
    }
    const snap = s.snapshot();
    expect(snap.paused).toBe(true);
    expect(snap.pausedAt).toBe(new Date(createClock().now() + 7 * DAY_MS).toISOString());
    expect(s.handle('GET', '/rest/v1/keepalive_probe?select=id', KEY).status).toBe(530);
    expect(s.snapshot().pausedHits).toBe(1);
  });

  it('stays up while a table read lands inside every idle window', () => {
    const { s, clock } = store();
    for (let d = 0; d <= 30; d += 3) {
      expect(s.handle('GET', '/rest/v1/keepalive_probe?select=id', KEY).status).toBe(200);
      clock.advance(3 * DAY_MS);
    }
    expect(s.snapshot().paused).toBe(false);
  });

  it('pauses exactly at the limit, not before', () => {
    const { s, clock } = store();
    clock.advance(7 * DAY_MS - 1);
    expect(s.snapshot().paused).toBe(false);
    clock.advance(1);
    expect(s.snapshot().paused).toBe(true);
    s.restore();
    expect(s.snapshot().paused).toBe(false);
  });

  it('never runs the clock backwards', () => {
    const clock = createClock();
    expect(() => clock.advance(-1)).toThrow();
    expect(() => clock.set(clock.now() - 1)).toThrow();
  });
});

describe('supabase-shaped fake over HTTP', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('serves the store and guards introspection with the admin token', async () => {
    const s = await start({ variant: 'train' });
    stop = s.stop;
    const read = await fetch(`${s.url}/rest/v1/keepalive_probe?select=id&limit=1`, {
      headers: KEY,
    });
    expect(read.status).toBe(200);
    expect((await fetch(`${s.url}/__fake/idle`)).status).toBe(403);
    const adm = { 'x-fake-admin': s.adminToken };
    const idle = await (await fetch(`${s.url}/__fake/idle`, { headers: adm })).json();
    expect(idle).toMatchObject({ paused: false, queries: 1 });
    await fetch(`${s.url}/__fake/clock`, {
      method: 'POST',
      headers: adm,
      body: JSON.stringify({ advanceMs: 8 * DAY_MS }),
    });
    const after = await (await fetch(`${s.url}/__fake/idle`, { headers: adm })).json();
    expect(after.paused).toBe(true);
    expect(after.lastQueryAt).toBe(idle.lastQueryAt);
  });
});
