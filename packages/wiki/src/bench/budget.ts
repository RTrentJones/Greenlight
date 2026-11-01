import { type Budget, BudgetSchema } from '../schema/bench';
import { type LedgerEvent, LedgerEventSchema, sealEvent } from '../schema/ledger';
import type { BenchOutcome } from './stats';

/**
 * Per-gate budget caps (vision 06 §4.5, §9; 08 §10.5; roadmap M1-09). `bench run` estimates a
 * gate's cost before any rollout and refuses one over `perGateMaxRollouts`, `perGateMaxRequests`,
 * `perGateMaxUsd` or the month's remaining budget. Spend lives only in harness-written `spend`
 * ledger events, summed over the current UTC calendar month. Pure: the caller passes `now`.
 */

export interface GateCostInput {
  /** Gated tasks per mode (val split, active). */
  tasks: number;
  runs: number;
  models: number;
  modes: number;
  /** Estimated LLM requests per rollout (the free-tier binding constraint, 06 §4.8). */
  requestsPerRollout: number;
  /** Estimated dollars per rollout; 0 on the free tier (ADR-20). */
  usdPerRollout?: number;
  /** The baseline must be (re-)run too (06 §1.5): doubles the rollouts. */
  baselineRerun?: boolean;
}

export interface GateCostEstimate {
  rollouts: number;
  requests: number;
  usd: number;
}

/** tasks × runs × models × modes rollouts (06 §4.5), ×2 when the baseline re-runs. */
export function estimateGateCost(input: GateCostInput): GateCostEstimate {
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
      throw new Error(`gate cost input ${k} must be a non-negative number, got ${v}`);
    }
  }
  const rollouts =
    input.tasks * input.runs * input.models * input.modes * (input.baselineRerun ? 2 : 1);
  return {
    rollouts,
    requests: Math.ceil(rollouts * input.requestsPerRollout),
    usd: rollouts * (input.usdPerRollout ?? 0),
  };
}

export interface MonthSpend {
  month: string;
  usd: number;
  rollouts: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  events: number;
}

function utcMonth(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) throw new Error(`not a timestamp: ${String(ts)}`);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Sums `spend` events whose ts falls in the UTC calendar month of `now` (08 §10.5). */
export function monthSpend(events: readonly LedgerEvent[], now: string | Date): MonthSpend {
  const month = utcMonth(now);
  const out: MonthSpend = {
    month,
    usd: 0,
    rollouts: 0,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    events: 0,
  };
  for (const e of events) {
    if (e.stage !== 'spend' || !e.spend || utcMonth(e.ts) !== month) continue;
    out.usd += e.spend.usd;
    out.rollouts += e.spend.rollouts;
    out.requests += e.spend.requests;
    out.tokensIn += e.spend.tokensIn;
    out.tokensOut += e.spend.tokensOut;
    out.events++;
  }
  return out;
}

export const BUDGET_REFUSALS = [
  'per-gate-rollouts',
  'per-gate-requests',
  'per-gate-usd',
  'monthly-usd',
  'daily-requests',
] as const;

export interface BudgetRefusal {
  code: (typeof BUDGET_REFUSALS)[number];
  limit: number;
  expected: number;
}

export interface BudgetCheck {
  ok: boolean;
  refusals: BudgetRefusal[];
  estimate: GateCostEstimate;
  spent: MonthSpend;
  remainingUsd: number;
}

/**
 * Checks an estimate against the caps. "Exceeds" is strict: an estimate exactly at a cap runs.
 * `dailyRequestsRemaining` (the day's remaining rpd, 06 §4.8) refuses only when the budget does
 * not allow splitting a gate across days.
 */
export function checkBudget(
  budget: Budget,
  estimate: GateCostEstimate,
  events: readonly LedgerEvent[],
  now: string | Date,
  opts: { dailyRequestsRemaining?: number } = {},
): BudgetCheck {
  const b = BudgetSchema.parse(budget);
  const spent = monthSpend(events, now);
  const remainingUsd = Math.max(0, b.monthlyUsd - spent.usd);
  const refusals: BudgetRefusal[] = [];
  if (estimate.rollouts > b.perGateMaxRollouts) {
    refusals.push({
      code: 'per-gate-rollouts',
      limit: b.perGateMaxRollouts,
      expected: estimate.rollouts,
    });
  }
  if (estimate.requests > b.perGateMaxRequests) {
    refusals.push({
      code: 'per-gate-requests',
      limit: b.perGateMaxRequests,
      expected: estimate.requests,
    });
  }
  if (estimate.usd > b.perGateMaxUsd) {
    refusals.push({ code: 'per-gate-usd', limit: b.perGateMaxUsd, expected: estimate.usd });
  }
  if (estimate.usd > remainingUsd) {
    refusals.push({ code: 'monthly-usd', limit: remainingUsd, expected: estimate.usd });
  }
  if (
    opts.dailyRequestsRemaining !== undefined &&
    !b.splitAcrossDays &&
    estimate.requests > opts.dailyRequestsRemaining
  ) {
    refusals.push({
      code: 'daily-requests',
      limit: opts.dailyRequestsRemaining,
      expected: estimate.requests,
    });
  }
  return { ok: refusals.length === 0, refusals, estimate, spent, remainingUsd };
}

export class BudgetRefusedError extends Error {
  constructor(readonly check: BudgetCheck) {
    super(
      `gate refused before any rollout: ${check.refusals
        .map((r) => `${r.code} (expected ${r.expected} > ${r.limit})`)
        .join('; ')}`,
    );
    this.name = 'BudgetRefusedError';
  }
}

/** `checkBudget`, throwing BudgetRefusedError when any cap would be exceeded. */
export function assertWithinBudget(...args: Parameters<typeof checkBudget>): BudgetCheck {
  const c = checkBudget(...args);
  if (!c.ok) throw new BudgetRefusedError(c);
  return c;
}

export interface SpendInput {
  ts: string;
  usd: number;
  rollouts: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  evaluationId?: string;
}

/** A sealed, schema-checked `spend` ledger event (08 §8). */
export function spendEvent(s: SpendInput): LedgerEvent {
  const e = sealEvent({
    ts: s.ts,
    stage: 'spend',
    spend: {
      usd: s.usd,
      rollouts: s.rollouts,
      requests: s.requests,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      evaluationId: s.evaluationId,
    },
  });
  LedgerEventSchema.parse(e);
  return e;
}

/** The spend of a set of rollouts, summed from each outcome's reported cost (06 §9 "Tracking"). */
export function spendFromOutcomes(
  outcomes: readonly BenchOutcome[],
  opts: { ts: string; evaluationId?: string },
): LedgerEvent {
  let usd = 0;
  let requests = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const o of outcomes) {
    usd += o.cost.usd;
    requests += o.cost.requests;
    tokensIn += o.cost.tokensIn;
    tokensOut += o.cost.tokensOut;
  }
  return spendEvent({
    ts: opts.ts,
    usd,
    rollouts: outcomes.length,
    requests,
    tokensIn,
    tokensOut,
    evaluationId: opts.evaluationId,
  });
}
