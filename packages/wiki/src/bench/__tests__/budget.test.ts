import { describe, expect, it } from 'vitest';
import { outcome } from '../../__tests__/fixtures/policy/vectors';
import type { Budget } from '../../schema/bench';
import { LedgerEventSchema } from '../../schema/ledger';
import {
  BudgetRefusedError,
  assertWithinBudget,
  checkBudget,
  estimateGateCost,
  monthSpend,
  spendEvent,
  spendFromOutcomes,
} from '../budget';

const budget: Budget = {
  monthlyUsd: 10,
  perGateMaxUsd: 5,
  perGateMaxRollouts: 108,
  perGateMaxRequests: 5000,
  splitAcrossDays: false,
};

const spend = (ts: string, usd: number, requests = 100) =>
  spendEvent({ ts, usd, rollouts: 10, requests, tokensIn: 1000, tokensOut: 500 });

describe('estimateGateCost (06 §4.5)', () => {
  it('is tasks × runs × models × modes, ×2 with a baseline re-run', () => {
    expect(
      estimateGateCost({ tasks: 18, runs: 3, models: 2, modes: 1, requestsPerRollout: 40 }),
    ).toEqual({ rollouts: 108, requests: 4320, usd: 0 });
    expect(
      estimateGateCost({
        tasks: 18,
        runs: 3,
        models: 2,
        modes: 2,
        requestsPerRollout: 1.5,
        usdPerRollout: 0.01,
        baselineRerun: true,
      }),
    ).toEqual({ rollouts: 432, requests: 648, usd: 4.32 });
  });
  it('rejects negative inputs', () => {
    expect(() =>
      estimateGateCost({ tasks: -1, runs: 3, models: 2, modes: 1, requestsPerRollout: 1 }),
    ).toThrow(/tasks/);
  });
});

describe('checkBudget (06 §9, 08 §10.5)', () => {
  const now = '2026-11-15T10:00:00.000Z';

  it('allows an estimate exactly at every cap', () => {
    const c = checkBudget(budget, { rollouts: 108, requests: 5000, usd: 5 }, [], now);
    expect(c.ok).toBe(true);
  });

  it.each([
    ['per-gate-rollouts', { rollouts: 109, requests: 1, usd: 0 }],
    ['per-gate-requests', { rollouts: 1, requests: 5001, usd: 0 }],
    ['per-gate-usd', { rollouts: 1, requests: 1, usd: 5.01 }],
  ] as const)('refuses over %s', (code, estimate) => {
    const c = checkBudget(budget, estimate, [], now);
    expect(c.ok).toBe(false);
    expect(c.refusals.map((r) => r.code)).toEqual([code]);
    expect(() => assertWithinBudget(budget, estimate, [], now)).toThrow(BudgetRefusedError);
  });

  it("refuses over the month's remaining budget, summed from this UTC month's spend events", () => {
    const events = [spend('2026-11-01T00:00:00.000Z', 4), spend('2026-11-14T23:00:00.000Z', 3)];
    const c = checkBudget(budget, { rollouts: 1, requests: 1, usd: 3.5 }, events, now);
    expect(c.remainingUsd).toBe(3);
    expect(c.refusals.map((r) => r.code)).toEqual(['monthly-usd']);
    expect(checkBudget(budget, { rollouts: 1, requests: 1, usd: 3 }, events, now).ok).toBe(true);
  });

  it('counts only the current UTC month (month boundary)', () => {
    const events = [
      spend('2026-10-31T23:59:59.999Z', 9),
      spend('2026-11-01T00:00:00.000Z', 1),
      spend('2026-12-01T00:00:00.000Z', 9),
    ];
    expect(monthSpend(events, '2026-11-01T00:00:00.000Z')).toMatchObject({
      month: '2026-11',
      usd: 1,
      events: 1,
    });
    expect(monthSpend(events, '2026-10-31T23:59:59.999Z')).toMatchObject({
      month: '2026-10',
      usd: 9,
    });
    // a local-time offset that is still October in UTC
    expect(monthSpend(events, '2026-11-01T01:00:00+02:00').month).toBe('2026-10');
  });

  it('ignores non-spend events', () => {
    const events = [spend('2026-11-02T00:00:00.000Z', 2)];
    expect(monthSpend(events, now).usd).toBe(2);
  });

  it('refuses over the day’s remaining requests unless the gate may split across days', () => {
    const est = { rollouts: 10, requests: 500, usd: 0 };
    const c = checkBudget(budget, est, [], now, { dailyRequestsRemaining: 499 });
    expect(c.refusals.map((r) => r.code)).toEqual(['daily-requests']);
    expect(
      checkBudget({ ...budget, splitAcrossDays: true }, est, [], now, {
        dailyRequestsRemaining: 499,
      }).ok,
    ).toBe(true);
  });

  it('a $0 free-tier budget allows a $0 gate', () => {
    const free = { ...budget, monthlyUsd: 0, perGateMaxUsd: 0 };
    expect(checkBudget(free, { rollouts: 108, requests: 4000, usd: 0 }, [], now).ok).toBe(true);
  });
});

describe('spend events', () => {
  it('are sealed, schema-valid, and carry requests', () => {
    const e = spend('2026-11-01T00:00:00.000Z', 0, 321);
    LedgerEventSchema.parse(e);
    expect(e.stage).toBe('spend');
    expect(e.spend?.requests).toBe(321);
    expect(e.proposalId).toBeUndefined();
  });
  it('sum a record’s outcome costs', () => {
    const os = [
      outcome('cap/a', 1, 'm', 'isolation', true),
      outcome('cap/a', 2, 'm', 'isolation', false),
    ];
    const e = spendFromOutcomes(os, { ts: '2026-11-01T00:00:00.000Z', evaluationId: 'abc' });
    LedgerEventSchema.parse(e);
    expect(e.spend).toEqual({
      usd: 0,
      rollouts: 2,
      requests: 10,
      tokensIn: 200,
      tokensOut: 100,
      evaluationId: 'abc',
    });
  });
});
