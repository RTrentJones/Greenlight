import type { BlastRadius, GatePath, PolicyInput, PolicyTask } from '../../../bench/policy';
import type { BenchOutcome, GateMode } from '../../../bench/stats';

/**
 * Policy boundary vectors (vision 13 §2.8): evidence at every threshold edge of the 06 §5.4 table.
 * Each vector perturbs ONE target cell (model × mode) of an otherwise clean evaluation, and is run
 * for every blast radius and every target cell. Its expected outcome is stored beside it:
 *
 *   expect[radius] = four letters, one per target cell, in the order
 *                    frontier/isolation, frontier/production, small/isolation, small/production
 *   A = accept, R = reject, I = invalid, N = no-action (early stop)
 *
 * The clean world: 2 replay tasks at 3/3; 10 capability tasks, baseline c1–c5 at 3/3 and c6–c10 at
 * 0/3 (one task-mean = 3 passes = 0.1); isolation candidate lifts c6–c9 to 3/3 (+4 task-means,
 * bootstrap p ≈ 0.006); production candidate equals the baseline. Every vector also carries a
 * pending and a quarantined replay task whose candidate would regress (0/3) — they must be excluded.
 *
 * Changing the policy so that a vector's outcome changes fails CI until this table and 06 §5.4 are
 * updated together.
 */

export const F = 'model-frontier';
export const S = 'model-small';
export const RUNS = 3;
export const RADII: readonly BlastRadius[] = ['high', 'medium', 'low'];
export const CELLS: readonly { model: string; mode: GateMode }[] = [
  { model: F, mode: 'isolation' },
  { model: F, mode: 'production' },
  { model: S, mode: 'isolation' },
  { model: S, mode: 'production' },
];

const CAP = Array.from({ length: 10 }, (_, i) => `cap/c${i + 1}`);

export const TASKS: PolicyTask[] = [
  { id: 'replay/a', kind: 'replay', state: 'active' },
  { id: 'replay/b', kind: 'replay', state: 'active' },
  { id: 'replay/t', kind: 'replay', state: 'active' },
  { id: 'replay/p', kind: 'replay', state: 'pending' },
  { id: 'replay/q', kind: 'replay', state: 'quarantined' },
  ...CAP.map((id) => ({ id, kind: 'capability' as const, state: 'active' as const })),
];

/** passes[side][task] for one cell; runs 1..passes pass, the rest fail. */
export type CellWorld = { base: Record<string, number>; cand: Record<string, number> };

export function cleanCell(mode: GateMode): CellWorld {
  const base: Record<string, number> = {
    'replay/a': 3,
    'replay/b': 3,
    'replay/t': 3,
    'replay/p': 3,
    'replay/q': 3,
  };
  CAP.forEach((id, i) => {
    base[id] = i < 5 ? 3 : 0;
  });
  const cand: Record<string, number> = { ...base, 'replay/p': 0, 'replay/q': 0 };
  if (mode === 'isolation') for (const id of CAP.slice(5, 9)) cand[id] = 3;
  return { base, cand };
}

export interface Vector {
  id: string;
  path: GatePath;
  /** Mutates every cell (e.g. a safety-fix target that fails in every baseline). */
  all?: (w: CellWorld, mode: GateMode) => void;
  /** Mutates the target cell only. */
  target?: (w: CellWorld, mode: GateMode) => void;
  /** Pins the target cell's p-value (isolation only; production computes none). */
  pTarget?: number;
  /** The target cell's candidate run 1 of replay/a is served by the other model. */
  fallbackTarget?: boolean;
  extra?: Partial<PolicyInput>;
  /** Evaluate the early stop instead of the gate. */
  earlyStop?: boolean;
  expect: Record<BlastRadius, string>;
  /** A reason code every rejection of this vector must carry. */
  rejectCode?: string;
}

const noGain = (w: CellWorld) => {
  for (const id of CAP) w.cand[id] = w.base[id] as number;
};

export const VECTORS: Vector[] = [
  {
    id: 'replay-3of3',
    path: 'standard',
    target: (w) => {
      w.cand['replay/a'] = 3;
    },
    expect: { high: 'AAAA', medium: 'AAAA', low: 'AAAA' },
  },
  {
    id: 'replay-2of3',
    path: 'standard',
    target: (w) => {
      w.cand['replay/a'] = 2;
    },
    expect: { high: 'RRRR', medium: 'AAAA', low: 'AAAA' },
    rejectCode: 'replay-regression',
  },
  {
    id: 'replay-1of3',
    path: 'standard',
    target: (w) => {
      w.cand['replay/a'] = 1;
    },
    expect: { high: 'RRRR', medium: 'RRRR', low: 'RRRR' },
    rejectCode: 'replay-regression',
  },
  {
    id: 'flaky-baseline-2of3',
    path: 'standard',
    target: (w) => {
      w.base['replay/b'] = 2;
    },
    expect: { high: 'RRRR', medium: 'AAAA', low: 'AAAA' },
    rejectCode: 'flaky-baseline',
  },
  {
    id: 'flaky-baseline-1of3',
    path: 'standard',
    target: (w) => {
      w.base['replay/b'] = 1;
    },
    expect: { high: 'RRRR', medium: 'AAAA', low: 'AAAA' },
    rejectCode: 'flaky-baseline',
  },
  {
    id: 'p-0.049',
    path: 'standard',
    pTarget: 0.049,
    expect: { high: 'AAAA', medium: 'AAAA', low: 'AAAA' },
  },
  {
    id: 'p-0.050',
    path: 'standard',
    pTarget: 0.05,
    expect: { high: 'RARA', medium: 'RAAA', low: 'RAAA' },
    rejectCode: 'not-significant',
  },
  {
    id: 'p-0.051',
    path: 'standard',
    pTarget: 0.051,
    expect: { high: 'RARA', medium: 'RAAA', low: 'RAAA' },
    rejectCode: 'not-significant',
  },
  {
    // Δ = −1 task-mean exactly: "no worse than / no regression beyond one task-mean" holds;
    // strict improvement does not.
    id: 'capability-drop-exactly-one-task-mean',
    path: 'standard',
    target: (w) => {
      noGain(w);
      w.cand['cap/c1'] = 0;
    },
    expect: { high: 'RARA', medium: 'RAAA', low: 'RAAA' },
    rejectCode: 'no-strict-improvement',
  },
  {
    // Δ = −4 passes: one run beyond one task-mean.
    id: 'capability-drop-beyond-one-task-mean',
    path: 'standard',
    target: (w) => {
      noGain(w);
      w.cand['cap/c1'] = 0;
      w.cand['cap/c2'] = 2;
    },
    expect: { high: 'RRRR', medium: 'RRRR', low: 'RRAA' },
  },
  {
    // Δ = 0 in the target cell: not a strict improvement (isolation), fine in production.
    id: 'capability-unchanged',
    path: 'standard',
    target: (w) => noGain(w),
    expect: { high: 'RARA', medium: 'RAAA', low: 'RAAA' },
    rejectCode: 'no-strict-improvement',
  },
  {
    id: 'safety-fix-target-1of3-to-2of3',
    path: 'safety-fix',
    extra: { safetyFixTargets: ['replay/t'] },
    all: (w) => {
      noGain(w);
      w.base['replay/t'] = 1;
      w.cand['replay/t'] = 3;
    },
    target: (w) => {
      w.cand['replay/t'] = 2;
    },
    // high: a 1/3 target is a flaky baseline task, and 2/3 is short of 3/3 anyway.
    expect: { high: 'RRRR', medium: 'AAAA', low: 'AAAA' },
  },
  {
    id: 'safety-fix-target-0of3-to-3of3',
    path: 'safety-fix',
    extra: { safetyFixTargets: ['replay/t'] },
    all: (w) => {
      noGain(w);
      w.base['replay/t'] = 0;
      w.cand['replay/t'] = 3;
    },
    expect: { high: 'AAAA', medium: 'AAAA', low: 'AAAA' },
  },
  {
    id: 'safety-fix-target-stays-1of3',
    path: 'safety-fix',
    extra: { safetyFixTargets: ['replay/t'] },
    all: (w) => {
      noGain(w);
      w.base['replay/t'] = 1;
      w.cand['replay/t'] = 3;
    },
    target: (w) => {
      w.cand['replay/t'] = 1;
    },
    expect: { high: 'RRRR', medium: 'RRRR', low: 'RRRR' },
    rejectCode: 'safety-fix-target-not-fixed',
  },
  {
    // safety-fix replaces efficacy, never non-regression: one run beyond a task-mean rejects in
    // every cell (alternative paths check every model and mode).
    id: 'safety-fix-capability-drop-beyond',
    path: 'safety-fix',
    extra: { safetyFixTargets: ['replay/t'] },
    all: (w) => {
      noGain(w);
      w.base['replay/t'] = 0;
      w.cand['replay/t'] = 3;
    },
    target: (w) => {
      w.cand['cap/c1'] = 0;
      w.cand['cap/c2'] = 2;
    },
    expect: { high: 'RRRR', medium: 'RRRR', low: 'RRRR' },
  },
  {
    id: 'neutral-with-reason',
    path: 'neutral',
    extra: { neutralReason: 'renames a section that mechanism X references' },
    all: (w) => noGain(w),
    expect: { high: 'AAAA', medium: 'AAAA', low: 'AAAA' },
  },
  {
    id: 'neutral-without-reason',
    path: 'neutral',
    all: (w) => noGain(w),
    expect: { high: 'RRRR', medium: 'RRRR', low: 'RRRR' },
    rejectCode: 'neutral-needs-reason',
  },
  {
    id: 'neutral-production-drop-exactly-one-task-mean',
    path: 'neutral',
    extra: { neutralReason: 'prerequisite for proposal P' },
    all: (w) => noGain(w),
    target: (w) => {
      w.cand['cap/c1'] = 0;
    },
    expect: { high: 'AAAA', medium: 'AAAA', low: 'AAAA' },
  },
  {
    id: 'fallback-served',
    path: 'standard',
    fallbackTarget: true,
    expect: { high: 'IIII', medium: 'IIII', low: 'IIII' },
  },
  {
    id: 'early-stop-at-R-1.0',
    path: 'standard',
    earlyStop: true,
    all: (w) => {
      for (const id of CAP) w.base[id] = 3;
    },
    expect: { high: 'NNNN', medium: 'NNNN', low: 'NNNN' },
  },
];

export function outcome(
  task: string,
  run: number,
  model: string,
  mode: GateMode,
  pass: boolean,
  servedBy = model,
): BenchOutcome {
  return {
    task,
    run,
    model,
    mode,
    score: pass ? 1 : 0,
    graders: [{ kind: 'app', passed: pass }],
    seed: `seed-${run}`,
    rawId: `raw-${task}-${run}-${model}-${mode}`,
    durationMs: 1000,
    servedBy,
    cost: { usd: 0, requests: 5, tokensIn: 100, tokensOut: 50 },
  };
}

/** Expands a cell world to run-level outcomes. */
export function expand(
  w: Record<string, number>,
  model: string,
  mode: GateMode,
  runs = RUNS,
): BenchOutcome[] {
  const out: BenchOutcome[] = [];
  for (const [task, passes] of Object.entries(w)) {
    for (let run = 1; run <= runs; run++) out.push(outcome(task, run, model, mode, run <= passes));
  }
  return out;
}

/** Builds the policy input of a vector for one radius and target cell. */
export function buildVector(
  v: Vector,
  radius: BlastRadius,
  targetIdx: number,
): { input: PolicyInput; baseline: BenchOutcome[] } {
  const target = CELLS[targetIdx] as (typeof CELLS)[number];
  const baseline: BenchOutcome[] = [];
  const candidate: BenchOutcome[] = [];
  for (const c of CELLS) {
    const w = cleanCell(c.mode);
    v.all?.(w, c.mode);
    const isTarget = c.model === target.model && c.mode === target.mode;
    if (isTarget) v.target?.(w, c.mode);
    baseline.push(...expand(w.base, c.model, c.mode));
    const cand = expand(w.cand, c.model, c.mode);
    if (isTarget && v.fallbackTarget) {
      const i = cand.findIndex((o) => o.task === 'replay/a' && o.run === 1);
      cand[i] = { ...(cand[i] as BenchOutcome), servedBy: c.model === F ? S : F };
    }
    candidate.push(...cand);
  }
  const input: PolicyInput = {
    radius,
    path: v.path,
    models: { frontier: F, small: S },
    modes: ['isolation', 'production'],
    tasks: TASKS,
    baseline,
    candidate,
    seed: `vector:${v.id}`,
    ...v.extra,
  };
  if (v.pTarget !== undefined) {
    const pinned = v.pTarget;
    input.pValue = (a) =>
      a.model === target.model && a.mode === target.mode
        ? pinned
        : // a clearly significant p elsewhere, so only the target cell sits on the edge
          0.001;
  }
  return { input, baseline };
}
