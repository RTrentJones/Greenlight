import type { Adapter } from '@rtrentjones/greenlight-adapters';
import type { VerifyReport } from '@rtrentjones/greenlight-verify';
import { describe, expect, it } from 'vitest';
import { type StageEvent, runShip } from '../ship';

const passReport = (url: string): VerifyReport => ({
  pass: true,
  mode: 'api',
  url,
  checks: [{ name: 'GET /', pass: true }],
});
const failReport = (url: string): VerifyReport => ({
  pass: false,
  mode: 'api',
  url,
  checks: [{ name: 'GET /', pass: false, detail: '500' }],
});

interface StubOpts {
  deployStyle?: 'push' | 'git';
  failBuild?: boolean;
  failDeploy?: boolean;
  withRollback?: boolean;
  rollbackOk?: boolean;
}

function stubAdapter(calls: string[], opts: StubOpts = {}): Adapter {
  return {
    target: 'workers',
    deployStyle: opts.deployStyle ?? 'push',
    build: async () => {
      calls.push('build');
      if (opts.failBuild) throw new Error('build exploded');
      return { artifactDir: '/tmp/x' };
    },
    deploy: async () => {
      calls.push('deploy');
      if (opts.failDeploy) throw new Error('deploy exploded');
      return { url: 'https://x.example.dev', previous: { versionId: 'prev-1' } };
    },
    url: () => 'https://x.example.dev',
    ...(opts.withRollback
      ? {
          rollback: async (_dir, _env, previous) => {
            calls.push(`rollback:${previous?.versionId}`);
            return {
              ok: opts.rollbackOk ?? true,
              detail: opts.rollbackOk === false ? 'no can do' : 'restored prev-1',
            };
          },
        }
      : {}),
  };
}

const base = (adapter: Adapter, verify: (url: string) => Promise<VerifyReport[]>) => ({
  adapter,
  toolDir: '.',
  tool: 'x',
  env: 'prod' as const,
  gitSha: 'abc1234',
  verify,
});

describe('runShip', () => {
  it('happy path: build → deploy → verify, stage events in order with the sha stamped', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls), async (url) => [passReport(url)]),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://x.example.dev');
    expect(calls).toEqual(['build', 'deploy']);
    expect(events.map((e) => e.stage)).toEqual(['build', 'deploy', 'verify']);
    expect(events.every((e) => e.gitSha === 'abc1234')).toBe(true);
    expect(events.every((e) => e.durationMs >= 0)).toBe(true);
    expect(events.every((e) => e.passed)).toBe(true);
  });

  it('verify failure triggers rollback with the previously-live version', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls, { withRollback: true }), async (url) => [failReport(url)]),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['build', 'deploy', 'rollback:prev-1']);
    expect(events.map((e) => e.stage)).toEqual(['build', 'deploy', 'verify', 'rollback']);
    expect(r.rollback?.ok).toBe(true);
  });

  it('--no-rollback (rollbackOnFailure:false) skips the reaction', async () => {
    const calls: string[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls, { withRollback: true }), async (url) => [failReport(url)]),
      rollbackOnFailure: false,
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['build', 'deploy']);
    expect(r.rollback).toBeUndefined();
  });

  it('an adapter without rollback fails cleanly with no rollback stage', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls), async (url) => [failReport(url)]),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.ok).toBe(false);
    expect(events.map((e) => e.stage)).toEqual(['build', 'deploy', 'verify']);
  });

  it('a git-style adapter skips build+deploy (recorded) and verifies the deterministic URL', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls, { deployStyle: 'git' }), async (url) => [passReport(url)]),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]); // build/deploy never invoked
    expect(events[0]?.stage).toBe('deploy');
    expect(events[0]?.detail).toMatch(/git integration/);
    expect(r.url).toBe('https://x.example.dev');
  });

  it('a build failure short-circuits (no deploy, no verify) and reports the error', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls, { failBuild: true }), async (url) => [passReport(url)]),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['build']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: 'build', passed: false });
    expect(events[0]?.detail).toMatch(/build exploded/);
  });

  it('a deploy failure short-circuits before verify', async () => {
    const calls: string[] = [];
    const r = await runShip(
      base(stubAdapter(calls, { failDeploy: true }), async (url) => [passReport(url)]),
    );
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['build', 'deploy']);
    expect(r.reports).toEqual([]);
  });

  it('a THROWING verify harness is a failed gate (rollback still runs), not a crashed ship', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls, { withRollback: true }), async () => {
        throw new Error('harness died');
      }),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.ok).toBe(false);
    expect(events.find((e) => e.stage === 'verify')).toMatchObject({ passed: false });
    expect(calls).toContain('rollback:prev-1');
  });

  it('a failed rollback is reported honestly on the event and result', async () => {
    const calls: string[] = [];
    const events: StageEvent[] = [];
    const r = await runShip({
      ...base(stubAdapter(calls, { withRollback: true, rollbackOk: false }), async (url) => [
        failReport(url),
      ]),
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(r.rollback).toMatchObject({ ok: false, detail: 'no can do' });
    expect(events.find((e) => e.stage === 'rollback')).toMatchObject({ passed: false });
  });

  it('stamps skillVersion on events when provided', async () => {
    const events: StageEvent[] = [];
    await runShip({
      ...base(stubAdapter([]), async (url) => [passReport(url)]),
      skillVersion: '2',
      onStage: (e) => {
        events.push(e);
      },
    });
    expect(events.every((e) => e.skillVersion === '2')).toBe(true);
  });
});
