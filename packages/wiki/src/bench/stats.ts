import type { EvaluationRecord } from '../schema/bench';

/**
 * Gate statistics (vision 06 §5.2): per-task pass counts over runs, and an exact stratified
 * permutation test with the ROLLOUT as the unit and the task as the stratum. Pure, exact and
 * deterministic: there is no resampling and no seed, so the same outcomes always give the same
 * p-value, and no caller-chosen string can re-draw a borderline case (13 §2.7, recompute).
 */

export type BenchOutcome = EvaluationRecord['outcomes'][number];
export type GateMode = BenchOutcome['mode'];

/** The version of the gate's decision algorithm, recorded in every GateInputRecord (08 §10.4).
 * 1: paired bootstrap over task means, one-task-mean thresholds (records without the field).
 * 2: exact stratified permutation test on the patched skill's slice; non-regression is a fixed
 *    count of passes, max(1, ⌊nonRegressionFraction × objective rollouts⌋) (legacy).
 * 3: as 2, with non-regression decided by the same exact test in the other direction: a cell is a
 *    regression when the one-sided p for "the candidate is worse" is ≤ alpha (06 §5.4).
 * New gates are made with this version; a stored record is re-derived with its own. */
export const GATE_ALGORITHM = 3;

/** The algorithm versions this build can decide and recompute (06 §5.8). Version 1 is not among
 * them: its records are reported as made with an older algorithm and stand as recorded. */
export const SUPPORTED_GATE_ALGORITHMS: readonly number[] = [2, 3];

/** The first version whose non-regression rule is the exact test; below it, the fixed count. */
export const EXACT_NON_REGRESSION_SINCE = 3;

/** Per-task pass counts and mean for one model and mode. */
export interface TaskMean {
  task: string;
  passes: number;
  runs: number;
  mean: number;
}

/** Per-task pass counts over runs for one model × mode, keyed by task id. */
export function perTaskMeans(
  outcomes: readonly BenchOutcome[],
  model: string,
  mode: GateMode,
): Map<string, TaskMean> {
  const out = new Map<string, TaskMean>();
  for (const o of outcomes) {
    if (o.model !== model || o.mode !== mode) continue;
    const t = out.get(o.task) ?? { task: o.task, passes: 0, runs: 0, mean: 0 };
    t.passes += o.score;
    t.runs += 1;
    t.mean = t.passes / t.runs;
    out.set(o.task, t);
  }
  return out;
}

/** Arithmetic mean; 0 for an empty list. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** n choose k, exactly. 0 outside 0 ≤ k ≤ n. */
export function choose(n: number, k: number): bigint {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0n;
  const m = Math.min(k, n - k);
  let r = 1n;
  for (let i = 1; i <= m; i++) r = (r * BigInt(n - m + i)) / BigInt(i);
  return r;
}

/** One task: passes out of `runs` rollouts on each arm. */
export interface Stratum {
  baseline: number;
  candidate: number;
  runs: number;
}

/** The alternative a one-sided test is run against: the candidate passes more often than the
 * baseline (`greater`, the efficacy test) or less often (`less`, the non-regression test). */
export type ExactTestTail = 'greater' | 'less';

export interface ExactTestResult {
  /** One-sided p under the null: P(Σ candidate passes ≥ observed) for `greater`,
   * P(Σ candidate passes ≤ observed) for `less`. `null` with no strata. */
  pValue: number | null;
  /** The smallest p ANY candidate outcome could reach against this baseline: every candidate
   * rollout passing (`greater`) or failing (`less`). `null` with no strata. A test whose `minP`
   * is above the level it is compared with cannot reject. */
  minP: number | null;
  /** Σ candidate passes − Σ baseline passes. */
  diff: number;
  strata: number;
}

const SCALE = 10n ** 18n;
/** num / den as a float, by exact integer division (deterministic at any size). */
const ratio = (num: bigint, den: bigint): number => Number((num * SCALE) / den) / 1e18;

function checkStratum(s: Stratum): void {
  const ok = (x: number) => Number.isInteger(x) && x >= 0 && x <= s.runs;
  if (!Number.isInteger(s.runs) || s.runs < 1 || !ok(s.baseline) || !ok(s.candidate)) {
    throw new Error(
      `a stratum needs integer pass counts within 0..runs (baseline ${s.baseline}, candidate ${s.candidate}, runs ${s.runs})`,
    );
  }
}

/**
 * The exact stratified permutation test (06 §5.2). Null hypothesis: within each task, a rollout's
 * outcome does not depend on its arm, so the 2R rollouts of a task are exchangeable. Conditional on
 * each task's total passes m_t, the candidate's passes C_t are then hypergeometric(2R, m_t, R),
 * independently across tasks. The statistic is Σ_t C_t; its null distribution is the exact
 * convolution of the per-task distributions, computed in integers, and the one-sided p-value is
 * P(Σ C_t ≥ observed) for the `greater` tail (the default) or P(Σ C_t ≤ observed) for the `less`
 * tail. The two tails are the same test with the arms exchanged: the `less` p of (baseline,
 * candidate) equals the `greater` p of (candidate, baseline). No normal approximation, no
 * resampling.
 */
export function stratifiedExactTest(
  strata: readonly Stratum[],
  tail: ExactTestTail = 'greater',
): ExactTestResult {
  for (const s of strata) checkStratum(s);
  const diff = strata.reduce((d, s) => d + s.candidate - s.baseline, 0);
  if (strata.length === 0) return { pValue: null, minP: null, diff: 0, strata: 0 };
  // dist[k] = number of arm assignments (over the strata so far) whose candidate arms hold k passes.
  let dist: bigint[] = [1n];
  let total = 1n;
  let minNum = 1n;
  for (const s of strata) {
    const m = s.baseline + s.candidate;
    const next: bigint[] = new Array(dist.length + s.runs).fill(0n);
    for (let k = Math.max(0, m - s.runs); k <= Math.min(m, s.runs); k++) {
      const w = choose(m, k) * choose(2 * s.runs - m, s.runs - k);
      for (let i = 0; i < dist.length; i++) {
        next[i + k] = (next[i + k] as bigint) + (dist[i] as bigint) * w;
      }
    }
    dist = next;
    total *= choose(2 * s.runs, s.runs);
    // Best case against this baseline. `greater`: all R candidate rollouts pass, so m = baseline + R
    // and the only arrangement at least as extreme puts R of the m passes in the candidate arm.
    // `less`: all R fail, so m = baseline and the candidate arm holds R of the 2R − m failures.
    minNum *=
      tail === 'greater'
        ? choose(s.baseline + s.runs, s.runs)
        : choose(2 * s.runs - s.baseline, s.runs);
  }
  const observed = strata.reduce((c, s) => c + s.candidate, 0);
  let mass = 0n;
  if (tail === 'greater') {
    for (let k = observed; k < dist.length; k++) mass += dist[k] as bigint;
  } else {
    for (let k = 0; k <= observed; k++) mass += dist[k] as bigint;
  }
  return {
    pValue: ratio(mass, total),
    minP: ratio(minNum, total),
    diff,
    strata: strata.length,
  };
}

/** The smallest p the test can reach for a shape, whatever the baseline: `tasks` strata of `runs`
 * rollouts per arm, baseline all failing and candidate all passing: C(2R, R)^−tasks. */
export function shapeMinP(tasks: number, runs: number): number | null {
  if (tasks < 1) return null;
  return ratio(1n, choose(2 * runs, runs) ** BigInt(tasks));
}
