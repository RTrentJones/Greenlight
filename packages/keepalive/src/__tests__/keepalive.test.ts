import { describe, expect, it, vi } from 'vitest';
import {
  type KeepaliveResult,
  type KeepaliveTarget,
  alertGithubIssue,
  dispatchRemediation,
  parseTargets,
  pingTarget,
  runKeepalive,
} from '../index';

const target: KeepaliveTarget = {
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
    expect(r).toEqual({
      target: 'heistmind:prod',
      name: 'heistmind',
      env: 'prod',
      ok: true,
      status: 200,
    });
    expect(calls[0]?.url).toBe('https://abc.supabase.co/rest/v1/');
    expect(headersOf(calls[0]?.init).apikey).toBe('anon-key');
    expect(headersOf(calls[0]?.init).Authorization).toBe('Bearer anon-key');
  });

  it('keeps the supabase probe READ-ONLY — a plain GET, no method/body (invariant)', async () => {
    const { fn, calls } = capturingFetch(200);
    await pingTarget(target, fn);
    // Never write/INSERT: resetting the idle timer needs only a read. A body/method here would
    // mutate the user's DB on every cron tick.
    expect(calls[0]?.init.method).toBeUndefined();
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('is not ok on a 5xx (a paused/broken project)', async () => {
    const r = await pingTarget(target, capturingFetch(503).fn);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it('treats a 401 as alive (the project responded = pause reset)', async () => {
    const r = await pingTarget(target, capturingFetch(401).fn);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(401);
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

  it('oci kind does a plain health GET (no auth header, default path /)', async () => {
    const { fn, calls } = capturingFetch(200);
    const r = await pingTarget(
      { name: 'bamcp', env: 'prod', url: 'https://bamcp.example.dev', kind: 'oci' },
      fn,
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://bamcp.example.dev/');
    expect(calls[0]?.init.headers).toBeUndefined();
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
    expect(payload.title).toContain('1 target(s) failing');
    expect(payload.body).toContain('heistmind:prod');
  });
});

describe('dispatchRemediation', () => {
  const ociDown: KeepaliveResult = {
    target: 'bamcp:prod',
    name: 'bamcp',
    env: 'prod',
    remediate: true,
    ok: false,
    status: 503,
  };

  it('no-ops (returns 0) when the dispatch sink is not configured', async () => {
    const { fn, calls } = capturingFetch();
    expect(await dispatchRemediation({}, [ociDown], fn)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does not fire for failures that did not opt into remediation', async () => {
    const { fn, calls } = capturingFetch(201);
    const notOptedIn: KeepaliveResult = { target: 'x:prod', name: 'x', env: 'prod', ok: false };
    const fired = await dispatchRemediation(
      { dispatchRepo: 'o/r', githubToken: 't' },
      [notOptedIn],
      fn,
    );
    expect(fired).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('fires a repository_dispatch (event_type remediate-<tool>, payload tool/env/reason)', async () => {
    const { fn, calls } = capturingFetch(201);
    const fired = await dispatchRemediation(
      { dispatchRepo: 'o/r', githubToken: 'tok' },
      [ociDown],
      fn,
    );
    expect(fired).toBe(1);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/dispatches');
    expect(calls[0]?.init.method).toBe('POST');
    expect(headersOf(calls[0]?.init).Authorization).toBe('Bearer tok');
    const payload = JSON.parse((calls[0]?.init.body as string) ?? '{}');
    expect(payload.event_type).toBe('remediate-bamcp');
    expect(payload.client_payload).toEqual({ tool: 'bamcp', env: 'prod', reason: 503 });
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
