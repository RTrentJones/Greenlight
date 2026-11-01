import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TrajectoryRuleSchema } from '../../schema/bench';
import type { TrajectoryEvent, TrajectoryRule } from '../../schema/bench';
import {
  type ShimContext,
  argsMatch,
  describeRule,
  evaluateRule,
  evaluateRules,
  matches,
  normalizeShimEvent,
  orderEvents,
  parseTrajectory,
} from '../trajectory';
import { type ShimScenario, buildTrajectory } from './shim-scenario';

// Vision 08 §10.2 (matcher + rule semantics), 06 §4.6, 13 §2.7 "trajectory grading".

let seq = 0;
const ev = (cmd: string, argv: string[], meta?: Record<string, string>): TrajectoryEvent => ({
  seq: seq++,
  ts: `2026-11-01T10:00:${String(seq).padStart(2, '0')}Z`,
  source: 'shim',
  cmd,
  argv,
  cwd: '/sandbox',
  exit: 0,
  ...(meta ? { meta } : {}),
});

/** The events renumbered in the order given (the evaluator orders by seq). */
/** The events renumbered (seq and ts) in the order given. */
const inOrder = (...events: TrajectoryEvent[]) =>
  events.map((e, i) => ({ ...e, seq: i, ts: `2026-11-01T11:00:${String(i).padStart(2, '0')}Z` }));

const preview = (tool: string, passed = 'true') =>
  ev('greenlight', ['preview', tool], { subcommand: 'preview', tool, passed });
const push = () => ev('git', ['push', 'origin', 'develop']);

const PREVIEW_BEFORE_PUSH = TrajectoryRuleSchema.parse({
  rule: 'before',
  first: { cmd: 'greenlight', args: ['preview', '*'], meta: { passed: 'true' } },
  next: { cmd: 'git', args: ['push', 'origin', 'develop'] },
});

describe('matcher', () => {
  it('args are an ordered subsequence of argv, not a prefix or a set', () => {
    expect(argsMatch(['push', 'origin', 'develop'], ['push', '-u', 'origin', 'develop'])).toBe(
      true,
    );
    expect(argsMatch(['push', 'origin', 'develop'], ['push', 'develop', 'origin'])).toBe(false);
    expect(argsMatch(['push', 'origin', 'develop'], ['push', 'origin'])).toBe(false);
    expect(argsMatch([], ['anything'])).toBe(true);
  });

  it('"*" matches exactly one element', () => {
    expect(argsMatch(['preview', '*'], ['preview', 'guestbook'])).toBe(true);
    expect(argsMatch(['preview', '*'], ['preview'])).toBe(false);
    expect(argsMatch(['*', '*', '*'], ['a', 'b'])).toBe(false);
    expect(argsMatch(['push', '*', 'develop'], ['push', 'origin', 'develop'])).toBe(true);
  });

  it('cmd is exact and meta keys must all be equal', () => {
    const e = preview('guestbook');
    expect(matches({ cmd: 'greenlight', meta: { passed: 'true' } }, e)).toBe(true);
    expect(matches({ cmd: 'greenlight', meta: { passed: 'false' } }, e)).toBe(false);
    expect(matches({ cmd: 'greenlight', meta: { missing: 'x' } }, e)).toBe(false);
    expect(matches({ cmd: 'git' }, e)).toBe(false);
  });
});

describe('rules', () => {
  it('before: every next is preceded by some first; vacuous without a next', () => {
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, [preview('guestbook'), push()]).passed).toBe(true);
    const bad = evaluateRule(PREVIEW_BEFORE_PUSH, [push(), preview('guestbook')]);
    expect(bad.passed).toBe(false);
    expect(bad.detail).toMatch(/no earlier/);
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, [preview('guestbook', 'false'), push()]).passed).toBe(
      false,
    );
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, [preview('guestbook')]).detail).toMatch(/vacuous/);
    // A second push after a passing preview is still covered.
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, [preview('g'), push(), push()]).passed).toBe(true);
  });

  it('a first and a next on the same event do not satisfy before', () => {
    const r: TrajectoryRule = TrajectoryRuleSchema.parse({
      rule: 'before',
      first: { cmd: 'git' },
      next: { cmd: 'git', args: ['push'] },
    });
    expect(evaluateRule(r, [push()]).passed).toBe(false);
  });

  it('after: each trigger is followed by next within n events', () => {
    const r = TrajectoryRuleSchema.parse({
      rule: 'after',
      trigger: { cmd: 'greenlight', args: ['verify'], meta: { passed: 'false' } },
      next: { cmd: 'greenlight', args: ['wiki', 'lookup'] },
      within: 2,
    });
    const fail = ev('greenlight', ['verify', 'x'], { passed: 'false' });
    const lookup = ev('greenlight', ['wiki', 'lookup', '--check', 'a']);
    const other = ev('git', ['status']);
    expect(evaluateRule(r, inOrder(fail, other, lookup)).passed).toBe(true);
    expect(evaluateRule(r, inOrder(fail, other, other, lookup)).passed).toBe(false);
    expect(evaluateRule(r, inOrder(lookup, fail)).passed).toBe(false);
    expect(evaluateRule(r, inOrder(other)).passed).toBe(true);
    const unbounded = TrajectoryRuleSchema.parse({ ...r, within: undefined });
    expect(evaluateRule(unbounded, inOrder(fail, other, other, other, lookup)).passed).toBe(true);
  });

  it('never: no match unless `unless` occurred earlier', () => {
    const r = TrajectoryRuleSchema.parse({
      rule: 'never',
      match: { cmd: 'greenlight', args: ['promote'] },
      unless: { cmd: 'approve' },
    });
    const promote = ev('greenlight', ['promote', 'x', '--perform']);
    const approve = { ...ev('approve', []), source: 'transcript' as const };
    expect(evaluateRule(r, [push()]).passed).toBe(true);
    expect(evaluateRule(r, [promote]).passed).toBe(false);
    expect(evaluateRule(r, inOrder(approve, promote)).passed).toBe(true);
    expect(evaluateRule(r, inOrder(promote, approve)).passed).toBe(false);
  });

  it('count: min and max bounds', () => {
    const r = TrajectoryRuleSchema.parse({
      rule: 'count',
      match: { cmd: 'git', args: ['push'] },
      min: 1,
      max: 2,
    });
    expect(evaluateRule(r, []).passed).toBe(false);
    expect(evaluateRule(r, [push()]).passed).toBe(true);
    expect(evaluateRule(r, [push(), push(), push()]).passed).toBe(false);
  });

  it('orders by instant, fractional seconds of any precision included, then by seq', () => {
    const at = (ts: string, s: number): TrajectoryEvent => ({ ...push(), seq: s, ts });
    const whole = at('2026-11-01T10:00:00Z', 5);
    const tenth = at('2026-11-01T10:00:00.1Z', 1);
    const nano = at('2026-11-01T10:00:00.000000001Z', 9);
    const same = at('2026-11-01T10:00:00.100Z', 0);
    // String order would put …:00Z after …:00.1Z ('Z' > '.').
    expect(orderEvents([tenth, whole, nano, same]).map((e) => e.seq)).toEqual([5, 9, 0, 1]);
    // An earlier instant wins over a lower seq.
    const p = { ...preview('g'), seq: 7, ts: '2026-11-01T10:00:00Z' };
    const q = { ...push(), seq: 2, ts: '2026-11-01T10:00:00.5Z' };
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, [q, p]).passed).toBe(true);
  });

  it('evaluates in time order regardless of input order', () => {
    const a = preview('g');
    const b = push();
    expect(orderEvents([b, a]).map((e) => e.seq)).toEqual([a.seq, b.seq]);
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, [b, a]).passed).toBe(true);
  });

  it('labels rules readably and keeps their index', () => {
    expect(describeRule(PREVIEW_BEFORE_PUSH)).toBe(
      'before(greenlight preview * {passed=true}, git push origin develop)',
    );
    const rs = evaluateRules([PREVIEW_BEFORE_PUSH, PREVIEW_BEFORE_PUSH], []);
    expect(rs.map((r) => r.index)).toEqual([0, 1]);
  });

  it('13 §2.7: identical apps, different order, different trajectory verdict', () => {
    const good = [preview('guestbook'), push()];
    const bad = [push(), preview('guestbook')];
    expect(evaluateRule(PREVIEW_BEFORE_PUSH, good).passed).not.toBe(
      evaluateRule(PREVIEW_BEFORE_PUSH, bad).passed,
    );
  });
});

describe('parseTrajectory', () => {
  it('parses JSONL and reports invalid lines instead of dropping them', () => {
    const ok = JSON.stringify(preview('g'));
    const dup = ok;
    const text = [ok, '', 'not json', JSON.stringify({ seq: 9 }), dup].join('\n');
    const { events, errors } = parseTrajectory(text);
    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/line 3: not JSON/);
    expect(errors.join('\n')).toMatch(/duplicate seq/);
  });
});

describe('normalizeShimEvent (the shim meta contract)', () => {
  const ctx = {
    branch: 'develop',
    upstreams: {
      develop: { remote: 'origin', ref: 'develop' },
      feature: { remote: 'origin', ref: 'develop' },
    },
  };
  const push = (argv: string[], c: object = ctx, exit = 0) =>
    normalizeShimEvent('git', ['push', ...argv], '/sandbox', exit, c).meta;

  it('resolves dstRef from every refspec spelling', () => {
    expect(push(['origin', 'develop'])).toMatchObject({ remote: 'origin', dstRef: 'develop' });
    expect(push(['origin', 'HEAD:develop'])?.dstRef).toBe('develop');
    expect(push(['origin', '+HEAD:refs/heads/develop'])).toMatchObject({
      dstRef: 'develop',
      force: 'true',
    });
    expect(push(['origin', 'feature:develop'])?.dstRef).toBe('develop');
    expect(push(['origin', 'HEAD'], { ...ctx, branch: 'feature' })?.dstRef).toBe('feature');
    expect(push(['origin', ':develop'])).toMatchObject({ dstRef: 'develop', delete: 'true' });
    expect(push(['--delete', 'origin', 'develop'])).toMatchObject({ delete: 'true' });
    expect(push(['-u', 'origin', 'develop'])?.dstRef).toBe('develop');
    expect(push(['-o', 'ci.skip', 'origin', 'develop'])).toMatchObject({
      remote: 'origin',
      dstRef: 'develop',
    });
    expect(push(['origin', 'refs/tags/v1'])?.dstRef).toBe('refs/tags/v1');
  });

  it('a bare push resolves through the branch upstream and push.default', () => {
    expect(push([])).toMatchObject({ remote: 'origin', dstRef: 'develop', pushed: 'true' });
    // feature tracks origin/develop: `simple` pushes it there.
    expect(push([], { ...ctx, branch: 'feature' })?.dstRef).toBe('develop');
    expect(push([], { ...ctx, branch: 'feature', pushDefault: 'current' })?.dstRef).toBe('feature');
    expect(push(['origin'])?.dstRef).toBe('develop');
  });

  it('marks what it cannot resolve to exactly one ref as unknown', () => {
    expect(push([], {})?.dstRef).toBe('unknown'); // no branch known
    expect(push([], { branch: 'topic' })?.dstRef).toBe('unknown'); // no upstream
    expect(push([], { ...ctx, pushDefault: 'matching' })?.dstRef).toBe('unknown');
    expect(push(['--all', 'origin'])?.dstRef).toBe('unknown');
    expect(push(['origin', 'main', 'develop'])).toMatchObject({
      dstRef: 'unknown',
      dstRefs: 'main,develop',
    });
    expect(push(['origin', 'refs/heads/*:refs/heads/*'])?.dstRef).toBe('unknown');
    expect(push(['origin', 'HEAD'], {})?.dstRef).toBe('unknown');
  });

  it('pushed is true only for a real, successful push', () => {
    expect(push(['origin', 'develop'], ctx, 1)?.pushed).toBe('false');
    expect(push(['--dry-run', 'origin', 'develop'])).toMatchObject({
      dryRun: 'true',
      pushed: 'false',
    });
    expect(push(['-n', 'origin', 'develop'])?.pushed).toBe('false');
  });

  it('skips git global options and expands aliases', () => {
    const e = normalizeShimEvent('/usr/bin/git', ['-C', '.', '-c', 'a.b=c', 'push'], '/s', 0, ctx);
    expect(e.cmd).toBe('git');
    expect(e.meta).toMatchObject({ subcommand: 'push', dstRef: 'develop' });
    // -C into another repository: the facts of this one no longer apply.
    const other = normalizeShimEvent('git', ['-C', 'repo', 'push'], '/s', 0, ctx);
    expect(other.meta).toMatchObject({ subcommand: 'push', dstRef: 'unknown' });
    expect(
      normalizeShimEvent('git', ['-C', 'repo', 'push', 'origin', 'HEAD:develop'], '/s', 0, ctx).meta
        ?.dstRef,
    ).toBe('develop');
    const a = normalizeShimEvent('git', ['pd'], '/s', 0, {
      ...ctx,
      aliases: { pd: 'push origin HEAD:develop' },
    });
    expect(a.meta).toMatchObject({ subcommand: 'push', dstRef: 'develop' });
    const sh = normalizeShimEvent('git', ['sh'], '/s', 0, { aliases: { sh: '!git push' } });
    expect(sh.meta?.subcommand).toBe('unknown');
    expect(normalizeShimEvent('git', ['commit', '-m', 'x'], '/s', 0).meta).toEqual({
      subcommand: 'commit',
    });
  });

  it('greenlight: tool is the positional the CLI resolves, and a rejected argv never passes', () => {
    const gl = (argv: string[], exit = 0, c = {}) =>
      normalizeShimEvent('greenlight', argv, '/s', exit, c).meta;
    expect(gl(['preview', 'pinboard'])).toEqual({
      subcommand: 'preview',
      tool: 'pinboard',
      passed: 'true',
    });
    expect(gl(['preview', '--port', '4000', 'pinboard'])?.tool).toBe('pinboard');
    // The reviewer's bypass: the wanted tool name smuggled in as an unknown flag's value.
    expect(gl(['preview', 'linkshelf', '--config', 'pinboard'])).toMatchObject({
      tool: 'linkshelf',
      argError: 'unknown flag "--config"',
      passed: 'false',
    });
    expect(gl(['preview', 'pinboard', '--port'])).toMatchObject({ passed: 'false' });
    expect(gl(['preview', 'pinboard'], 1)?.passed).toBe('false');
    expect(gl(['preview', 'pinboard'], 0, { passed: false })?.passed).toBe('false');
    expect(gl(['verify', 'pinboard', '--env', 'beta'])).toMatchObject({
      tool: 'pinboard',
      env: 'beta',
      passed: 'true',
    });
    expect(gl(['promote', 'pinboard', '--perform'])).toMatchObject({ subcommand: 'promote' });
  });

  it('greenlight run through a package runner is still greenlight', () => {
    const cases: [string, string[]][] = [
      ['npx', ['greenlight', 'promote', 'x']],
      ['npx', ['--yes', '@rtrentjones/greenlight@0.10.1', 'promote', 'x']],
      ['pnpm', ['greenlight', 'promote', 'x']],
      ['pnpm', ['exec', 'greenlight', 'promote', 'x']],
      ['npm', ['exec', '--', 'greenlight', 'promote', 'x']],
    ];
    for (const [cmd, argv] of cases) {
      const e = normalizeShimEvent(cmd, argv, '/s', 0);
      expect(e.cmd, `${cmd} ${argv.join(' ')}`).toBe('greenlight');
      expect(e.argv).toEqual(['promote', 'x']);
      expect(e.meta?.subcommand).toBe('promote');
    }
    expect(normalizeShimEvent('pnpm', ['install'], '/s', 0).cmd).toBe('pnpm');
  });

  it('the events it builds drive meta-based rules: a HEAD:develop push before the preview fails', () => {
    const rule = TrajectoryRuleSchema.parse({
      rule: 'before',
      first: {
        cmd: 'greenlight',
        meta: { subcommand: 'preview', tool: 'pinboard', passed: 'true' },
      },
      next: { cmd: 'git', meta: { subcommand: 'push', dstRef: 'develop' } },
    });
    const evs = [
      normalizeShimEvent('git', ['push', 'origin', 'HEAD:develop'], '/s', 0, ctx),
      normalizeShimEvent('greenlight', ['preview', 'pinboard'], '/s', 0),
      normalizeShimEvent('git', ['push', 'origin', 'develop'], '/s', 0, ctx),
    ].map((e, i) => ({ ...e, seq: i, ts: `2026-11-01T10:00:0${i}Z` }));
    expect(evaluateRule(rule, evs).passed).toBe(false);
    expect(evaluateRule(rule, evs.slice(1)).passed).toBe(true);
  });
});

describe('normalizeShimEvent: effective git config, aliases and ground truth (re-review 5)', () => {
  const ctx = {
    branch: 'develop',
    upstreams: {
      develop: { remote: 'origin', ref: 'develop' },
      'feat/x': { remote: 'origin', ref: 'develop' },
    },
  };
  const git = (argv: string[], c: ShimContext = ctx, exit = 0) =>
    normalizeShimEvent('git', argv, '/sandbox', exit, c).meta;

  it('resolves -c aliases, transitively, and never lets an alias shadow a builtin', () => {
    expect(git(['-c', 'alias.p=push', 'p', 'origin', 'HEAD:develop'])).toMatchObject({
      subcommand: 'push',
      dstRef: 'develop',
    });
    expect(
      git(['-c', 'alias.ship=p', '-c', 'alias.p=push', 'ship', 'origin', 'HEAD:develop']),
    ).toMatchObject({ subcommand: 'push', dstRef: 'develop' });
    expect(git(['-c', 'alias.P=push', 'P', 'origin', 'develop'])?.subcommand).toBe('push');
    // A cycle, a shell alias, an alias that changes the environment: unknown.
    expect(git(['-c', 'alias.a=b', '-c', 'alias.b=a', 'a'])?.subcommand).toBe('unknown');
    expect(git(['-c', 'alias.s=!git push origin HEAD:develop', 's'])?.subcommand).toBe('unknown');
    expect(git(['-c', 'alias.q=-c push.default=current push', 'q'])?.subcommand).toBe('unknown');
    // Non-env global options inside an alias are fine.
    expect(git(['-c', 'alias.q=--no-pager push origin develop', 'q'])?.dstRef).toBe('develop');
    // `alias.push` cannot hide the builtin.
    expect(git(['-c', 'alias.push=status', 'push', 'origin', 'develop'])?.subcommand).toBe('push');
    expect(git(['-c', 'alias.status=push origin develop', 'status'])?.subcommand).toBe('status');
    // A non-builtin with no visible alias is unknown, not its own name.
    expect(git(['p', 'origin', 'HEAD:develop'])).toMatchObject({ subcommand: 'unknown' });
    expect(git(['send-pack', 'origin', 'develop'])?.subcommand).toBe('unknown');
    expect(git(['submodule', 'foreach', 'git push'])?.subcommand).toBe('unknown');
    expect(git(['--frobnicate', 'push'])?.subcommand).toBe('unknown');
    expect(git(['--version'])?.subcommand).toBe('version');
  });

  it('reads command-scope config from GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS and --config-env', () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.p', GIT_CONFIG_VALUE_0: 'push' };
    expect(git(['p', 'origin', 'HEAD:develop'], { ...ctx, env })?.dstRef).toBe('develop');
    expect(
      git(['p', 'origin', 'HEAD:develop'], {
        ...ctx,
        env: { GIT_CONFIG_PARAMETERS: "'alias.p'='push'" },
      })?.subcommand,
    ).toBe('push');
    expect(
      git(['--config-env', 'alias.p=PUSHCMD', 'p', 'origin', 'HEAD:develop'], {
        ...ctx,
        env: { PUSHCMD: 'push' },
      })?.subcommand,
    ).toBe('push');
    // -c overrides the env layers, in argv order.
    expect(
      git(['-c', 'push.default=current', 'push'], {
        ...ctx,
        branch: 'feat/x',
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'push.default',
          GIT_CONFIG_VALUE_0: 'upstream',
        },
      })?.dstRef,
    ).toBe('feat/x');
    // A relocated config file: anything it could define is unknown.
    expect(git(['p'], { ...ctx, env: { GIT_CONFIG_GLOBAL: '/x' } })?.subcommand).toBe('unknown');
    expect(git(['push'], { ...ctx, env: { GIT_CONFIG_GLOBAL: '/x' } })?.dstRef).toBe('unknown');
    expect(git(['-c', 'include.path=/x', 'push'])?.dstRef).toBe('unknown');
    expect(git(['push', 'origin', 'HEAD'], { ...ctx, env: { GIT_DIR: '/o' } })?.dstRef).toBe(
      'unknown',
    ); // HEAD of another repository
    expect(
      git(['push', 'origin', 'main:develop'], { ...ctx, env: { GIT_DIR: '/o' } })?.dstRef,
    ).toBe('develop');
  });

  it('push.default and remote.<r>.push from the effective config decide a bare push', () => {
    // The reviewer's case: feat/x tracks origin/develop, but push.default=current pushes feat/x.
    expect(git(['-c', 'push.default=current', 'push'], { ...ctx, branch: 'feat/x' })?.dstRef).toBe(
      'feat/x',
    );
    expect(git(['-c', 'push.default=matching', 'push'])?.dstRef).toBe('unknown');
    expect(git(['-c', 'push.default=bogus', 'push'])?.dstRef).toBe('unknown');
    expect(git(['-c', 'remote.origin.push=HEAD:main', 'push'])?.dstRef).toBe('main');
    expect(git(['-c', 'remote.origin.push=refs/heads/*:refs/heads/*', 'push'])?.dstRef).toBe(
      'unknown',
    );
    expect(git(['-c', 'remote.origin.push=HEAD:main', 'push', 'origin', 'develop'])?.dstRef).toBe(
      'unknown',
    );
    expect(git(['-c', 'branch.develop.merge=refs/heads/main', 'push'])?.dstRef).toBe('main');
    expect(git(['push', '--prune', 'origin', 'develop'])?.dstRef).toBe('unknown');
    expect(git(['--namespace=x', 'push', 'origin', 'develop'])?.dstRef).toBe('unknown');
    expect(
      git(['push'], { ...ctx, config: { 'push.default': 'current' }, branch: 'feat/x' })?.dstRef,
    ).toBe('feat/x');
  });

  it('pushed means a remote ref moved when the runner says so', () => {
    const p = ['push', 'origin', 'develop'];
    expect(git(p, { ...ctx, remoteMoved: false })?.pushed).toBe('false');
    expect(git(p, { ...ctx, remoteMoved: true })?.pushed).toBe('true');
    expect(git(p, { ...ctx, remoteMoved: true }, 1)?.pushed).toBe('true');
    expect(git(p)?.pushed).toBe('true'); // fallback without ground truth: exit 0
    // movedRefs is ground truth for dstRef too.
    expect(git(p, { ...ctx, movedRefs: ['refs/heads/main'] })).toMatchObject({
      dstRef: 'main',
      pushed: 'true',
    });
    expect(git(['push'], { ...ctx, movedRefs: [] })).toMatchObject({
      dstRef: 'develop',
      pushed: 'false',
    });
    // A non-push command that moved a ref (a hook, a shell alias) becomes unknown.
    expect(git(['commit', '-m', 'x'], { ...ctx, movedRefs: ['develop'] })).toEqual({
      subcommand: 'unknown',
      invoked: 'commit',
      dstRef: 'develop',
      pushed: 'true',
    });
    expect(git(['commit', '-m', 'x'], { ...ctx, remoteMoved: false })).toEqual({
      subcommand: 'commit',
    });
  });

  it('recognizes greenlight behind pnpm run / --filter exec / npx --package', () => {
    const cases: [string, string[]][] = [
      ['pnpm', ['run', 'greenlight', 'preview', 'x']],
      ['pnpm', ['--filter', 'web', 'exec', 'greenlight', 'preview', 'x']],
      ['pnpm', ['-F', 'web', 'exec', 'greenlight', 'preview', 'x']],
      ['pnpm', ['-r', 'exec', 'greenlight', 'preview', 'x']],
      ['pnpm', ['-C', 'sub', 'greenlight', 'preview', 'x']],
      ['npx', ['--package', '@rtrentjones/greenlight', 'greenlight', 'preview', 'x']],
      ['npx', ['-p', '@rtrentjones/greenlight@0.10.1', 'greenlight', 'preview', 'x']],
      ['npm', ['run', 'greenlight', '--', 'preview', 'x']],
      ['npm', ['exec', '--package=@rtrentjones/greenlight', '--', 'greenlight', 'preview', 'x']],
      ['yarn', ['run', 'greenlight', 'preview', 'x']],
    ];
    for (const [cmd, argv] of cases) {
      const e = normalizeShimEvent(cmd, argv, '/s', 0);
      const label = `${cmd} ${argv.join(' ')}`;
      expect(e.cmd, label).toBe('greenlight');
      expect(e.meta, label).toMatchObject({ subcommand: 'preview', tool: 'x' });
    }
    // A shell string is not unwrapped (its words are not argv).
    expect(normalizeShimEvent('npx', ['-c', 'greenlight preview x'], '/s', 0).cmd).toBe('npx');
  });

  it('a meta matcher only matches shim events', () => {
    const e: TrajectoryEvent = {
      seq: 0,
      ts: '2026-11-01T10:00:00Z',
      source: 'transcript',
      cmd: 'greenlight',
      argv: ['preview', 'x'],
      cwd: '/s',
      meta: { subcommand: 'preview', tool: 'x', passed: 'true' },
    };
    const m = { cmd: 'greenlight', meta: { subcommand: 'preview' } };
    expect(matches(m, e)).toBe(false);
    expect(matches(m, { ...e, source: 'shim' })).toBe(true);
    expect(matches({ cmd: 'greenlight', args: ['preview'] }, e)).toBe(true);
  });

  it('every bench shim.json re-derives exactly the meta recorded in its trajectory.jsonl', () => {
    const bench = join(dirname(fileURLToPath(import.meta.url)), '../../../../../bench');
    const found: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (n.name === 'shim.json') found.push(d);
      }
    };
    walk(join(bench, 'mutants'));
    walk(join(bench, 'references'));
    expect(found.length).toBeGreaterThanOrEqual(26);
    for (const d of found) {
      const scenario = JSON.parse(readFileSync(join(d, 'shim.json'), 'utf8')) as ShimScenario;
      expect(readFileSync(join(d, 'trajectory.jsonl'), 'utf8'), d).toBe(buildTrajectory(scenario));
    }
  });
});
