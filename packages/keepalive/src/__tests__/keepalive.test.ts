import { describe, expect, it, vi } from 'vitest';
import {
  type KeepaliveResult,
  type SupabaseTarget,
  alertGithubIssue,
  parseTargets,
  pingTarget,
  runKeepalive,
} from '../index';

const target: SupabaseTarget = {
  name: 'heistmind',
  env: 'prod',
  url: 'https://abc.supabase.co',
  anonKey: 'anon-key',
};

/** A fetch double that records each call's url + init and returns the given status. */
function capturingFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const headersOf = (init: RequestInit | undefined) =>
  (init?.headers ?? {}) as Record<string, string>;

describe('pingTarget', () => {
  it('is ok on a 2xx and sends the apikey + bearer to the probe path', async () => {
    const { fn, calls } = capturingFetch(200);
    const r = await pingTarget(target, fn);
    expect(r).toEqual({ target: 'heistmind:prod', ok: true, status: 200 });
    expect(calls[0]?.url).toBe('https://abc.supabase.co/rest/v1/');
    expect(headersOf(calls[0]?.init).apikey).toBe('anon-key');
    expect(headersOf(calls[0]?.init).Authorization).toBe('Bearer anon-key');
  });

  it('is not ok on a 5xx (a paused/broken project)', async () => {
    const r = await pingTarget(target, capturingFetch(503).fn);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it('is not ok (captures error) when fetch throws', async () => {
    const f = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await pingTarget(target, f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network down');
  });

  it('honours a custom probePath and trims trailing slashes', async () => {
    const { fn, calls } = capturingFetch(200);
    await pingTarget(
      { ...target, url: 'https://abc.supabase.co/', probePath: '/rest/v1/games?limit=1' },
      fn,
    );
    expect(calls[0]?.url).toBe('https://abc.supabase.co/rest/v1/games?limit=1');
  });
});

describe('runKeepalive', () => {
  it('pings every target', async () => {
    const results = await runKeepalive(
      [target, { ...target, env: 'beta' }],
      capturingFetch(200).fn,
    );
    expect(results.map((r) => r.target)).toEqual(['heistmind:prod', 'heistmind:beta']);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('alertGithubIssue', () => {
  const failures: KeepaliveResult[] = [{ target: 'heistmind:prod', ok: false, status: 503 }];

  it('no-ops when there are no failures', async () => {
    const { fn, calls } = capturingFetch();
    const sent = await alertGithubIssue({ githubRepo: 'o/r', githubToken: 't' }, [], fn);
    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('no-ops when the sink is not configured', async () => {
    const { fn, calls } = capturingFetch();
    const sent = await alertGithubIssue({}, failures, fn);
    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('opens an issue on the right repo with the failures in the body', async () => {
    const { fn, calls } = capturingFetch(201);
    const sent = await alertGithubIssue({ githubRepo: 'o/r', githubToken: 'tok' }, failures, fn);
    expect(sent).toBe(true);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/issues');
    expect(calls[0]?.init.method).toBe('POST');
    expect(headersOf(calls[0]?.init).Authorization).toBe('Bearer tok');
    const payload = JSON.parse((calls[0]?.init.body as string) ?? '{}');
    expect(payload.title).toContain('1 Supabase target(s) failing');
    expect(payload.body).toContain('heistmind:prod');
  });
});

describe('parseTargets', () => {
  it('parses a JSON array', () => {
    expect(parseTargets(JSON.stringify([target]))).toHaveLength(1);
  });
  it('returns [] for undefined or bad JSON', () => {
    expect(parseTargets(undefined)).toEqual([]);
    expect(parseTargets('not json')).toEqual([]);
    expect(parseTargets('{"not":"array"}')).toEqual([]);
  });
});
