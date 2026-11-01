import { z } from 'zod';
import {
  type BaselineIdentity,
  type EvaluationRecord,
  EvaluationRecordSchema,
  type GateInputRecord,
  GateInputRecordSchema,
  comparable,
  identityDiff,
  sealGateInput,
} from '../schema/bench';
import { canonicalJson } from '../schema/common';
import { type GateResult, type LedgerEvent, LedgerEventSchema, sealEvent } from '../schema/ledger';
import {
  type BlastRadius,
  GATE_MODES,
  type GatePath,
  type PolicyDecision,
  type PolicyReason,
  type PolicyTask,
  type TemplateResults,
  applyPolicy,
  earlyStop,
  releasePolicy,
} from './policy';
import { DEFAULT_RESAMPLES, type GateMode } from './stats';

/**
 * The gate (vision 06 §5.1–§5.8, roadmap M1-08): checks the identity of every record, applies the
 * single policy table (policy.ts), seals a content-addressed GateInputRecord (08 §10.4) holding
 * every other input, and builds the sealed ledger event that references it. `recompute` re-derives
 * a stored decision from the GateInputRecord and the EvaluationRecords it names, and nothing else
 * (`bench gate --recompute <gateInputHash>`); `releaseCheck` is §5.7.
 * Pure: no clock, no network — the caller passes `ts`.
 */

/** `bench/gate.json` (07 §3.10). Unknown keys (e.g. the monitor threshold) are ignored here. */
export const GateConfigSchema = z.object({
  alpha: z.number().gt(0).lt(1).default(0.05),
  runs: z.number().int().min(1).default(3),
  resamples: z.number().int().min(1).default(DEFAULT_RESAMPLES),
  acceptShorterOnTie: z.boolean().default(false),
  /** 06 §1.5 / §5.1: a baseline older than this at the gate's ts is re-run, never compared. */
  maxBaselineAgeDays: z.number().int().min(1).default(30),
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
  /** Event timestamp (ISO). Recorded in the GateInputRecord, so recompute reproduces the eventId. */
  ts: string;
  radius: BlastRadius;
  path: GatePath;
  models: { frontier: string; small: string };
  /** The val tasks with kind, state and modes (pending and quarantined are excluded, 06 §4.1).
   * Must equal every record's `identity.tasks` (id, kind, state, modes), or the gate throws: a
   * task's state changes only with a re-baseline. */
  tasks: readonly PolicyTask[];
  /** The currently accepted skill set's hash (06 §5.1 step 1). Every baseline record must carry
   * it; every candidate record must carry one other skill-set hash. */
  acceptedSkillSetHash: string;
  /**
   * The modes this evaluation covers. Omit it to require every mode a gated task declares (the
   * 06 §5.1 rule: both modes). Pass `['isolation']` for the M1/M2 posture, where production mode
   * does not exist yet (M3): the narrowing is explicit and recorded in the GateInputRecord.
   */
  modes?: readonly GateMode[];
  config?: Partial<GateConfig>;
  /** Bootstrap seed. Defaults to `gate:<proposalId>`; whatever is used is recorded (06 §5.2). */
  seed?: string;
  safetyFixTargets?: readonly string[];
  neutralReason?: string;
  neutralPendingForSkill?: boolean;
  /** Target SKILL.md line counts, for the §5.5 tie-break. */
  skillLines?: { before: number; after: number };
  skill?: string;
  pattern?: string[];
  outlet?: 'skill' | 'template';
  /** REQUIRED for the template outlet (06 §5.6). */
  template?: TemplateResults;
  control?: boolean;
}

export interface GateDecision {
  proposalId: string;
  decision: PolicyDecision;
  path: GatePath;
  results: GateResult[];
  /** Every reason with its stable code (policy.ts REASON_CODES); see `rejectedForReplayRegression`. */
  reasons: PolicyReason[];
  tieBreak: boolean;
  seed: string;
  /** Record hashes per evaluated mode, in mode order. */
  candidateRecords: string[];
  baselineRecords: string[];
  /** The sealed GateInputRecord; store it at `evidence/eval/<hash>.json`. Null when invalid. */
  gateInput: GateInputRecord | null;
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

/** Identity fields allowed to differ between two modes of one gate: the mode itself, and the wiki
 * snapshot (null in isolation, required in production). Within one mode, only skillSetHash may
 * differ between baseline and candidate. */
const PER_MODE_FIELDS: ReadonlySet<string> = new Set(['mode', 'wikiSnapshotHash', 'skillSetHash']);

interface RecordSet {
  /** Modes with a record on both sides, in mode order. */
  modes: GateMode[];
  baseline: Map<GateMode, EvaluationRecord>;
  candidate: Map<GateMode, EvaluationRecord>;
  baselineSkillSet: string;
  candidateSkillSet: string;
}

function bySide(
  list: EvaluationRecord[],
  side: string,
  role: EvaluationRecord['role'],
): Map<GateMode, EvaluationRecord> {
  const out = new Map<GateMode, EvaluationRecord>();
  for (const r of list) {
    if (r.role !== role) {
      throw new GateHarnessError(`record ${r.hash} has role ${r.role}, expected ${role}`, ['role']);
    }
    const mode = r.identity.mode;
    if (out.has(mode)) {
      throw new GateHarnessError(`more than one ${side} record for mode ${mode}`, ['mode']);
    }
    const stray = r.outcomes.find((o) => o.mode !== mode);
    if (stray) {
      throw new GateHarnessError(
        `record ${r.hash} is a ${mode} evaluation but holds a ${stray.mode} outcome`,
        ['mode'],
      );
    }
    out.set(mode, r);
  }
  return out;
}

function oneSkillSet(list: EvaluationRecord[], side: string): string {
  const sets = [...new Set(list.map((r) => r.identity.skillSetHash))];
  if (sets.length !== 1) {
    throw new GateHarnessError(
      `${side} records span ${sets.length} skill sets (${sets.join(', ')}); every ${side} record must be the same skill set`,
      ['skillSetHash'],
    );
  }
  return sets[0] as string;
}

/**
 * The record-set rules (06 §1.5, §5.1): one record per mode per side; every baseline record is one
 * skill set and every candidate record another; the baseline is the accepted skill set when one is
 * named; every record agrees on every identity field except the per-mode ones; within a mode,
 * baseline and candidate are comparable; the gate models are in the identity. Throws otherwise.
 */
function checkRecordSet(
  baselines: EvaluationRecord[],
  candidates: EvaluationRecord[],
  opts: {
    roles: { baseline: EvaluationRecord['role']; candidate: EvaluationRecord['role'] };
    models: { frontier: string; small: string };
    acceptedSkillSetHash?: string;
    distinctSkillSets: boolean;
  },
): RecordSet {
  if (candidates.length === 0) throw new GateHarnessError('no candidate evaluation record');
  if (baselines.length === 0) throw new GateHarnessError('no baseline evaluation record');
  const base = bySide(baselines, 'baseline', opts.roles.baseline);
  const cand = bySide(candidates, 'candidate', opts.roles.candidate);
  const baselineSkillSet = oneSkillSet(baselines, 'baseline');
  const candidateSkillSet = oneSkillSet(candidates, 'candidate');
  if (opts.distinctSkillSets && baselineSkillSet === candidateSkillSet) {
    throw new GateHarnessError(
      'the candidate skill set equals the baseline skill set; there is no change to evaluate',
      ['skillSetHash'],
    );
  }
  if (opts.acceptedSkillSetHash !== undefined && baselineSkillSet !== opts.acceptedSkillSetHash) {
    throw new GateHarnessError(
      `the baseline skill set ${baselineSkillSet} is not the accepted skill set ${opts.acceptedSkillSetHash}; re-baseline first`,
      ['skillSetHash'],
    );
  }
  const all = [
    ...GATE_MODES.flatMap((m) => (base.has(m) ? [base.get(m) as EvaluationRecord] : [])),
    ...GATE_MODES.flatMap((m) => (cand.has(m) ? [cand.get(m) as EvaluationRecord] : [])),
  ];
  const ref = all[0] as EvaluationRecord;
  for (const r of all.slice(1)) {
    const fields = identityDiff(ref.identity, r.identity).filter((k) => !PER_MODE_FIELDS.has(k));
    if (fields.length > 0) {
      throw new GateHarnessError(
        `records ${ref.hash} and ${r.hash} are not comparable: identity differs in ${fields.join(', ')}; re-baseline first`,
        fields,
      );
    }
  }
  const modes = GATE_MODES.filter((m) => base.has(m) && cand.has(m));
  for (const m of modes) {
    assertComparable(
      (base.get(m) as EvaluationRecord).identity,
      (cand.get(m) as EvaluationRecord).identity,
    );
  }
  for (const id of [opts.models.frontier, opts.models.small]) {
    if (!ref.identity.models.includes(id)) {
      throw new GateHarnessError(`gate model ${id} is not in the evaluation identity`, ['models']);
    }
  }
  return { modes, baseline: base, candidate: cand, baselineSkillSet, candidateSkillSet };
}

const DAY_MS = 86_400_000;

/** 06 §1.5 / §5.1: a baseline older than `maxDays` at the gate's ts is re-run, never compared. */
export function baselineAgeDays(record: Pick<EvaluationRecord, 'createdAt'>, ts: string): number {
  return (Date.parse(ts) - Date.parse(record.createdAt)) / DAY_MS;
}

function checkBaselineAge(baselines: EvaluationRecord[], ts: string, maxDays: number): void {
  for (const r of baselines) {
    const age = baselineAgeDays(r, ts);
    if (age < 0) {
      throw new GateHarnessError(
        `baseline record ${r.hash} was created at ${r.createdAt}, after the gate ts ${ts}`,
        ['createdAt'],
      );
    }
    if (age > maxDays) {
      throw new GateHarnessError(
        `baseline record ${r.hash} is ${age.toFixed(1)} days old (max ${maxDays}); re-baseline first`,
        ['createdAt'],
      );
    }
  }
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

const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * The gate's task list must be the one the records were run under (06 §1.5, §4.1): the caller's
 * tasks, projected and sorted as the GateInputRecord holds them, must equal every record's
 * `identity.tasks` projected to (id, kind, state, modes). Otherwise a caller could mark a
 * regressing replay task `quarantined` (or change its kind or modes) and exclude it from the gate.
 * A quarantine is therefore a new identity, so a re-baseline. Throws naming the differing tasks.
 */
function assertTasksMatchIdentity(
  tasks: GateInputRecord['tasks'],
  records: readonly EvaluationRecord[],
): void {
  for (const r of records) {
    const bound = r.identity.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      modes: [...t.modes],
    }));
    if (canonicalJson(bound) === canonicalJson(tasks)) continue;
    const key = (t: (typeof tasks)[number]) => canonicalJson(t);
    const ours = new Map(tasks.map((t) => [t.id, key(t)]));
    const theirs = new Map(bound.map((t) => [t.id, key(t)]));
    const ids = [...new Set([...ours.keys(), ...theirs.keys()])]
      .filter((id) => ours.get(id) !== theirs.get(id))
      .sort();
    throw new GateHarnessError(
      `the gate's task list differs from record ${r.hash}'s identity in ${ids.join(', ')}; a task's state, kind or modes change only with a re-baseline (06 §4.1)`,
      ['tasks', ...ids.map((id) => `tasks.${id}`)],
    );
  }
}

/** The task list as the GateInputRecord holds it: sorted by id, modes resolved (default both). */
function recordedTasks(tasks: readonly PolicyTask[]): GateInputRecord['tasks'] {
  return [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      modes: GATE_MODES.filter((m) => (t.modes ?? GATE_MODES).includes(m)),
    }));
}

/**
 * Decides a candidate against its baseline (06 §5.1). Records are one per mode on each side
 * (a BaselineIdentity names one mode, 08 §10.3). Mismatched identities, a baseline that is not the
 * accepted skill set, or a stale baseline throw GateHarnessError. A mode required by the tasks (or
 * declared in `ctx.modes`) but missing from either side makes the decision `invalid`.
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
  const set = checkRecordSet(baselines, candidates, {
    roles: { baseline: 'baseline', candidate: 'candidate' },
    models: ctx.models,
    acceptedSkillSetHash: ctx.acceptedSkillSetHash,
    distinctSkillSets: true,
  });
  checkBaselineAge(baselines, ctx.ts, config.maxBaselineAgeDays);
  const seed = ctx.seed ?? `gate:${proposalId}`;
  const outlet = ctx.outlet ?? 'skill';
  const tasks = recordedTasks(ctx.tasks);
  assertTasksMatchIdentity(tasks, [...baselines, ...candidates]);
  const safetyFixTargets =
    ctx.path === 'safety-fix' && ctx.safetyFixTargets
      ? sortedUnique(ctx.safetyFixTargets)
      : undefined;
  const policy = applyPolicy({
    radius: ctx.radius,
    path: ctx.path,
    outlet,
    template: ctx.template,
    models: ctx.models,
    modes: set.modes,
    declaredModes: ctx.modes,
    tasks,
    baseline: [...baselines.flatMap((r) => r.outcomes)],
    candidate: [...candidates.flatMap((r) => r.outcomes)],
    runs: config.runs,
    alpha: config.alpha,
    resamples: config.resamples,
    seed,
    safetyFixTargets,
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
  const candidateRecords = set.modes.map((m) => (set.candidate.get(m) as EvaluationRecord).hash);
  const baselineRecords = set.modes.map((m) => (set.baseline.get(m) as EvaluationRecord).hash);
  let gateInput: GateInputRecord | null = null;
  let ledgerEvent: LedgerEvent | null = null;
  if (policy.decision !== 'invalid') {
    gateInput = sealGateInput({
      kind: 'gate-input',
      proposalId,
      ts: ctx.ts,
      outlet,
      radius: ctx.radius,
      path: ctx.path,
      seed,
      config,
      models: { frontier: ctx.models.frontier, small: ctx.models.small },
      modes: set.modes,
      modesDeclared: ctx.modes !== undefined,
      acceptedSkillSetHash: set.baselineSkillSet,
      candidateSkillSetHash: set.candidateSkillSet,
      tasks,
      baselineRecords,
      candidateRecords,
      safetyFixTargets,
      neutralReason: ctx.neutralReason ? ctx.neutralReason : undefined,
      neutralPendingForSkill: ctx.neutralPendingForSkill,
      skillLines: ctx.skillLines ? { ...ctx.skillLines } : undefined,
      skill: ctx.skill,
      pattern: ctx.pattern ? [...ctx.pattern] : undefined,
      control: ctx.control,
      template:
        outlet === 'template' && ctx.template
          ? {
              lanes: ctx.template.lanes.map((l) => ({ lane: l.lane, passed: l.passed })),
              mutants: ctx.template.mutants.map((m) => ({ id: m.id, caught: m.caught })),
            }
          : undefined,
    });
    GateInputRecordSchema.parse(gateInput);
    const accepted = policy.decision === 'accept';
    let reason: string | undefined;
    if (ctx.path === 'neutral' && ctx.neutralReason?.trim()) reason = ctx.neutralReason.trim();
    if (!accepted) {
      const s = summarize(policy.reasons);
      reason = reason ? `${reason}; rejected: ${s}` : `rejected: ${s}`;
    } else if (policy.tieBreak) reason = 'accepted on tie: shorter skill (06 §5.5)';
    const evaluationRecords = sortedUnique([...baselineRecords, ...candidateRecords]);
    const evidence: LedgerEvent['evidence'] =
      outlet === 'template' && ctx.template
        ? {
            kind: 'template',
            gateInput: gateInput.hash,
            evaluationRecords,
            results: policy.results,
            lanes: ctx.template.lanes.map((l) => l.lane),
            mutantsFailed: ctx.template.mutants.filter((m) => m.caught).length,
            mutantsTotal: ctx.template.mutants.length,
          }
        : { kind: 'bench', gateInput: gateInput.hash, evaluationRecords, results: policy.results };
    ledgerEvent = checked(
      sealEvent({
        ts: ctx.ts,
        proposalId,
        stage: accepted ? 'candidate-accepted' : 'candidate-rejected',
        path: ctx.path,
        control: ctx.control,
        pattern: ctx.pattern,
        skill: ctx.skill,
        outlet,
        evidence,
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
    gateInput,
    ledgerEvent,
  };
}

/** The GateContext a GateInputRecord encodes; `decide` with it rebuilds the same record. */
export function contextFromGateInput(g: GateInputRecord): GateContext {
  return {
    ts: g.ts,
    radius: g.radius,
    path: g.path,
    models: g.models,
    tasks: g.tasks,
    acceptedSkillSetHash: g.acceptedSkillSetHash,
    modes: g.modesDeclared ? g.modes : undefined,
    config: g.config,
    seed: g.seed,
    safetyFixTargets: g.safetyFixTargets,
    neutralReason: g.neutralReason,
    neutralPendingForSkill: g.neutralPendingForSkill,
    skillLines: g.skillLines,
    skill: g.skill,
    pattern: g.pattern,
    outlet: g.outlet,
    template: g.template,
    control: g.control,
  };
}

/**
 * Re-derives a gate decision from its GateInputRecord and the EvaluationRecords it names, with no
 * other input and no rollouts (06 §5.8, 13 §2.7, `bench gate --recompute <hash>`). `records` may
 * hold any number of other records (other proposals, other accepted skill sets): only the hashes
 * the input lists are read. Throws when the input record is invalid or tampered, when a listed
 * record is missing or tampered, or when the rebuilt input does not hash to the given one.
 */
export function recompute(
  gateInput: GateInputRecord,
  records: readonly EvaluationRecord[],
): GateDecision {
  const parsed = GateInputRecordSchema.safeParse(gateInput);
  if (!parsed.success) {
    throw new GateHarnessError(
      `gate input record ${gateInput.hash} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      parsed.error.issues.map((i) => i.path.join('.')),
    );
  }
  const g = parsed.data;
  const find = (hash: string): EvaluationRecord => {
    const r = records.find((x) => x.hash === hash);
    if (!r) throw new GateHarnessError(`evaluation record ${hash} is not available`, ['records']);
    return r;
  };
  const d = decide(
    g.baselineRecords.map(find),
    g.candidateRecords.map(find),
    contextFromGateInput(g),
  );
  if (d.proposalId !== g.proposalId) {
    throw new GateHarnessError(
      `the candidate records name proposal ${d.proposalId}, the gate input ${g.proposalId}`,
      ['proposalId'],
    );
  }
  if (d.gateInput?.hash !== g.hash) {
    throw new GateHarnessError(
      `recomputed gate input ${d.gateInput?.hash ?? '(invalid decision)'} does not match ${g.hash}`,
      ['hash'],
    );
  }
  return d;
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

/**
 * True when a decision is a rejection that carries a `replay-regression` reason on `taskId` (in
 * any model or mode). The M2 exit check (06 §10.3) asserts this for the control arm on
 * `replay/idle-probe-leaves-store-asleep-val`, so the control is shown to be rejected for the
 * right reason, not merely rejected.
 */
export function rejectedForReplayRegression(
  result: Pick<GateDecision, 'decision' | 'reasons'>,
  taskId: string,
): boolean {
  return (
    result.decision === 'reject' &&
    result.reasons.some(
      (r) => r.code === 'replay-regression' && r.severity === 'fail' && r.task === taskId,
    )
  );
}

/** A sealed `no-action` event for the early stop (06 §1.3 step 3), or null when the gate must run. */
export function earlyStopEvent(
  baselineRecord: Records,
  ctx: Pick<GateContext, 'ts' | 'models' | 'tasks' | 'config' | 'skill'> & { proposalId: string },
): LedgerEvent | null {
  const config = loadGateConfig(ctx.config ?? {});
  const baselines = asList(baselineRecord).map(validated);
  assertTasksMatchIdentity(recordedTasks(ctx.tasks), baselines);
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
  /** The test-split tasks with kind, state and modes; must equal every record's `identity.tasks`. */
  tasks: readonly PolicyTask[];
  /** As GateContext.modes: omit to require every mode the test tasks declare (06 §5.7). */
  modes?: readonly GateMode[];
  /** The previously released skill set; when given, every previous record must carry it. */
  releasedSkillSetHash?: string;
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
 * comparable identities, each side one skill set.
 */
export function releaseCheck(
  prevReleased: Records,
  candidate: Records,
  ctx: ReleaseContext,
): ReleaseCheckResult {
  const prev = asList(prevReleased).map(validated);
  const cand = asList(candidate).map(validated);
  const set = checkRecordSet(prev, cand, {
    roles: { baseline: 'release-check', candidate: 'release-check' },
    models: ctx.models,
    acceptedSkillSetHash: ctx.releasedSkillSetHash,
    // A release may carry no skill change against the previous one; the check still runs.
    distinctSkillSets: false,
  });
  const tasks = recordedTasks(ctx.tasks);
  assertTasksMatchIdentity(tasks, [...prev, ...cand]);
  const policy = releasePolicy({
    models: ctx.models,
    modes: set.modes,
    declaredModes: ctx.modes,
    tasks,
    previous: prev.flatMap((r) => r.outcomes),
    candidate: cand.flatMap((r) => r.outcomes),
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
  const evaluationRecords = sortedUnique(
    set.modes.flatMap((m) => [
      (set.baseline.get(m) as EvaluationRecord).hash,
      (set.candidate.get(m) as EvaluationRecord).hash,
    ]),
  );
  const ledgerEvent = checked(
    sealEvent({
      ts: ctx.ts,
      stage: 'release-check',
      release: ctx.release,
      evidence: { kind: 'bench', evaluationRecords, results: policy.results },
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
