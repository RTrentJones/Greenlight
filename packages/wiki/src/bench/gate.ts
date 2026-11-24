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
  DEFAULT_NON_REGRESSION_FRACTION,
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
import { GATE_ALGORITHM, type GateMode, SUPPORTED_GATE_ALGORITHMS } from './stats';

/**
 * The gate (vision 06 §5.1–§5.8, roadmap M1-08): checks the identity of every record, applies the
 * single policy table (policy.ts), seals a content-addressed GateInputRecord (08 §10.4) holding
 * every other input, and builds the sealed ledger event that references it. `recompute` re-derives
 * a stored decision from the GateInputRecord and the EvaluationRecords it names, and nothing else
 * (`bench gate --recompute <gateInputHash>`); `releaseCheck` is §5.7.
 * Pure: no clock, no network — the caller passes `ts`.
 */

/** `bench/gate.json` (07 §3.10). Unknown keys (e.g. the monitor threshold, or the `resamples` an
 * older file kept from the retired bootstrap) are ignored here; the shipped file carries none. */
export const GateConfigSchema = z.object({
  alpha: z.number().gt(0).lt(1).default(0.05),
  runs: z.number().int().min(1).default(3),
  acceptShorterOnTie: z.boolean().default(false),
  /** Used only by gate algorithm versions ≤ 2 (06 §5.4, §5.8): a model may lose at most
   * max(1, ⌊fraction × objective rollouts⌋) passes. From version 3 non-regression is the exact
   * one-sided test at `alpha` and this key is ignored. It stays accepted, and recorded in every
   * gate input, so older gate.json files and older records still parse and recompute. */
  nonRegressionFraction: z.number().gt(0).lt(1).default(DEFAULT_NON_REGRESSION_FRACTION),
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

/** `recompute` was given a gate input made with a decision algorithm this build does not implement
 * (06 §5.2, §5.8): version 1, or one newer than `GATE_ALGORITHM`. */
export class GateAlgorithmError extends GateHarnessError {
  constructor(
    readonly gateInput: string,
    readonly algorithm: number,
  ) {
    super(
      `gate input ${gateInput} was made with ${algorithm < GATE_ALGORITHM ? 'an older' : 'a newer'} decision algorithm (${algorithm}; this build implements ${SUPPORTED_GATE_ALGORITHMS.join(', ')}): its decision stands as recorded and is not re-derived here`,
      ['algorithm'],
    );
    this.name = 'GateAlgorithmError';
  }
}

export interface GateContext {
  /** Event timestamp (ISO). Recorded in the GateInputRecord, so recompute reproduces the eventId. */
  ts: string;
  radius: BlastRadius;
  path: GatePath;
  models: { frontier: string; small: string };
  /** The val tasks with kind, state, modes and skills (pending and quarantined are excluded, 06
   * §4.1). Must equal every record's `identity.tasks` (id, kind, state, modes, skills), or the
   * gate throws: a task's state, or the slice it belongs to, changes only with a re-baseline. */
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
  /** The decision algorithm (stats.ts). Omit it for a new gate: `GATE_ALGORITHM`. `recompute`
   * passes the version stored in the gate input, so a record is decided by the rules it was made
   * with (06 §5.8); only `SUPPORTED_GATE_ALGORITHMS` are accepted. */
  algorithm?: number;
  safetyFixTargets?: readonly string[];
  neutralReason?: string;
  neutralPendingForSkill?: boolean;
  /** The target SKILL.md in the accepted and in the candidate tree, for the §5.5 tie-break. The
   * gate derives the line counts and the deletions-only claim itself; read (and recorded) only
   * when `acceptShorterOnTie` is on. */
  skillText?: { before: string; after: string };
  /** The patched skill. REQUIRED for the skill outlet: its slice is the efficacy set (06 §5.2). */
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
  /** The decision algorithm this decision was made with (06 §5.2, §5.8). */
  algorithm: number;
  /** Record hashes per evaluated mode, in mode order. */
  candidateRecords: string[];
  baselineRecords: string[];
  /** The sealed GateInputRecord; store it at `evidence/eval/<hash>.json`. Null unless the
   * decision is `accept` or `reject`. */
  gateInput: GateInputRecord | null;
  /** `candidate-accepted` / `candidate-rejected`; null for `invalid` (the gate re-runs or aborts,
   * 06 §4.8), `blocked` (the baseline holds a flaky replay task) and `underpowered` (the efficacy
   * test cannot reach alpha): none of them is a result, so none reaches the ledger. */
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
  if (opts.models.frontier === opts.models.small) {
    throw new GateHarnessError(
      `the gate pair must be two different models (06 §5.3); both are ${opts.models.frontier}`,
      ['models'],
    );
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
  const fails = reasons.filter((r) => r.severity === 'fail' || r.severity === 'blocked');
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
    const old = r.identity.tasks.find((t) => t.skills === undefined);
    if (old) {
      throw new GateHarnessError(
        `record ${r.hash} predates the slice rule: its identity does not list the skills of ${old.id} (06 §5.2); run the evaluation again`,
        ['tasks'],
      );
    }
    const bound = r.identity.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      modes: [...t.modes],
      skills: [...(t.skills ?? [])],
    }));
    if (canonicalJson(bound) === canonicalJson(tasks)) continue;
    const key = (t: (typeof tasks)[number]) => canonicalJson(t);
    const ours = new Map(tasks.map((t) => [t.id, key(t)]));
    const theirs = new Map(bound.map((t) => [t.id, key(t)]));
    const ids = [...new Set([...ours.keys(), ...theirs.keys()])]
      .filter((id) => ours.get(id) !== theirs.get(id))
      .sort();
    throw new GateHarnessError(
      `the gate's task list differs from record ${r.hash}'s identity in ${ids.join(', ')}; a task's state, kind, modes or skills change only with a re-baseline (06 §4.1)`,
      ['tasks', ...ids.map((id) => `tasks.${id}`)],
    );
  }
}

/** The task list as the GateInputRecord holds it: sorted by id, modes resolved (default both),
 * skills sorted and unique. */
function recordedTasks(tasks: readonly PolicyTask[]): GateInputRecord['tasks'] {
  return [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      modes: GATE_MODES.filter((m) => (t.modes ?? GATE_MODES).includes(m)),
      skills: [...new Set(t.skills ?? [])].sort(),
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
  const algorithm = ctx.algorithm ?? GATE_ALGORITHM;
  if (!SUPPORTED_GATE_ALGORITHMS.includes(algorithm)) {
    throw new GateHarnessError(
      `gate algorithm ${algorithm} is not implemented by this build (${SUPPORTED_GATE_ALGORITHMS.join(', ')})`,
      ['algorithm'],
    );
  }
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
  const outlet = ctx.outlet ?? 'skill';
  if (outlet === 'skill' && !ctx.skill) {
    throw new GateHarnessError(
      'a skill gate names the patched skill: efficacy is tested on its slice (06 §5.2)',
      ['skill'],
    );
  }
  const skillText =
    config.acceptShorterOnTie && ctx.skillText
      ? { before: ctx.skillText.before, after: ctx.skillText.after }
      : undefined;
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
    skill: ctx.skill,
    // Versions ≤ 2 decide non-regression by the fixed count; 3 by the exact test (policy.ts).
    algorithm,
    nonRegressionFraction: config.nonRegressionFraction,
    safetyFixTargets,
    neutralReason: ctx.neutralReason,
    neutralPendingForSkill: ctx.neutralPendingForSkill,
    tieBreak: skillText ? { enabled: true, ...skillText } : undefined,
  });
  const candidateRecords = set.modes.map((m) => (set.candidate.get(m) as EvaluationRecord).hash);
  const baselineRecords = set.modes.map((m) => (set.baseline.get(m) as EvaluationRecord).hash);
  let gateInput: GateInputRecord | null = null;
  let ledgerEvent: LedgerEvent | null = null;
  if (policy.decision === 'accept' || policy.decision === 'reject') {
    gateInput = sealGateInput({
      kind: 'gate-input',
      proposalId,
      algorithm,
      ts: ctx.ts,
      outlet,
      radius: ctx.radius,
      path: ctx.path,
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
      skillText,
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
    // Vacuous replay safety is part of the row (06 §5.4): "no regression" then proves nothing.
    const vacuous = policy.reasons
      .filter((r) => r.code === 'safety-vacuous')
      .map((r) => `${r.model}/${r.mode}`);
    if (vacuous.length > 0) {
      const note = `replay safety vacuous (no baseline-passing replay task) on ${vacuous.join(', ')}`;
      reason = reason ? `${reason}; ${note}` : note;
    }
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
    algorithm,
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
    algorithm: g.algorithm ?? 1,
    safetyFixTargets: g.safetyFixTargets,
    neutralReason: g.neutralReason,
    neutralPendingForSkill: g.neutralPendingForSkill,
    skillText: g.skillText,
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
 *
 * A record is re-derived only with the algorithm it was made with (`algorithm`, 06 §5.2): the
 * stored version is passed to `decide`, so a version-2 record is decided by the fixed-count
 * non-regression rule and a version-3 record by the exact test. This build implements
 * `SUPPORTED_GATE_ALGORITHMS`; a record of any other version (1, the paired bootstrap, or a newer
 * one) is refused with `GateAlgorithmError`, which names the version, and is never silently
 * re-decided under different statistics.
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
  const made = g.algorithm ?? 1;
  if (!SUPPORTED_GATE_ALGORITHMS.includes(made)) {
    throw new GateAlgorithmError(g.hash, made);
  }
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

/** What the baseline alone already settles about a gate, before any candidate rollout. */
export interface BaselinePrecheck {
  /** `blocked`: the gate would make no decision whatever the candidate does (a flaky baseline
   * replay at high radius). `underpowered`: no candidate outcome could be accepted, because the
   * efficacy test cannot reach alpha on this skill's slice, or the slice is empty; a candidate
   * could still be rejected for a rule that needs no power (a replay regression). */
  decision: 'blocked' | 'underpowered';
  reasons: PolicyReason[];
  baselineRecords: string[];
  algorithm: number;
}

/**
 * Asks the policy what a gate against this baseline can decide, with no candidate rollouts (06
 * §5.2 "Power is checked first"). The three findings it looks for are properties of the baseline:
 * a flaky baseline replay task, an empty slice, and a slice whose attainable minimum p is not
 * below alpha. The policy is run with the baseline standing in for the candidate, which leaves
 * those three findings exactly as any real candidate would meet them, and every other finding of
 * that run is discarded. Returns null when the gate can decide.
 */
export function baselinePrecheck(
  baselineRecord: Records,
  ctx: Pick<
    GateContext,
    | 'radius'
    | 'path'
    | 'models'
    | 'tasks'
    | 'modes'
    | 'config'
    | 'skill'
    | 'algorithm'
    | 'outlet'
    | 'safetyFixTargets'
  >,
): BaselinePrecheck | null {
  const config = loadGateConfig(ctx.config ?? {});
  const algorithm = ctx.algorithm ?? GATE_ALGORITHM;
  const baselines = asList(baselineRecord).map(validated);
  const outcomes = baselines.flatMap((r) => r.outcomes);
  const policy = applyPolicy({
    radius: ctx.radius,
    path: ctx.path,
    outlet: ctx.outlet ?? 'skill',
    models: ctx.models,
    modes: [...new Set(baselines.map((r) => r.identity.mode))],
    declaredModes: ctx.modes,
    tasks: recordedTasks(ctx.tasks),
    baseline: outcomes,
    candidate: outcomes,
    runs: config.runs,
    alpha: config.alpha,
    skill: ctx.skill,
    algorithm,
    nonRegressionFraction: config.nonRegressionFraction,
    safetyFixTargets:
      ctx.path === 'safety-fix' && ctx.safetyFixTargets
        ? sortedUnique(ctx.safetyFixTargets)
        : undefined,
  });
  const base = { baselineRecords: baselines.map((r) => r.hash), algorithm };
  const flaky = policy.reasons.filter(
    (r) => r.code === 'flaky-baseline' && r.severity === 'blocked',
  );
  if (flaky.length > 0) return { decision: 'blocked', reasons: flaky, ...base };
  // With the baseline as its own candidate a powered cell fails "no improvement", and the policy
  // then lists the power findings as information beside that rejection: read them by code.
  const power = policy.reasons
    .filter((r) => r.code === 'underpowered' || r.code === 'no-slice')
    .map((r) => ({ ...r, severity: 'blocked' as const }));
  return power.length > 0 ? { decision: 'underpowered', reasons: power, ...base } : null;
}

/** What a control arm whose expected rejection is a replay regression shows (06 §10.3). */
export type ControlOutcome = 'met' | 'not-met' | 'inconclusive';

/**
 * Whether the gate refused a control for the replay regression it encodes (06 §10.3):
 * - `met`: rejected, with `replay-regression` on `taskId`;
 * - `inconclusive`: the gate could not have refused it for that reason, so the control says
 *   nothing about the gate — the evaluation was `invalid` or `blocked` (no safety verdict), or
 *   `taskId` is baseline-passing in no model × mode cell (it fails in the baseline, so it cannot
 *   regress; this covers a baseline with no baseline-passing replay task at all);
 * - `not-met`: the task could have regressed, and the gate did not reject for it.
 */
export function controlOutcome(
  result: Pick<GateDecision, 'decision' | 'reasons' | 'results'>,
  taskId: string,
): ControlOutcome {
  if (rejectedForReplayRegression(result, taskId)) return 'met';
  if (result.decision === 'invalid' || result.decision === 'blocked') return 'inconclusive';
  const failing = result.reasons.filter(
    (r) => r.code === 'replay-baseline-failing' && r.task === taskId,
  ).length;
  if (result.results.length > 0 && failing >= result.results.length) return 'inconclusive';
  return 'not-met';
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
