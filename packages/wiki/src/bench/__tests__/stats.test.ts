import { describe, expect, it } from 'vitest';
import { outcome } from '../../__tests__/fixtures/policy/vectors';
import { mean, pairedBootstrap, perTaskMeans, seededRandom } from '../stats';

describe('seededRandom', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = seededRandom('s1');
    const b = seededRandom('s1');
    const c = seededRandom('s2');
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('is roughly uniform', () => {
    const r = seededRandom('uniform');
    const n = 20000;
    let s = 0;
    for (let i = 0; i < n; i++) s += r();
    expect(s / n).toBeGreaterThan(0.48);
    expect(s / n).toBeLessThan(0.52);
  });
});

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

/** Exact one-sided p of the bootstrap by enumerating all n^n resamples (small n only). */
function exactP(diffs: number[]): number {
  const n = diffs.length;
  let hit = 0;
  let total = 0;
  const idx = new Array<number>(n).fill(0);
  for (;;) {
    total++;
    if (idx.reduce((s, i) => s + (diffs[i] as number), 0) <= 1e-9) hit++;
    let k = 0;
    while (k < n && idx[k] === n - 1) idx[k++] = 0;
    if (k === n) break;
    idx[k] = (idx[k] as number) + 1;
  }
  return hit / total;
}

describe('pairedBootstrap (06 §5.2)', () => {
  it('records its seed and resample count, and is deterministic', () => {
    const a = pairedBootstrap([0, 0, 1, 0], [1, 0, 1, 1], { seed: 'p1' });
    const b = pairedBootstrap([0, 0, 1, 0], [1, 0, 1, 1], { seed: 'p1' });
    expect(a).toEqual(b);
    expect(a.seed).toBe('p1');
    expect(a.resamples).toBe(1000);
    expect(a.tasks).toBe(4);
    expect(a.meanDiff).toBeCloseTo(0.5);
  });

  it('gives p = null with zero tasks', () => {
    expect(pairedBootstrap([], [], { seed: 'x' }).pValue).toBeNull();
  });

  it('gives p = 1 for identical results (every difference is 0, and 0 counts as ≤ 0)', () => {
    expect(pairedBootstrap([1, 0, 2 / 3], [1, 0, 2 / 3], { seed: 'x' }).pValue).toBe(1);
  });

  it('gives p = 0 when every task improves', () => {
    expect(pairedBootstrap([0, 0, 1 / 3], [1, 1 / 3, 2 / 3], { seed: 'x' }).pValue).toBe(0);
  });

  it('gives p = 1 when every task regresses', () => {
    expect(pairedBootstrap([1, 1], [0, 2 / 3], { seed: 'x' }).pValue).toBe(1);
  });

  it('matches the exact enumeration within sampling error (known answers)', () => {
    const cases: [number[], number[]][] = [
      [
        [0, 1],
        [1, 0],
      ], // diffs +1, −1: p = 3/4
      [
        [0, 0, 0, 0],
        [1, 0, 0, 0],
      ], // one improvement: p = (3/4)^4
      [
        [0, 0, 1, 1, 0],
        [1, 1 / 3, 1, 2 / 3, 0],
      ],
    ];
    for (const [b, c] of cases) {
      const diffs = b.map((x, i) => (c[i] as number) - x);
      const exact = exactP(diffs);
      const got = pairedBootstrap(b, c, { seed: 'known', resamples: 20000 }).pValue as number;
      expect(Math.abs(got - exact)).toBeLessThan(0.015);
    }
    expect(exactP([1, -1])).toBe(0.75);
    expect(exactP([1, 0, 0, 0])).toBeCloseTo(0.75 ** 4);
  });

  it('pins the p-value for a fixed seed (a regression guard on the PRNG and resampling)', () => {
    const p = pairedBootstrap([0, 0, 0, 0, 0, 1, 1, 1, 1, 1], [1, 1, 0, 0, 0, 1, 1, 1, 1, 1], {
      seed: 'gate:pin',
    }).pValue;
    // (8/10)^10 ≈ 0.107 is the exact answer; the pinned sample is what this seed produces.
    expect(p).toBe(0.104);
    expect(
      pairedBootstrap([0, 0, 0, 0, 0, 1, 1, 1, 1, 1], [1, 1, 0, 0, 0, 1, 1, 1, 1, 1], {
        seed: 'gate:pin',
      }).pValue,
    ).toBe(p);
  });

  it('rejects mismatched lengths and bad resample counts', () => {
    expect(() => pairedBootstrap([1], [1, 0], { seed: 'x' })).toThrow(/equal-length/);
    expect(() => pairedBootstrap([1], [1], { seed: 'x', resamples: 0 })).toThrow(/resamples/);
  });
});
