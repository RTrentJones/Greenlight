import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CELLS, F, S, TASKS, cleanCell, expand } from '../../__tests__/fixtures/policy/vectors';
import { type BaselineIdentity, type EvaluationRecord, sealRecord } from '../../schema/bench';
import { LedgerEventSchema } from '../../schema/ledger';
import {
  GateConfigSchema,
  type GateContext,
  GateHarnessError,
  decide,
  earlyStopEvent,
  loadGateConfig,
  recompute,
  releaseCheck,
  sameDecision,
} from '../gate';
import type { GateMode } from '../stats';

const H = (c: string) => c.repeat(64);

function identity(mode: GateMode, skillSet = H('a')): BaselineIdentity {
  return {
    taskSetHash: H('1'),
    splitsHash: H('2'),
    graderSetHash: H('3'),
    depsHash: H('4'),
    harness: { runnerVersion: '1.0.0', imageDigest: 'sha256:abc' },
    agent: { vendor: 'greenlight-harness', version: '0.1.0' },
    models: [F, S],
    skillSetHash: skillSet,
    mode,
    wikiSnapshotHash: mode === 'production' ? H('5') : null,
    proxyPolicyHash: null,
  };
}

type Side = 'base' | 'cand';
function record(
  side: Side,
  mode: GateMode,
  edit?: (w: Record<string, number>, model: string) => void,
  over: Partial<Omit<EvaluationRecord, 'hash'>> = {},
): EvaluationRecord {
  const outcomes = CELLS.filter((c) => c.mode === mode).flatMap((c) => {
    const w = { ...cleanCell(mode)[side] };
    edit?.(w, c.model);
    return expand(w, c.model, mode);
  });
  return sealRecord({
    identity: identity(mode, side === 'base' ? H('a') : H('b')),
    role: side === 'base' ? 'baseline' : 'candidate',
    proposalId: side === 'cand' ? 'prop-1' : undefined,
    outcomes,
    ...over,
  });
}

const ctx: GateContext = {
  ts: '2026-11-01T12:00:00.000Z',
  radius: 'medium',
  path: 'standard',
  models: { frontier: F, small: S },
  tasks: TASKS,
  skill: 'deploy-verify-promote',
};

const baseIso = record('base', 'isolation');
const baseProd = record('base', 'production');
const candIso = record('cand', 'isolation');
const candProd = record('cand', 'production');

describe('decide', () => {
  it('accepts and builds a sealed candidate-accepted event with one result per model × mode', () => {
    const d = decide([baseIso, baseProd], [candIso, candProd], ctx);
    expect(d.decision).toBe('accept');
    expect(d.seed).toBe('gate:prop-1');
    const e = d.ledgerEvent;
    if (!e) throw new Error('no event');
    LedgerEventSchema.parse(e);
    expect(e.stage).toBe('candidate-accepted');
    expect(e.path).toBe('standard');
    expect(e.proposalId).toBe('prop-1');
    expect(e.evidence).toMatchObject({ kind: 'bench', evaluationRecord: candIso.hash });
    expect(
      e.evidence?.kind === 'bench' && e.evidence.results.map((r) => `${r.model}/${r.mode}`),
    ).toEqual([`${F}/isolation`, `${F}/production`, `${S}/isolation`, `${S}/production`]);
  });

  it('accepts a single record per side (isolation only, as in M1)', () => {
    expect(decide(baseIso, candIso, ctx).decision).toBe('accept');
  });

  it('builds a candidate-rejected event with a machine-readable reason summary', () => {
    const bad = record('cand', 'isolation', (w, m) => {
      if (m === S) w['replay/a'] = 1;
    });
    const d = decide(baseIso, bad, ctx);
    expect(d.decision).toBe('reject');
    expect(d.ledgerEvent?.stage).toBe('candidate-rejected');
    expect(d.ledgerEvent?.reason).toContain(`replay-regression (${S}/isolation/replay/a)`);
  });

  it('labels the neutral path and records the human reason', () => {
    const flat = record('cand', 'isolation', (w) => {
      Object.assign(w, cleanCell('isolation').base);
    });
    const d = decide(baseIso, flat, {
      ...ctx,
      path: 'neutral',
      neutralReason: 'prerequisite for prop-2',
    });
    expect(d.decision).toBe('accept');
    expect(d.ledgerEvent).toMatchObject({ path: 'neutral', reason: 'prerequisite for prop-2' });
    const without = decide(baseIso, flat, { ...ctx, path: 'neutral' });
    expect(without.decision).toBe('reject');
    LedgerEventSchema.parse(without.ledgerEvent);
  });

  it('returns invalid with no ledger event when a rollout was fallback-served', () => {
    const outcomes = candIso.outcomes.map((o, i) => (i === 0 ? { ...o, servedBy: 'fallback' } : o));
    const { hash: _h, ...rest } = candIso;
    const fb = sealRecord({ ...rest, outcomes });
    const d = decide(baseIso, fb, ctx);
    expect(d.decision).toBe('invalid');
    expect(d.ledgerEvent).toBeNull();
    expect(d.results).toEqual([]);
    expect(d.reasons.map((r) => r.code)).toContain('fallback-served');
  });

  describe('identity mismatch is a harness error, never a result (06 §1.5)', () => {
    const changes: [string, Partial<BaselineIdentity>][] = [
      ['taskSetHash', { taskSetHash: H('9') }],
      ['depsHash', { depsHash: H('9') }],
      ['models', { models: [F, 'model-other'] }],
      ['harness', { harness: { runnerVersion: '2.0.0', imageDigest: 'sha256:abc' } }],
      ['proxyPolicyHash', { proxyPolicyHash: H('9') }],
    ];
    it.each(changes)('%s', (field, change) => {
      const { hash: _h, ...rest } = candIso;
      const cand = sealRecord({ ...rest, identity: { ...rest.identity, ...change } });
      let err: unknown;
      try {
        decide(baseIso, cand, ctx);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GateHarnessError);
      expect((err as GateHarnessError).fields).toEqual([field]);
      expect((err as Error).message).toContain(field);
    });
    it('names every differing field', () => {
      const { hash: _h, ...rest } = candIso;
      const cand = sealRecord({
        ...rest,
        identity: { ...rest.identity, splitsHash: H('8'), graderSetHash: H('7') },
      });
      expect(() => decide(baseIso, cand, ctx)).toThrow(/splitsHash, graderSetHash/);
    });
    it('the skill set alone may differ', () => {
      expect(baseIso.identity.skillSetHash).not.toBe(candIso.identity.skillSetHash);
      expect(() => decide(baseIso, candIso, ctx)).not.toThrow();
    });
  });

  it('throws on a tampered record (hash mismatch), wrong roles, or a missing mode pair', () => {
    const tampered = {
      ...candIso,
      outcomes: candIso.outcomes.map((o, i) =>
        i === 0
          ? { ...o, score: 0 as const, graders: [{ kind: 'app' as const, passed: false }] }
          : o,
      ),
    };
    expect(() => decide(baseIso, tampered, ctx)).toThrow(/hash/);
    expect(() => decide(candIso, candIso, ctx)).toThrow(GateHarnessError);
    expect(() => decide([baseIso, baseProd], candIso, ctx)).toThrow(/production/);
    expect(() => decide(baseIso, candIso, { ...ctx, models: { frontier: F, small: 'x' } })).toThrow(
      /not in the evaluation identity/,
    );
  });
});

describe('recompute (06 §5.8, 13 §2.7)', () => {
  const stored = [
    baseIso,
    baseProd,
    candIso,
    candProd,
    record('cand', 'isolation', undefined, { proposalId: 'prop-other' }),
  ];

  it('reproduces the recorded decision byte for byte from records alone', () => {
    const original = decide([baseIso, baseProd], [candIso, candProd], ctx);
    const again = recompute(stored, 'prop-1', ctx);
    expect(JSON.stringify(again)).toBe(JSON.stringify(original));
    expect(again.ledgerEvent?.eventId).toBe(original.ledgerEvent?.eventId);
    if (!original.ledgerEvent) throw new Error('no event');
    expect(sameDecision(original.ledgerEvent, again)).toBe(true);
  });

  it('a resealed record with one tampered outcome gives a different decision', () => {
    const original = decide(baseIso, candIso, ctx);
    const { hash: _h, ...rest } = candIso;
    const outcomes = rest.outcomes.map((o) =>
      o.task === 'replay/a' && o.model === F && o.run > 1
        ? { ...o, score: 0 as const, graders: [{ kind: 'app' as const, passed: false }] }
        : o,
    );
    const resealed = sealRecord({ ...rest, outcomes });
    expect(resealed.hash).not.toBe(candIso.hash);
    const again = recompute([baseIso, resealed], 'prop-1', ctx);
    expect(again.decision).toBe('reject');
    if (!original.ledgerEvent) throw new Error('no event');
    expect(sameDecision(original.ledgerEvent, again)).toBe(false);
  });

  it('throws when the proposal or a comparable baseline is missing, or baselines are ambiguous', () => {
    expect(() => recompute(stored, 'nope', ctx)).toThrow(/no candidate/);
    expect(() => recompute([candIso], 'prop-1', ctx)).toThrow(/no comparable/);
    const older = record('base', 'isolation', (w) => {
      w['cap/c1'] = 0;
    });
    expect(() => recompute([baseIso, older, candIso], 'prop-1', ctx)).toThrow(/more than one/);
    expect(
      recompute([baseIso, older, candIso], 'prop-1', { ...ctx, baselineHashes: [baseIso.hash] })
        .decision,
    ).toBe('accept');
  });
});

describe('earlyStopEvent', () => {
  it('writes a sealed no-action event at R = 1.0, and nothing otherwise', () => {
    const perfect = record('base', 'isolation', (w) => {
      for (const k of Object.keys(w)) w[k] = 3;
    });
    const e = earlyStopEvent(perfect, { ...ctx, proposalId: 'prop-9' });
    expect(e?.stage).toBe('no-action');
    LedgerEventSchema.parse(e);
    expect(earlyStopEvent(baseIso, { ...ctx, proposalId: 'prop-9' })).toBeNull();
  });
});

describe('releaseCheck (06 §5.7)', () => {
  const rc = (edit?: (w: Record<string, number>, model: string) => void) =>
    record('base', 'isolation', edit, { role: 'release-check' });
  const rctx = {
    ts: '2026-11-01T12:00:00.000Z',
    models: { frontier: F, small: S },
    tasks: TASKS,
    release: '2.0.0',
  };
  const prev = rc();

  it('passes an unchanged candidate and writes a release-check event', () => {
    const r = releaseCheck(prev, rc(), rctx);
    expect(r.decision).toBe('pass');
    expect(r.blocked).toBe(false);
    expect(r.ledgerEvent?.stage).toBe('release-check');
    LedgerEventSchema.parse(r.ledgerEvent);
  });

  it('blocks a test replay regression; a reasoned override applies only below high radius', () => {
    const regressed = rc((w, m) => {
      if (m === F) w['replay/b'] = 0;
    });
    const r = releaseCheck(prev, regressed, rctx);
    expect(r.blocked).toBe(true);
    expect(r.ledgerEvent?.reason).toMatch(/^blocked: replay-regression/);
    const o = releaseCheck(prev, regressed, { ...rctx, override: { reason: 'known flake, #12' } });
    expect(o).toMatchObject({ blocked: false, overridden: true });
    expect(o.ledgerEvent?.reason).toMatch(/^override: known flake/);
    expect(() =>
      releaseCheck(prev, regressed, { ...rctx, radius: 'high', override: { reason: 'x' } }),
    ).toThrow(/high-radius/);
  });

  it('throws on identity mismatch and on non-release-check roles', () => {
    const { hash: _h, ...rest } = prev;
    const other = sealRecord({ ...rest, identity: { ...rest.identity, depsHash: H('9') } });
    expect(() => releaseCheck(prev, other, rctx)).toThrow(/depsHash/);
    expect(() => releaseCheck(baseIso, prev, rctx)).toThrow(/role/);
  });
});

describe('gate config', () => {
  it('bench/gate.json holds the defaults', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../../../../bench/gate.json', import.meta.url), 'utf8'),
    );
    expect(loadGateConfig(json)).toEqual(GateConfigSchema.parse({}));
    expect(loadGateConfig(json)).toEqual({
      alpha: 0.05,
      runs: 3,
      resamples: 1000,
      acceptShorterOnTie: false,
    });
  });
  it('enables the tie-break from config', () => {
    const flat = record('cand', 'isolation', (w) => {
      Object.assign(w, cleanCell('isolation').base);
    });
    const tie = { ...ctx, skillLines: { before: 100, after: 80 } };
    expect(decide(baseIso, flat, tie).decision).toBe('reject');
    const d = decide(baseIso, flat, { ...tie, config: { acceptShorterOnTie: true } });
    expect(d.decision).toBe('accept');
    expect(d.ledgerEvent?.reason).toMatch(/tie/);
  });
});
