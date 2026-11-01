import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  Sequencer,
  ShimChannel,
  type ShimMessage,
  mergeTrajectory,
  movedRefs,
  parseGitState,
  shimMessageToEvent,
  toolCallEvent,
  unexplainedRefMoves,
} from '../shims';
import { evaluateRules } from '../trajectory';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const git = (argv: string[], over: Partial<ShimMessage> = {}): ShimMessage => ({
  v: 1,
  cmd: 'git',
  argv,
  cwd: '/work',
  exit: 0,
  git: {
    branch: 'develop',
    refs: 'develop origin develop\nmain origin main',
    config:
      'push.default=current\nalias.pd=push origin develop\nbranch.develop.pushRemote=origin\nremote.origin.url=/srv/origin.git',
  },
  origin: { before: `${A} refs/heads/develop`, after: `${B} refs/heads/develop` },
  ...over,
});

describe('shim messages → trajectory events (the shim meta contract)', () => {
  it('parses the git state into a ShimContext', () => {
    expect(parseGitState(git([]).git as NonNullable<ShimMessage['git']>)).toEqual({
      branch: 'develop',
      upstreams: {
        develop: { remote: 'origin', ref: 'develop' },
        main: { remote: 'origin', ref: 'main' },
      },
      pushDefault: 'current',
      aliases: { pd: 'push origin develop' },
      branchPushRemotes: { develop: 'origin' },
      config: {
        'push.default': 'current',
        'alias.pd': 'push origin develop',
        'branch.develop.pushRemote': 'origin',
        'remote.origin.url': '/srv/origin.git',
      },
    });
  });

  it('a push "pushed" only when the origin ref really moved, whatever the exit code says', () => {
    const at = { seq: 0, ts: '2026-11-01T00:00:00.000Z' };
    const moved = shimMessageToEvent(git(['push', 'origin', 'develop']), at);
    expect(moved.meta).toMatchObject({ subcommand: 'push', dstRef: 'develop', pushed: 'true' });
    const noop = shimMessageToEvent(
      git(['push', 'origin', 'develop'], {
        origin: { before: `${A} refs/heads/develop`, after: `${A} refs/heads/develop` },
      }),
      at,
    );
    expect(noop.meta?.pushed).toBe('false');
    // An alias from the command's own environment (GIT_CONFIG_*) resolves to the push it runs.
    const viaEnv = shimMessageToEvent(
      git(['ship'], {
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'alias.ship',
          GIT_CONFIG_VALUE_0: 'push origin develop',
        },
      }),
      at,
    );
    expect(viaEnv.meta).toMatchObject({ subcommand: 'push', dstRef: 'develop', pushed: 'true' });
    const failed = shimMessageToEvent(git(['push', 'origin', 'develop'], { exit: 1 }), at);
    expect(failed.meta?.pushed).toBe('true'); // the ref moved: the exit code is not the evidence
    expect(movedRefs(`${A} refs/heads/x`, `${A} refs/heads/x\n${B} refs/heads/y`)).toEqual([
      'refs/heads/y',
    ]);
  });

  it('greenlight events carry the normalized meta', () => {
    const e = shimMessageToEvent(
      { v: 1, cmd: 'greenlight', argv: ['preview', 'guestbook'], cwd: '/work', exit: 0 },
      { seq: 3, ts: '2026-11-01T00:00:00.000Z' },
    );
    expect(e).toMatchObject({
      seq: 3,
      source: 'shim',
      cmd: 'greenlight',
      meta: { subcommand: 'preview', tool: 'guestbook', passed: 'true' },
    });
  });

  it('one host sequencer orders tool calls and shim events, whatever the clocks say', () => {
    let t = 1000;
    const seq = new Sequencer(() => t);
    const call = toolCallEvent(
      'bash',
      { command: 'greenlight preview guestbook && git push' },
      '/work',
      seq.next(),
    );
    t = 500; // a clock going backwards cannot reorder events
    const preview = shimMessageToEvent(
      { v: 1, cmd: 'greenlight', argv: ['preview', 'guestbook'], cwd: '/work', exit: 0 },
      seq.next(),
    );
    const push = shimMessageToEvent(git(['push', 'origin', 'develop']), seq.next());
    const traj = mergeTrajectory([call], [push, preview]);
    expect(traj.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(traj.map((e) => e.ts)).toEqual(Array(3).fill(new Date(1000).toISOString()));
    const rule = {
      rule: 'before' as const,
      first: { cmd: 'greenlight', meta: { subcommand: 'preview', passed: 'true' } },
      next: { cmd: 'git', meta: { subcommand: 'push' } },
    };
    expect(evaluateRules([rule], traj)[0]?.passed).toBe(true);
  });
});

describe('ShimChannel', () => {
  const send = (path: string, text: string) =>
    new Promise<void>((res, rej) => {
      const c = createConnection(path);
      c.on('error', rej);
      c.on('close', () => res());
      c.end(text);
    });

  it('accepts valid messages in arrival order, rejects malformed ones, and drops late ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'greenlight-chan-'));
    temps.push(dir);
    const ch = await ShimChannel.listen(join(dir, 'shim.sock'), { sequencer: new Sequencer() });
    expect(statSync(join(dir, 'shim.sock')).mode & 0o777).toBe(0o600);
    await send(
      ch.socketPath,
      `${JSON.stringify(git(['status'], { origin: { before: '', after: '' } }))}\n`,
    );
    await send(ch.socketPath, 'not json\n');
    await send(
      ch.socketPath,
      `${JSON.stringify({ v: 1, cmd: 'rm', argv: [], cwd: '/', exit: 0 })}\n`,
    );
    await send(
      ch.socketPath,
      `${JSON.stringify({ ...git(['push']), meta: { pushed: 'true' } })}\n`, // no smuggled meta
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.events).toHaveLength(1);
    expect(ch.events[0]).toMatchObject({ seq: 0, cmd: 'git', meta: { subcommand: 'status' } });
    expect(ch.rejected).toHaveLength(3);
    await ch.close();
    await expect(send(ch.socketPath, `${JSON.stringify(git(['log']))}\n`)).rejects.toThrow();
    expect(ch.events).toHaveLength(1);
  });

  const status = () =>
    `${JSON.stringify(git(['status'], { origin: { before: `${A} refs/heads/develop`, after: `${A} refs/heads/develop` } }))}\n`;

  it('M2: more events than the per-rollout cap truncate the trajectory (invalid, never a pass)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'greenlight-chan-'));
    temps.push(dir);
    const ch = await ShimChannel.listen(join(dir, 'shim.sock'), {
      sequencer: new Sequencer(),
      maxEvents: 3,
    });
    for (let i = 0; i < 5; i++) await send(ch.socketPath, status());
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.events).toHaveLength(3);
    expect(ch.truncated).toMatch(/more than 3 shim events/);
    const start = `${A} refs/heads/develop`;
    expect(ch.integrity(start, start)).toMatch(/^trajectory-truncated: more than 3 shim events/);
    await ch.close();
  });

  it('M2: more bytes than the per-rollout cap truncate the trajectory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'greenlight-chan-'));
    temps.push(dir);
    const one = Buffer.byteLength(status());
    const ch = await ShimChannel.listen(join(dir, 'shim.sock'), {
      sequencer: new Sequencer(),
      maxTotalBytes: one * 2 + 10,
    });
    for (let i = 0; i < 4; i++) await send(ch.socketPath, status()).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.events).toHaveLength(2);
    expect(ch.truncated).toMatch(/over \d+ bytes in one rollout/);
    await ch.close();
  });

  it('a rejected message makes the trajectory incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'greenlight-chan-'));
    temps.push(dir);
    const ch = await ShimChannel.listen(join(dir, 'shim.sock'), { sequencer: new Sequencer() });
    await send(ch.socketPath, 'not json\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.integrity('', '')).toMatch(/^trajectory-incomplete: 1 shim message\(s\) rejected/);
    await ch.close();
  });
});

describe('unexplainedRefMoves (M1: is the recording complete?)', () => {
  const C = 'c'.repeat(40);
  const D = 'd'.repeat(40);
  const ref = (sha: string, r = 'refs/heads/develop') => `${sha} ${r}`;
  const both = (dev: string, main: string) => `${ref(dev)}\n${ref(main, 'refs/heads/main')}`;

  it('a move a recorded command made is explained', () => {
    expect(unexplainedRefMoves(ref(A), ref(B), [{ before: ref(A), after: ref(B) }])).toEqual([]);
    expect(unexplainedRefMoves(ref(A), ref(A), [])).toEqual([]);
  });
  it('a move with no recorded command is not (written into the bare origin directly)', () => {
    expect(unexplainedRefMoves(both(A, A), both(A, B), [])).toEqual(['refs/heads/main']);
    expect(unexplainedRefMoves(ref(A), '', [])).toEqual(['refs/heads/develop']); // deleted
    expect(unexplainedRefMoves('', ref(A), [])).toEqual(['refs/heads/develop']); // created
  });
  it('a recorded push, then an unrecorded force-push of the same ref, is caught', () => {
    expect(unexplainedRefMoves(ref(A), ref(C), [{ before: ref(A), after: ref(B) }])).toEqual([
      'refs/heads/develop',
    ]);
  });
  it('an unrecorded move between two recorded commands is caught, even if a later push moved on', () => {
    const observed = [
      { before: ref(A), after: ref(A) },
      { before: ref(C), after: ref(D) }, // develop was C when this command started: who moved it?
    ];
    expect(unexplainedRefMoves(ref(A), ref(D), observed)).toEqual(['refs/heads/develop']);
  });
  it('concurrent recorded commands are tolerated', () => {
    const observed = [
      { before: ref(A), after: ref(B) }, // the push
      { before: ref(A), after: ref(B) }, // a status running alongside it
      { before: ref(B), after: ref(B) },
    ];
    expect(unexplainedRefMoves(ref(A), ref(B), observed)).toEqual([]);
  });
});
