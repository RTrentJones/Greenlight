import { describe, expect, it } from 'vitest';
import { TrajectoryRuleSchema } from '../../schema/bench';
import type { TrajectoryEvent, TrajectoryRule } from '../../schema/bench';
import {
  argsMatch,
  describeRule,
  evaluateRule,
  evaluateRules,
  matches,
  orderEvents,
  parseTrajectory,
} from '../trajectory';

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
const inOrder = (...events: TrajectoryEvent[]) => events.map((e, i) => ({ ...e, seq: i }));

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

  it('evaluates in seq order regardless of input order', () => {
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
