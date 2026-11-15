import { describe, expect, it } from 'vitest';
import { outcome } from '../../__tests__/fixtures/policy/vectors';
import { type Stratum, choose, mean, perTaskMeans, shapeMinP, stratifiedExactTest } from '../stats';

describe('perTaskMeans', () => {
  it('averages runs per task for one model × mode', () => {
    const os = [
      outcome('cap/a', 1, 'm', 'isolation', true),
      outcome('cap/a', 2, 'm', 'isolation', false),
      outcome('cap/a', 3, 'm', 'isolation', true),
      outcome('cap/a', 1, 'other', 'isolation', false),
      outcome('cap/a', 1, 'm', 'production', false),
    ];
    const m = perTaskMeans(os, 'm', 'isolation');
    expect(m.get('cap/a')).toEqual({ task: 'cap/a', passes: 2, runs: 3, mean: 2 / 3 });
    expect(m.size).toBe(1);
  });
  it('mean of nothing is 0', () => expect(mean([])).toBe(0));
});

const s = (baseline: number, candidate: number, runs = 3): Stratum => ({
  baseline,
  candidate,
  runs,
});
const p = (...strata: Stratum[]) => stratifiedExactTest(strata).pValue as number;

/**
 * The same p by brute force: every way to hand each task's 2R rollouts to the two arms (R each),
 * counting the assignments whose candidate arms hold at least the observed passes.
 */
function bruteP(strata: Stratum[]): number {
  const perTask = strata.map((t) => {
    const outcomes = [
      ...Array<number>(t.baseline + t.candidate).fill(1),
      ...Array<number>(2 * t.runs - t.baseline - t.candidate).fill(0),
    ];
    const sums: number[] = [];
    const pick = (from: number, left: number, sum: number) => {
      if (left === 0) {
        sums.push(sum);
        return;
      }
      for (let i = from; i <= outcomes.length - left; i++) {
        pick(i + 1, left - 1, sum + (outcomes[i] as number));
      }
    };
    pick(0, t.runs, 0);
    return sums;
  });
  const observed = strata.reduce((c, t) => c + t.candidate, 0);
  let hit = 0;
  let total = 0;
  const walk = (i: number, sum: number) => {
    if (i === perTask.length) {
      total++;
      if (sum >= observed) hit++;
      return;
    }
    for (const x of perTask[i] as number[]) walk(i + 1, sum + x);
  };
  walk(0, 0);
  return hit / total;
}

describe('stratifiedExactTest (06 §5.2)', () => {
  it('choose is exact', () => {
    expect(choose(6, 3)).toBe(20n);
    expect(choose(60, 30)).toBe(118264581564861424n);
    expect(choose(3, 4)).toBe(0n);
  });

  it('gives p = null and minP = null with zero strata', () => {
    expect(stratifiedExactTest([])).toEqual({ pValue: null, minP: null, diff: 0, strata: 0 });
  });

  it('is deterministic: there is no seed and no resampling', () => {
    const strata = [s(0, 2), s(1, 3), s(2, 2)];
    expect(stratifiedExactTest(strata)).toEqual(stratifiedExactTest(strata));
  });

  it('gives p = 1 for identical arms, and for a candidate that only regresses', () => {
    expect(p(s(3, 3), s(0, 0), s(2, 2))).toBeGreaterThan(0.5);
    expect(p(s(0, 0), s(0, 0))).toBe(1);
    expect(p(s(3, 3), s(3, 3))).toBe(1);
    expect(p(s(3, 0), s(3, 2))).toBe(1);
  });

  it('when every task improves p is the exact tail, never 0 (the bootstrap said 0 here)', () => {
    // One task, one extra pass (0/3 → 1/3): the bootstrap over task means gave p = 0.
    expect(p(s(0, 1))).toBe(0.5);
    // Two tasks, each one extra pass: the bootstrap gave p = 0; exactly it is 1/4.
    expect(p(s(0, 1), s(0, 1))).toBe(0.25);
    // Three tasks, every one improving by one or two passes.
    expect(p(s(0, 3), s(0, 1), s(1, 2))).toBeCloseTo(bruteP([s(0, 3), s(0, 1), s(1, 2)]), 12);
    expect(p(s(0, 3), s(0, 1), s(1, 2))).toBeGreaterThan(0);
    // The smallest p this shape can give at all: both tasks 0/3 → 3/3.
    expect(p(s(0, 3), s(0, 3))).toBe(1 / 400);
    expect(p(s(0, 3))).toBe(1 / 20);
  });

  it('known answers on 2 tasks × 3 runs', () => {
    expect(p(s(0, 3), s(0, 2))).toBeCloseTo(0.01, 12);
    expect(p(s(0, 3), s(0, 1))).toBeCloseTo(0.025, 12);
    expect(p(s(0, 2), s(0, 2))).toBeCloseTo(0.04, 12);
    expect(p(s(0, 3), s(0, 0))).toBeCloseTo(0.05, 12);
    expect(p(s(0, 2), s(0, 1))).toBeCloseTo(0.1, 12);
  });

  it('matches brute-force enumeration of every arm assignment', () => {
    const cases: Stratum[][] = [
      [s(1, 2), s(0, 3)],
      [s(2, 3), s(1, 1), s(0, 2)],
      [s(1, 3, 4), s(2, 2, 4)],
      [s(0, 1, 1), s(0, 1, 1), s(1, 1, 1), s(0, 1, 1)],
      [s(3, 1), s(0, 3), s(2, 3)],
    ];
    for (const c of cases) expect(p(...c)).toBeCloseTo(bruteP(c), 12);
  });

  it('minP is the best any candidate could do against the baseline', () => {
    // Baseline 0/3 on both: the shape minimum 1/400.
    expect(stratifiedExactTest([s(0, 0), s(0, 0)]).minP).toBe(1 / 400);
    expect(shapeMinP(2, 3)).toBe(1 / 400);
    expect(shapeMinP(1, 3)).toBe(1 / 20);
    expect(shapeMinP(0, 3)).toBeNull();
    // A saturated task cannot improve: it contributes nothing.
    expect(stratifiedExactTest([s(3, 3), s(0, 1)]).minP).toBe(1 / 20);
    // 2/3 and 1/3: (10/20) × (4/20) = 0.1, so no candidate outcome is significant at 0.05.
    expect(stratifiedExactTest([s(2, 2), s(1, 0)]).minP).toBeCloseTo(0.1, 12);
    // minP is reached by the all-pass candidate, and by nothing below it.
    for (const [a, b] of [
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 2],
    ] as const) {
      const best = p(s(a, 3), s(b, 3));
      expect(stratifiedExactTest([s(a, 1), s(b, 0)]).minP).toBeCloseTo(best, 12);
    }
  });

  it('does not depend on candidate-independent task order', () => {
    expect(p(s(0, 3), s(1, 2), s(2, 2))).toBe(p(s(2, 2), s(0, 3), s(1, 2)));
  });

  it('rejects impossible pass counts', () => {
    expect(() => stratifiedExactTest([s(4, 0)])).toThrow(/within 0\.\.runs/);
    expect(() => stratifiedExactTest([s(0, 1, 0)])).toThrow(/within 0\.\.runs/);
  });
});

// ---- operating characteristics of the shipped shape (06 §5.2 table) ---------------------------

const R = 3;
const ALPHA = 0.05;
const binom = (k: number, theta: number) =>
  Number(choose(R, k)) * theta ** k * (1 - theta) ** (R - k);

/**
 * P(p < alpha) for ONE model on `tasks` slice tasks × 3 runs, by exhaustive enumeration of every
 * (baseline, candidate) pass-count table: each arm's passes are binomial(3, θ). `frozen` fixes the
 * baseline's pass counts instead (a stored baseline reused across proposals).
 */
function rejectRate(thetaBase: number, thetaCand: number, tasks = 2, frozen?: number[]): number {
  let total = 0;
  const walk = (i: number, strata: Stratum[], pr: number) => {
    if (pr === 0) return;
    if (i === tasks) {
      const t = stratifiedExactTest(strata);
      if ((t.pValue as number) < ALPHA) total += pr;
      return;
    }
    for (let b = 0; b <= R; b++) {
      const pb = frozen ? (frozen[i] === b ? 1 : 0) : binom(b, thetaBase);
      if (pb === 0) continue;
      for (let c = 0; c <= R; c++) {
        walk(i + 1, [...strata, s(b, c)], pr * pb * binom(c, thetaCand));
      }
    }
  };
  walk(0, [], 1);
  return total;
}

describe('operating characteristics, shipped shape: 2 slice tasks × 3 runs (06 §5.2)', () => {
  it('type-I rate with identical arms is at most 1.93% per model, at every pass rate', () => {
    const table: [number, number][] = [
      [0, 0],
      [0.1, 0.0007],
      [0.2, 0.0051],
      [0.3, 0.0118],
      [0.5, 0.0193],
      [0.7, 0.0118],
      [0.9, 0.0007],
      [1, 0],
    ];
    for (const [theta, want] of table) expect(rejectRate(theta, theta)).toBeCloseTo(want, 4);
    let worst = 0;
    for (let t = 0; t <= 100; t++) worst = Math.max(worst, rejectRate(t / 100, t / 100));
    expect(worst).toBeCloseTo(0.0193, 4);
    expect(worst).toBeLessThan(ALPHA);
    // High radius needs both models: independent arms multiply.
    expect(worst ** 2).toBeLessThan(0.0004);
  });

  it('power per model', () => {
    const table: [number, number, number][] = [
      [0, 1, 1],
      [0, 0.9, 0.9842],
      [0, 2 / 3, 0.6804],
      [0, 0.5, 0.3438],
      [0, 1 / 3, 0.1001],
      [0.1, 0.9, 0.8891],
      [0.2, 0.8, 0.5583],
      [1 / 3, 1, 0.6804],
      [0.5, 1, 0.3438],
    ];
    for (const [a, b, want] of table) expect(rejectRate(a, b)).toBeCloseTo(want, 4);
  });

  it('a frozen all-zero baseline: the false-accept rate conditional on it, and how often it arises', () => {
    // identical arms at pass rate θ; the stored baseline happened to draw 0/3 on both tasks
    const table: [number, number, number][] = [
      [0.05, 0.0001, 0.7351],
      [0.1, 0.0013, 0.5314],
      [0.2, 0.017, 0.2621],
      [0.3, 0.0705, 0.1176],
      [0.5, 0.3438, 0.0156],
    ];
    for (const [theta, conditional, arises] of table) {
      expect(rejectRate(theta, theta, 2, [0, 0])).toBeCloseTo(conditional, 4);
      expect((1 - theta) ** 6).toBeCloseTo(arises, 4);
      // Over the draw of the baseline the rate is the unconditional one: within alpha.
      expect(rejectRate(theta, theta)).toBeLessThan(ALPHA);
    }
  });

  it('one slice task × 3 runs can never reject: the gate is underpowered there', () => {
    expect(shapeMinP(1, 3)).not.toBeLessThan(ALPHA);
    for (const theta of [0, 0.3, 0.5, 1]) {
      expect(rejectRate(theta, theta, 1)).toBe(0);
      expect(rejectRate(0, 1, 1)).toBe(0);
    }
  });
});
