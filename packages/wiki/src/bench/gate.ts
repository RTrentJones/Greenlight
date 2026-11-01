import { z } from 'zod';
import {
  type BaselineIdentity,
  type EvaluationRecord,
  EvaluationRecordSchema,
  comparable,
  identityDiff,
} from '../schema/bench';
import { canonicalJson } from '../schema/common';
import { type GateResult, type LedgerEvent, LedgerEventSchema, sealEvent } from '../schema/ledger';
import {
  type BlastRadius,
  type GatePath,
  type PolicyDecision,
  type PolicyReason,
  type PolicyTask,
  applyPolicy,
  earlyStop,
  releasePolicy,
} from './policy';
import { DEFAULT_RESAMPLES, type GateMode } from './stats';

/**
 * The gate (vision 06 §5.1–§5.8, roadmap M1-08): checks baseline identity, applies the single
 * policy table (policy.ts), and builds the sealed ledger event. `recompute` re-derives a stored
 * decision from EvaluationRecords alone (`bench gate --recompute <hash>`); `releaseCheck` is §5.7.
 * Pure: no clock, no network — the caller passes `ts`.
 */

/** `bench/gate.json` (07 §3.10). Unknown keys (e.g. the monitor threshold) are ignored here. */
export const GateConfigSchema = z.object({
  alpha: z.number().gt(0).lt(1).default(0.05),
  runs: z.number().int().min(1).default(3),
  resamples: z.number().int().min(1).default(DEFAULT_RESAMPLES),
  acceptShorterOnTie: z.boolean().default(false),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

export function loadGateConfig(json: unknown): GateConfig {
  return GateConfigSchema.parse(json ?? {});
}

/** A harness error: the comparison itself is broken (06 §1.5). Never reported as a gate result. */
export class GateHarnessError extends Error {
  constructor(
    message: string,
    readonly fields: string[] = [],
  ) {
    super(message);
    this.name = 'GateHarnessError';
  }
}

export interface GateContext {
  /** Event timestamp (ISO). Passing the recorded event's ts to `recompute` reproduces its eventId. */
  ts: string;
  radius: BlastRadius;
  path: GatePath;
  models: { frontier: string; small: string };
  /** The val tasks with kind and state (pending and quarantined are excluded, 06 §4.1). */
  tasks: readonly PolicyTask[];
  config?: Partial<GateConfig>;
  /** Bootstrap seed. Defaults to `gate:<proposalId>`, so the proposal id records it (06 §5.2). */
  seed?: string;
  safetyFixTargets?: readonly string[];
  neutralReason?: string;
  neutralPendingForSkill?: boolean;
  /** Target SKILL.md line counts, for the §5.5 tie-break. */
  skillLines?: { before: number; after: number };
  skill?: string;
  pattern?: string[];
  outlet?: 'skill' | 'template';
  control?: boolean;
}

export interface GateDecision {
  proposalId: string;
  decision: PolicyDecision;
  path: GatePath;
  results: GateResult[];
  reasons: PolicyReason[];
  tieBreak: boolean;
  seed: string;
  /** Candidate record hashes per mode; `evidence.evaluationRecord` is the first (isolation). */
  candidateRecords: string[];
  baselineRecords: string[];
  /** `candidate-accepted` / `candidate-rejected`; null when invalid (the gate re-runs or aborts,
   * 06 §4.8 — an invalid evaluation never reaches the ledger as a result). */
  ledgerEvent: LedgerEvent | null;
}

type Records = EvaluationRecord | readonly EvaluationRecord[];

function asList(r: Records): EvaluationRecord[] {
  return Array.isArray(r) ? [...r] : [r as EvaluationRecord];
}

function validated(r: EvaluationRecord): EvaluationRecord {
  const p = EvaluationRecordSchema.safeParse(r);
  if (!p.success) {
    throw new GateHarnessError(
      `evaluation record ${r.hash} is invalid: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      p.error.issues.map((i) => i.path.join('.')),
    );
  }
  return p.data;
}

/** Throws a GateHarnessError naming every differing field except skillSetHash (06 §1.5). */
export function assertComparable(
  baseline: BaselineIdentity,
  candidate: BaselineIdentity,
  label = 'baseline and candidate',
): void {
  if (comparable(baseline, candidate)) return;
  const fields = identityDiff(baseline, candidate).filter((k) => k !== 'skillSetHash');
  throw new GateHarnessError(
    `${label} are not comparable: identity differs in ${fields.join(', ')}; re-baseline first`,
    fields,
  );
}

const MODE_ORDER: readonly GateMode[] = ['isolation', 'production'];

interface Paired {
  mode: GateMode;
  baseline: EvaluationRecord;
  candidate: EvaluationRecord;
}

function pairByMode(
  baselines: EvaluationRecord[],
  candidates: EvaluationRecord[],
  roles: { baseline: EvaluationRecord['role']; candidate: EvaluationRecord['role'] },
  models: { frontier: string; small: string },
): Paired[] {
  if (candidates.length === 0) throw new GateHarnessError('no candidate evaluation record');
  for (const r of baselines) {
    if (r.role !== roles.baseline) {
      throw new GateHarnessError(`record ${r.hash} has role ${r.role}, expected ${roles.baseline}`);
    }
  }
  for (const r of candidates) {
    if (r.role !== roles.candidate) {
      throw new GateHarnessError(
        `record ${r.hash} has role ${r.role}, expected ${roles.candidate}`,
      );
    }
  }
  const pairs: Paired[] = [];
  for (const mode of MODE_ORDER) {
    const b = baselines.filter((r) => r.identity.mode === mode);
    const c = candidates.filter((r) => r.identity.mode === mode);
    if (b.length === 0 && c.length === 0) continue;
    if (b.length !== 1 || c.length !== 1) {
      throw new GateHarnessError(
        `mode ${mode} needs exactly one baseline and one candidate record (got ${b.length} and ${c.length})`,
        ['mode'],
      );
    }
    const [base, cand] = [b[0] as EvaluationRecord, c[0] as EvaluationRecord];
    assertComparable(base.identity, cand.identity);
    for (const id of [models.frontier, models.small]) {
      if (!cand.identity.models.includes(id)) {
        throw new GateHarnessError(`gate model ${id} is not in the evaluation identity`, [
          'models',
        ]);
      }
    }
    for (const r of [base, cand]) {
      const stray = r.outcomes.find((o) => o.mode !== mode);
      if (stray) {
        throw new GateHarnessError(
          `record ${r.hash} is a ${mode} evaluation but holds a ${stray.mode} outcome`,
          ['mode'],
        );
      }
    }
    pairs.push({ mode, baseline: base, candidate: cand });
  }
  return pairs;
}

/** Validates a sealed event against the ledger schema and returns it unchanged. */
function checked(e: LedgerEvent): LedgerEvent {
  LedgerEventSchema.parse(e);
  return e;
}

function summarize(reasons: PolicyReason[]): string {
  const fails = reasons.filter((r) => r.severity === 'fail');
  return fails
    .map((r) => {
      const where = [r.model, r.mode, r.task].filter(Boolean).join('/');
      return where ? `${r.code} (${where})` : r.code;
    })
    .join('; ');
}

/**
 * Decides a candidate against its baseline (06 §5.1). Records are one per mode on each side
 * (a BaselineIdentity names one mode, 08 §10.3). Mismatched identities throw GateHarnessError.
 */
export function decide(
  baselineRecord: Records,
  candidateRecord: Records,
  ctx: GateContext,
): GateDecision {
  const config = loadGateConfig(ctx.config ?? {});
  const baselines = asList(baselineRecord).map(validated);
  const candidates = asList(candidateRecord).map(validated);
  const proposalIds = [...new Set(candidates.map((r) => r.proposalId))];
  if (proposalIds.length !== 1 || !proposalIds[0]) {
    throw new GateHarnessError(
      `candidate records must name one proposal (got ${proposalIds.join(', ')})`,
      ['proposalId'],
    );
  }
  const proposalId = proposalIds[0];
  const pairs = pairByMode(
    baselines,
    candidates,
    { baseline: 'baseline', candidate: 'candidate' },
    ctx.models,
  );
  const seed = ctx.seed ?? `gate:${proposalId}`;
  const policy = applyPolicy({
    radius: ctx.radius,
    path: ctx.path,
    models: ctx.models,
    modes: pairs.map((p) => p.mode),
    tasks: ctx.tasks,
    baseline: pairs.flatMap((p) => p.baseline.outcomes),
    candidate: pairs.flatMap((p) => p.candidate.outcomes),
    runs: config.runs,
    alpha: config.alpha,
    resamples: config.resamples,
    seed,
    safetyFixTargets: ctx.safetyFixTargets,
    neutralReason: ctx.neutralReason,
    neutralPendingForSkill: ctx.neutralPendingForSkill,
    tieBreak: ctx.skillLines
      ? {
          enabled: config.acceptShorterOnTie,
          linesBefore: ctx.skillLines.before,
          linesAfter: ctx.skillLines.after,
        }
      : undefined,
  });
  const candidateRecords = pairs.map((p) => p.candidate.hash);
  const baselineRecords = pairs.map((p) => p.baseline.hash);
  let ledgerEvent: LedgerEvent | null = null;
  if (policy.decision !== 'invalid') {
    const accepted = policy.decision === 'accept';
    let reason: string | undefined;
    if (ctx.path === 'neutral' && ctx.neutralReason?.trim()) reason = ctx.neutralReason.trim();
    if (!accepted) {
      const s = summarize(policy.reasons);
      reason = reason ? `${reason}; rejected: ${s}` : `rejected: ${s}`;
    } else if (policy.tieBreak) reason = 'accepted on tie: shorter skill (06 §5.5)';
    ledgerEvent = checked(
      sealEvent({
        ts: ctx.ts,
        proposalId,
        stage: accepted ? 'candidate-accepted' : 'candidate-rejected',
        path: ctx.path,
        control: ctx.control,
        pattern: ctx.pattern,
        skill: ctx.skill,
        outlet: ctx.outlet ?? 'skill',
        evidence: {
          kind: 'bench',
          evaluationRecord: candidateRecords[0] as string,
          results: policy.results,
        },
        reason,
      }),
    );
  }
  return {
    proposalId,
    decision: policy.decision,
    path: policy.path,
    results: policy.results,
    reasons: policy.reasons,
    tieBreak: policy.tieBreak,
    seed,
    candidateRecords,
    baselineRecords,
    ledgerEvent,
  };
}

/**
 * Re-derives a gate decision from stored EvaluationRecords alone (06 §5.8, 13 §2.7). Finds the
 * proposal's candidate records and, per mode, the one comparable baseline record. When several
 * stored baselines are comparable (an older accepted skill set with the same identity), pass
 * `baselineHashes` to choose; otherwise the call is ambiguous and throws.
 */
export function recompute(
  records: readonly EvaluationRecord[],
  proposalId: string,
  ctx: GateContext & { baselineHashes?: readonly string[] },
): GateDecision {
  const candidates = records.filter((r) => r.role === 'candidate' && r.proposalId === proposalId);
  if (candidates.length === 0) {
    throw new GateHarnessError(`no candidate record for proposal ${proposalId}`, ['proposalId']);
  }
  const baselines: EvaluationRecord[] = [];
  for (const c of candidates) {
    const options = records.filter(
      (r) =>
        r.role === 'baseline' &&
        r.identity.mode === c.identity.mode &&
        comparable(r.identity, c.identity) &&
        (!ctx.baselineHashes || ctx.baselineHashes.includes(r.hash)),
    );
    if (options.length !== 1) {
      throw new GateHarnessError(
        `${options.length === 0 ? 'no' : 'more than one'} comparable ${c.identity.mode} baseline for proposal ${proposalId}`,
        ['baseline'],
      );
    }
    baselines.push(options[0] as EvaluationRecord);
  }
  return decide(baselines, candidates, ctx);
}

/** True when a recomputed decision matches the recorded ledger event in stage, path and evidence,
 * compared as canonical JSON (byte for byte). */
export function sameDecision(recorded: LedgerEvent, recomputed: GateDecision): boolean {
  const e = recomputed.ledgerEvent;
  if (!e) return false;
  const pick = (x: LedgerEvent) =>
    canonicalJson({ stage: x.stage, path: x.path, evidence: x.evidence, proposalId: x.proposalId });
  return pick(recorded) === pick(e);
}

/** A sealed `no-action` event for the early stop (06 §1.3 step 3), or null when the gate must run. */
export function earlyStopEvent(
  baselineRecord: Records,
  ctx: Pick<GateContext, 'ts' | 'models' | 'tasks' | 'config' | 'skill'> & { proposalId: string },
): LedgerEvent | null {
  const config = loadGateConfig(ctx.config ?? {});
  const baselines = asList(baselineRecord).map(validated);
  const res = earlyStop({
    models: ctx.models,
    modes: baselines.map((r) => r.identity.mode),
    tasks: ctx.tasks,
    baseline: baselines.flatMap((r) => r.outcomes),
    runs: config.runs,
  });
  if (!res.stop) return null;
  return sealEvent({
    ts: ctx.ts,
    proposalId: ctx.proposalId,
    stage: 'no-action',
    skill: ctx.skill,
    reason: res.detail,
  });
}

export interface ReleaseContext {
  ts: string;
  models: { frontier: string; small: string };
  /** The test-split tasks with kind and state. */
  tasks: readonly PolicyTask[];
  radius?: BlastRadius;
  runs?: number;
  release?: string;
  /** A human override (06 §5.7): only for a non-high-radius skill, always with a reason. */
  override?: { reason: string };
}

export interface ReleaseCheckResult {
  decision: 'pass' | 'blocked' | 'invalid';
  blocked: boolean;
  overridden: boolean;
  results: GateResult[];
  reasons: PolicyReason[];
  /** A sealed `release-check` event; null when invalid. */
  ledgerEvent: LedgerEvent | null;
}

/**
 * The release check on the held-out test split (06 §5.7): the candidate skill set against the
 * previously released one, both models, both modes. Both sides are `release-check` records with
 * comparable identities.
 */
export function releaseCheck(
  prevReleased: Records,
  candidate: Records,
  ctx: ReleaseContext,
): ReleaseCheckResult {
  const prev = asList(prevReleased).map(validated);
  const cand = asList(candidate).map(validated);
  const pairs = pairByMode(
    prev,
    cand,
    { baseline: 'release-check', candidate: 'release-check' },
    ctx.models,
  );
  const policy = releasePolicy({
    models: ctx.models,
    modes: pairs.map((p) => p.mode),
    tasks: ctx.tasks,
    previous: pairs.flatMap((p) => p.baseline.outcomes),
    candidate: pairs.flatMap((p) => p.candidate.outcomes),
    runs: ctx.runs,
    radius: ctx.radius,
  });
  if (policy.decision === 'invalid') {
    return {
      decision: 'invalid',
      blocked: true,
      overridden: false,
      results: [],
      reasons: policy.reasons,
      ledgerEvent: null,
    };
  }
  const blockedByPolicy = policy.decision === 'blocked';
  const overrideReason = ctx.override?.reason.trim();
  if (overrideReason !== undefined && overrideReason.length === 0) {
    throw new GateHarnessError('a release-check override needs a reason', ['override']);
  }
  if (overrideReason && (ctx.radius ?? 'medium') === 'high') {
    throw new GateHarnessError(
      'a release-check block cannot be overridden for a high-radius skill',
      ['override'],
    );
  }
  const overridden = blockedByPolicy && Boolean(overrideReason);
  const blocked = blockedByPolicy && !overridden;
  const s = summarize(policy.reasons);
  const reason = overridden
    ? `override: ${overrideReason}; blocked by: ${s}`
    : blocked
      ? `blocked: ${s}`
      : 'release check passed';
  const ledgerEvent = checked(
    sealEvent({
      ts: ctx.ts,
      stage: 'release-check',
      release: ctx.release,
      evidence: {
        kind: 'bench',
        evaluationRecord: pairs[0]?.candidate.hash as string,
        results: policy.results,
      },
      reason,
    }),
  );
  return {
    decision: policy.decision,
    blocked,
    overridden,
    results: policy.results,
    reasons: policy.reasons,
    ledgerEvent,
  };
}
