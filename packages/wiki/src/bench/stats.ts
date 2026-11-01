import { createHash } from 'node:crypto';
import type { EvaluationRecord } from '../schema/bench';

/**
 * Gate statistics (vision 06 §5.2): per-task means over runs, and a paired bootstrap over tasks.
 * Pure and deterministic: the bootstrap's PRNG is seeded from a recorded seed string, so the same
 * outcomes and seed always give the same p-value (13 §2.7, recompute).
 */

export type BenchOutcome = EvaluationRecord['outcomes'][number];
export type GateMode = BenchOutcome['mode'];

/** The paper's resample count (06 §5.2). */
export const DEFAULT_RESAMPLES = 1000;

/** Per-task pass counts and mean for one model and mode. */
export interface TaskMean {
  task: string;
  passes: number;
  runs: number;
  mean: number;
}

/** Per-task means over runs for one model × mode, keyed by task id (06 §5.2, "Pairing"). */
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

/** Arithmetic mean; 0 for an empty list (callers report `pValue: null` in that case). */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * A seeded PRNG (sfc32) returning floats in [0, 1). The 128-bit state is the first 16 bytes of
 * sha256(seed), so any string is a valid seed and equal seeds give equal streams.
 */
export function seededRandom(seed: string): () => number {
  const h = createHash('sha256').update(seed).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Discard the first outputs so seeds that share a hash prefix pattern still decorrelate.
  for (let i = 0; i < 12; i++) next();
  return next;
}

export interface BootstrapResult {
  /** One-sided p: the fraction of resamples whose mean difference is ≤ 0. `null` with no tasks. */
  pValue: number | null;
  /** Observed mean of the per-task differences (candidate − baseline). */
  meanDiff: number;
  tasks: number;
  resamples: number;
  seed: string;
}

/** Differences are multiples of 1/runs; this absorbs float error when testing "≤ 0". */
const EPS = 1e-9;

/**
 * Paired bootstrap over tasks (06 §5.2): resample task indices with replacement `resamples` times,
 * compute the mean of the paired differences each time, and report the fraction ≤ 0.
 * Identical inputs give p = 1 (every resample's difference is 0). Zero tasks give p = null.
 */
export function pairedBootstrap(
  baseline: readonly number[],
  candidate: readonly number[],
  opts: { seed: string; resamples?: number },
): BootstrapResult {
  if (baseline.length !== candidate.length) {
    throw new Error(
      `paired bootstrap needs equal-length inputs (baseline ${baseline.length}, candidate ${candidate.length})`,
    );
  }
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new Error(`resamples must be a positive integer, got ${resamples}`);
  }
  const n = baseline.length;
  const diffs = baseline.map((b, i) => (candidate[i] as number) - b);
  const meanDiff = mean(diffs);
  if (n === 0) return { pValue: null, meanDiff: 0, tasks: 0, resamples, seed: opts.seed };
  const rand = seededRandom(opts.seed);
  let atOrBelowZero = 0;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)] as number;
    if (sum / n <= EPS) atOrBelowZero++;
  }
  return { pValue: atOrBelowZero / resamples, meanDiff, tasks: n, resamples, seed: opts.seed };
}
