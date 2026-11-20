import type { TaskSpec } from '../schema/bench';
import type { GateResult } from '../schema/ledger';
import {
  type BenchOutcome,
  EXACT_NON_REGRESSION_SINCE,
  GATE_ALGORITHM,
  type GateMode,
  type Stratum,
  perTaskMeans,
  stratifiedExactTest,
} from './stats';

/**
 * The single policy table (vision 06 §5.4) as a pure function. §5.1 is the procedure; this module
 * supplies its thresholds. Inputs are per-task, per-run outcomes for the baseline and candidate on
 * the two gate models (§5.3) in each evaluated mode (§4.7); the output is one GateResult per
 * model × mode (08 §8) plus an overall decision with machine-readable reasons.
 *
 * Threshold comparisons are done in integer pass counts, never floats: a tie is a number of passes
 * (`tieTolerance`), a replay task "passes k of R" is a count, and the legacy non-regression bound
 * is a number of passes (`lossBound`). The boundary vectors (13 §2.8) sit exactly on these integer
 * edges, so there is no rounding to argue about.
 *
 * Non-regression (§5.4) depends on the gate's algorithm version (`PolicyInput.algorithm`). From
 * version 3 it is the exact stratified permutation test of §5.2 in the other direction, over every
 * gated objective task: a cell regresses when the one-sided p for "the candidate is worse" is
 * ≤ alpha. Versions ≤ 2 use the fixed count `lossBound`; that path is kept so `recompute`
 * reproduces every decision made under it, and is labelled LEGACY below. The release check (§5.7)
 * records no algorithm version and still uses the fixed count.
 *
 * Efficacy (§5.2) is an exact stratified permutation test over the ROLLOUTS of the patched skill's
 * slice (the objective tasks whose `skills` name it). When the smallest p any candidate could
 * reach against the baseline is not below alpha, the outcome is `underpowered`: no decision.
 *
 * Spec readings (the stricter one wherever the text is ambiguous) are marked "Reading:" below.
 */

export type BlastRadius = 'high' | 'medium' | 'low';
export type GatePath = 'standard' | 'safety-fix' | 'neutral';
/**
 * - `accept` / `reject`: a decision, written to the ledger.
 * - `invalid`: the evaluation cannot be gated (re-run it).
 * - `blocked`: the BASELINE cannot be gated against (a flaky replay task at high radius). It says
 *   nothing about the candidate; the owner fixes or quarantines the task and re-baselines.
 * - `underpowered`: every safety rule held, but the efficacy test cannot reach alpha at this
 *   shape, so neither an accept nor a rejection would mean anything. No ledger event.
 */
export type PolicyDecision = 'accept' | 'reject' | 'invalid' | 'blocked' | 'underpowered';

export const GATE_MODES: readonly GateMode[] = ['isolation', 'production'];

/** A task as the policy sees it. `modes` defaults to both (08 §10.1). `skills` are the skills the
 * task exercises (TaskSpec.skills): they decide which objective tasks are a skill's slice. */
export type PolicyTask = Pick<TaskSpec, 'id' | 'kind' | 'state'> & {
  modes?: readonly GateMode[];
  skills?: readonly string[];
};

export const REASON_CODES = [
  // invalid: the evaluation cannot be gated at all
  'fallback-served',
  'grader-error',
  'incomplete-outcomes',
  'unknown-task',
  'unknown-model',
  'unknown-mode',
  'mode-missing',
  'mode-not-in-tasks',
  'task-not-evaluated',
  'template-evidence-missing',
  'template-no-lanes',
  'template-no-mutants',
  'models-not-distinct',
  // blocked: no decision can be made; nothing is said about the candidate
  'flaky-baseline',
  'underpowered',
  'no-slice',
  // fail: a policy rule did not hold
  'replay-regression',
  'no-strict-improvement',
  'not-significant',
  'capability-regression',
  'production-regression',
  'safety-fix-no-targets',
  'safety-fix-target-unknown',
  'safety-fix-target-not-failing',
  'safety-fix-target-not-fixed',
  'neutral-needs-reason',
  'neutral-already-pending',
  'template-lane-failed',
  'template-mutant-escaped',
  // info: recorded, does not change the decision on its own
  'excluded-task',
  'no-objective-tasks',
  'tie-break-shorter',
  'modes-partial',
  'efficacy-slice',
  'safety-vacuous',
  'replay-baseline-failing',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface PolicyReason {
  code: ReasonCode;
  severity: 'invalid' | 'blocked' | 'fail' | 'info';
  model?: string;
  mode?: GateMode;
  task?: string;
  detail?: string;
}

export interface PValueArgs {
  model: string;
  mode: GateMode;
  /** The slice's tasks, in id order: passes per arm out of `runs`. */
  strata: readonly Stratum[];
}

/** Template outlet evidence (06 §5.6): generated-app tests per lane using the template, and per
 * template mutant whether those tests caught (failed on) it. */
export interface TemplateResults {
  lanes: readonly { lane: string; passed: boolean }[];
  mutants: readonly { id: string; caught: boolean }[];
}

export interface PolicyInput {
  radius: BlastRadius;
  path: GatePath;
  /** The outlet under evaluation (06 §5.6). Default `skill`. A `template` candidate needs no
   * strict capability improvement; its capability guard is non-regression in every model and
   * mode, and `template` results must show every lane passing and every mutant caught. */
  outlet?: 'skill' | 'template';
  template?: TemplateResults;
  /** The gate pair (06 §5.3). */
  models: { frontier: string; small: string };
  /** The modes evaluated in this gate (records on both sides), in any order. */
  modes: readonly GateMode[];
  /**
   * The modes the caller declares this evaluation covers. Absent: every mode some gated task
   * declares (TaskSpec.modes) is required, and a missing one makes the evaluation invalid. Present:
   * an explicit narrower posture (the M1/M2 isolation-only gate, 06 §5.1), validated against the
   * tasks — each declared mode must be declared by a gated task, and every gated task must be
   * evaluated in at least one declared mode. A partial declaration is recorded as `modes-partial`.
   */
  declaredModes?: readonly GateMode[];
  tasks: readonly PolicyTask[];
  baseline: readonly BenchOutcome[];
  candidate: readonly BenchOutcome[];
  /** Runs per task × model × mode (06 §5.1: 3). */
  runs?: number;
  /** Significance level (06 §5.1: 0.05); the test is p < alpha. */
  alpha?: number;
  /** The patched skill (06 §5.6). Efficacy is tested on its slice: the objective tasks whose
   * `skills` name it. Absent (a template candidate, which has no efficacy rule): every objective
   * task. A skill no objective task names has an empty slice, so the outcome is `underpowered`. */
  skill?: string;
  /** The gate's decision algorithm (stats.ts `GATE_ALGORITHM`). Default: the current one. It
   * selects the non-regression rule: the exact test from version 3, the fixed count below. */
  algorithm?: number;
  /** LEGACY, algorithm versions ≤ 2 only: the non-regression bound as a fraction of the objective
   * rollouts per arm. A model may lose at most max(1, ⌊fraction × tasks × runs⌋) passes. Default
   * 0.1. Ignored from version 3. */
  nonRegressionFraction?: number;
  /** safety-fix path: the replay tasks that motivated the proposal (06 §5.4). */
  safetyFixTargets?: readonly string[];
  /** neutral path: the human's recorded approval reason (06 §5.4). */
  neutralReason?: string;
  /** neutral path: another neutral change is already pending for this skill (06 §5.4). */
  neutralPendingForSkill?: boolean;
  /** Tie-break (06 §5.5): enabled from bench/gate.json, with the target SKILL.md text before and
   * after. The policy derives the line counts and the deletions-only claim from the texts. */
  tieBreak?: { enabled: boolean; before: string; after: string };
  /** Override the p-value computation (boundary vectors pin p exactly). Defaults to the exact
   * test. Never set by the gate. */
  pValue?: (args: PValueArgs) => number | null;
}

export interface PolicyOutput {
  decision: PolicyDecision;
  path: GatePath;
  /** One per model × mode, frontier first, isolation first. Empty when the decision is invalid. */
  results: GateResult[];
  reasons: PolicyReason[];
  /** True when the §5.5 tie-break accepted a proposal the standard rules would reject. */
  tieBreak: boolean;
}

/** Task kinds whose score is the efficacy objective. Reading (06 §4.1, §5.4): "capability" in the
 * table is the mean over every gated non-replay bench task that measures skills (capability,
 * loop, wiki, routing, portfolio). Mechanism tasks are `repro`-graded framework evidence for the
 * mechanism outlet (§5.6), not skill evidence, so they are not gated here. Replay tasks are the
 * safety constraint, never the objective. */
const OBJECTIVE_KINDS: ReadonlySet<TaskSpec['kind']> = new Set([
  'capability',
  'loop',
  'wiki',
  'routing',
  'portfolio',
]);

const DEFAULT_RUNS = 3;
const DEFAULT_ALPHA = 0.05;
export const DEFAULT_NON_REGRESSION_FRACTION = 0.1;
/** A tie (06 §5.5): pass counts differ by at most ⌊rollouts / 20⌋, so exactly equal below 20. */
const TIE_TOLERANCE_DIVISOR = 20;

/**
 * LEGACY (gate algorithm versions ≤ 2, and the release check of 06 §5.7): the non-regression bound
 * in passes. Over `rollouts` objective rollouts per arm (tasks × runs), a model may lose at most
 * max(1, ⌊fraction × rollouts⌋) passes. Gates of algorithm 3 and later do not use it (06 §5.4).
 */
export function lossBound(rollouts: number, fraction = DEFAULT_NON_REGRESSION_FRACTION): number {
  return Math.max(1, Math.floor(rollouts * fraction + 1e-9));
}

/** The largest pass-count difference that still counts as a tie (06 §5.5). */
export function tieTolerance(rollouts: number): number {
  return Math.floor(rollouts / TIE_TOLERANCE_DIVISOR);
}

/** SKILL.md line counts and whether `after` only deletes lines of `before` (06 §5.5): every line
 * of `after` appears in `before`, in order. */
export function shorterByDeletion(
  before: string,
  after: string,
): { linesBefore: number; linesAfter: number; deletionsOnly: boolean; shorter: boolean } {
  const a = before.split('\n');
  const b = after.split('\n');
  let i = 0;
  for (const line of a) if (i < b.length && b[i] === line) i++;
  const deletionsOnly = i === b.length && b.length < a.length;
  return {
    linesBefore: a.length,
    linesAfter: b.length,
    deletionsOnly,
    shorter: a.length > 0 && b.length * 10 <= a.length * 9,
  };
}

/** ≥ 2 of 3, generalised to R runs as ⌈2R/3⌉ (06 §5.4 "Definitions"). */
export function twoThirds(runs: number): number {
  return Math.ceil((2 * runs) / 3);
}

/** Pass counts a candidate replay task needs at this radius: R of R at high, ⌈2R/3⌉ otherwise. */
export function replayThreshold(radius: BlastRadius, runs: number): number {
  return radius === 'high' ? runs : twoThirds(runs);
}

function taskModes(t: PolicyTask): readonly GateMode[] {
  return t.modes ?? GATE_MODES;
}

function sortModes(modes: readonly GateMode[]): GateMode[] {
  return GATE_MODES.filter((m) => modes.includes(m));
}

/** Per-cell figures shared by the gate, the tie-break and the release check. */
export interface CellStats {
  model: string;
  mode: GateMode;
  runs: number;
  replay: { task: string; basePasses: number; candPasses: number }[];
  /** Every gated objective task: the non-regression set. */
  objective: { task: string; basePasses: number; candPasses: number }[];
  /** The patched skill's slice of `objective`: the efficacy set (06 §5.2, §5.6). */
  slice: { task: string; basePasses: number; candPasses: number }[];
  /** Σ candidate passes − Σ baseline passes over every objective task. */
  diffUnits: number;
  /** The same over the slice. */
  sliceDiff: number;
  /** Mean capability over the slice, before and after. */
  before: number;
  after: number;
  pValue: number | null;
  /** The smallest p any candidate could reach against this baseline; null when p is not computed
   * or the slice is empty. */
  minP: number | null;
  /** Non-regression (06 §5.4, algorithm ≥ 3): the exact one-sided p for "the candidate is worse
   * than the baseline" over every objective task. Null with no objective task. */
  lossP: number | null;
}

interface Gated {
  replay: PolicyTask[];
  objective: PolicyTask[];
  /** Ids of the objective tasks in the patched skill's slice. */
  slice: ReadonlySet<string>;
  reasons: PolicyReason[];
}

/** Splits the task list into the gated replay and objective sets. Pending and quarantined tasks are
 * excluded from both safety and efficacy (06 §4.1). */
function gatedTasks(tasks: readonly PolicyTask[], skill?: string): Gated {
  const replay: PolicyTask[] = [];
  const objective: PolicyTask[] = [];
  const reasons: PolicyReason[] = [];
  // Sorted by id so every list derived from the tasks does not depend on the order the caller
  // passed them in (06 §5.8 recompute).
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of sorted) {
    if (t.state !== 'active') {
      reasons.push({ code: 'excluded-task', severity: 'info', task: t.id, detail: t.state });
    } else if (t.kind === 'replay') replay.push(t);
    else if (OBJECTIVE_KINDS.has(t.kind)) objective.push(t);
    else reasons.push({ code: 'excluded-task', severity: 'info', task: t.id, detail: t.kind });
  }
  const slice = new Set(
    objective.filter((t) => skill === undefined || t.skills?.includes(skill)).map((t) => t.id),
  );
  return { replay, objective, slice, reasons };
}

/** Every mode some gated (active replay or objective) task declares, in mode order. */
export function requiredModes(tasks: readonly PolicyTask[]): GateMode[] {
  const g = gatedTasks(tasks);
  return sortModes([...g.replay, ...g.objective].flatMap((t) => [...taskModes(t)]));
}

/** The mode rules of 06 §5.1 / §4.7: which modes must be evaluated, and whether the evaluated set
 * matches. Invalid reasons make the evaluation ungateable; `modes-partial` is info. */
function modeReasons(
  evaluated: readonly GateMode[],
  declared: readonly GateMode[] | undefined,
  gated: Gated,
): PolicyReason[] {
  const out: PolicyReason[] = [];
  const tasks = [...gated.replay, ...gated.objective];
  const union = sortModes(tasks.flatMap((t) => [...taskModes(t)]));
  let required = union;
  if (declared !== undefined) {
    required = sortModes(declared);
    if (required.length === 0) {
      out.push({ code: 'mode-missing', severity: 'invalid', detail: 'no modes declared' });
    }
    for (const m of required) {
      if (!union.includes(m)) {
        out.push({
          code: 'mode-not-in-tasks',
          severity: 'invalid',
          mode: m,
          detail: 'declared, but no gated task declares it',
        });
      }
    }
    for (const t of tasks) {
      if (!taskModes(t).some((m) => required.includes(m))) {
        out.push({
          code: 'task-not-evaluated',
          severity: 'invalid',
          task: t.id,
          detail: `declares ${taskModes(t).join(', ')}; evaluated ${required.join(', ') || 'none'}`,
        });
      }
    }
    const skipped = union.filter((m) => !required.includes(m));
    if (skipped.length > 0) {
      out.push({
        code: 'modes-partial',
        severity: 'info',
        detail: `declared ${required.join(', ')}; not evaluated: ${skipped.join(', ')}`,
      });
    }
  }
  for (const m of required) {
    if (!evaluated.includes(m)) {
      out.push({
        code: 'mode-missing',
        severity: 'invalid',
        mode: m,
        detail:
          declared === undefined
            ? 'a gated task declares this mode, and it has no record on both sides'
            : 'declared, but it has no record on both sides',
      });
    }
  }
  for (const m of evaluated) {
    if (!required.includes(m)) {
      out.push({
        code: 'unknown-mode',
        severity: 'invalid',
        mode: m,
        detail: declared === undefined ? 'no gated task declares it' : 'not declared',
      });
    }
  }
  return out;
}

interface ValidityInput {
  models: readonly string[];
  modes: readonly GateMode[];
  tasks: readonly PolicyTask[];
  gated: Gated;
  baseline: readonly BenchOutcome[];
  candidate: readonly BenchOutcome[];
  runs: number;
}

/** Everything that makes an evaluation ungateable. A fallback-served rollout (servedBy ≠ model)
 * is invalid for gating (06 §4.8). Reading: any fallback-served outcome in either record
 * invalidates the whole evaluation, even on an excluded task, because mixing models breaks the
 * baseline identity; and a gated task missing any run on either side is invalid, not a fail.
 * A grader crash (`graderError`, scored 0) is likewise invalid on any task, either side: a broken
 * grader says nothing about the skill, so it must never read as a fail or a regression. */
function validity(v: ValidityInput): PolicyReason[] {
  const out: PolicyReason[] = [];
  const known = new Set(v.tasks.map((t) => t.id));
  for (const [side, list] of [
    ['baseline', v.baseline],
    ['candidate', v.candidate],
  ] as const) {
    for (const o of list) {
      const at = { model: o.model, mode: o.mode, task: o.task };
      if (o.servedBy !== o.model) {
        out.push({
          code: 'fallback-served',
          severity: 'invalid',
          ...at,
          detail: `${side} run ${o.run} served by ${o.servedBy}`,
        });
      }
      if (o.graderError !== undefined) {
        out.push({
          code: 'grader-error',
          severity: 'invalid',
          ...at,
          detail: `${side} run ${o.run}: ${o.graderError}`,
        });
      }
      if (!known.has(o.task)) {
        out.push({ code: 'unknown-task', severity: 'invalid', ...at, detail: side });
      }
      if (!v.models.includes(o.model)) {
        out.push({ code: 'unknown-model', severity: 'invalid', ...at, detail: side });
      }
      if (!v.modes.includes(o.mode)) {
        out.push({ code: 'unknown-mode', severity: 'invalid', ...at, detail: side });
      }
    }
  }
  const expected = Array.from({ length: v.runs }, (_, i) => i + 1).join(',');
  for (const t of [...v.gated.replay, ...v.gated.objective]) {
    for (const mode of v.modes) {
      if (!taskModes(t).includes(mode)) continue;
      for (const model of v.models) {
        for (const [side, list] of [
          ['baseline', v.baseline],
          ['candidate', v.candidate],
        ] as const) {
          const runs = list
            .filter((o) => o.task === t.id && o.model === model && o.mode === mode)
            .map((o) => o.run)
            .sort((a, b) => a - b)
            .join(',');
          if (runs !== expected) {
            out.push({
              code: 'incomplete-outcomes',
              severity: 'invalid',
              model,
              mode,
              task: t.id,
              detail: `${side} runs [${runs}], expected [${expected}]`,
            });
          }
        }
      }
    }
  }
  return out;
}

function cellStats(
  model: string,
  mode: GateMode,
  gated: Gated,
  input: Pick<PolicyInput, 'baseline' | 'candidate' | 'pValue'> & {
    runs: number;
    computeP: boolean;
  },
): CellStats {
  const base = perTaskMeans(input.baseline, model, mode);
  const cand = perTaskMeans(input.candidate, model, mode);
  const pick = (ts: PolicyTask[]) =>
    ts
      .filter((t) => taskModes(t).includes(mode))
      .map((t) => ({
        task: t.id,
        basePasses: base.get(t.id)?.passes ?? 0,
        candPasses: cand.get(t.id)?.passes ?? 0,
      }));
  const replay = pick(gated.replay);
  const objective = pick(gated.objective);
  const slice = objective.filter((o) => gated.slice.has(o.task));
  const r = input.runs;
  const n = slice.length;
  const sum = (xs: typeof objective, k: 'basePasses' | 'candPasses') =>
    xs.reduce((s, o) => s + o[k], 0);
  const sliceBase = sum(slice, 'basePasses');
  const sliceCand = sum(slice, 'candPasses');
  let pValue: number | null = null;
  let minP: number | null = null;
  if (input.computeP && n > 0) {
    const strata = slice.map((o) => ({ baseline: o.basePasses, candidate: o.candPasses, runs: r }));
    const exact = stratifiedExactTest(strata);
    minP = exact.minP;
    pValue = input.pValue ? input.pValue({ model, mode, strata }) : exact.pValue;
  }
  return {
    model,
    mode,
    runs: r,
    replay,
    objective,
    slice,
    diffUnits: sum(objective, 'candPasses') - sum(objective, 'basePasses'),
    lossP: stratifiedExactTest(
      objective.map((o) => ({ baseline: o.basePasses, candidate: o.candPasses, runs: r })),
      'less',
    ).pValue,
    sliceDiff: sliceCand - sliceBase,
    before: n === 0 ? 0 : sliceBase / (n * r),
    after: n === 0 ? 0 : sliceCand / (n * r),
    pValue,
    minP,
  };
}

/**
 * Replay safety for one cell (06 §5.4 "safety" column, §5.1 step 3). Applies to every model and
 * both modes at every radius. Returns the fail reasons (regressions), the `blocked` reasons (a
 * flaky baseline task at high radius: a property of the baseline, never of the candidate), the
 * info reasons (tasks that cannot regress because they fail in the baseline; a cell where none can
 * regress, whose safety is vacuous) and the regression list for GateResult.
 */
function replaySafety(
  c: CellStats,
  radius: BlastRadius,
  exempt: ReadonlySet<string>,
): {
  reasons: PolicyReason[];
  blocked: PolicyReason[];
  info: PolicyReason[];
  regressions: string[];
  baselinePassing: number;
  passing: number;
} {
  const reasons: PolicyReason[] = [];
  const blocked: PolicyReason[] = [];
  const info: PolicyReason[] = [];
  const regressions: string[] = [];
  const need = replayThreshold(radius, c.runs);
  let baselinePassing = 0;
  let passing = 0;
  for (const t of c.replay) {
    const isBaselinePassing = t.basePasses >= twoThirds(c.runs);
    if (isBaselinePassing) baselinePassing++;
    if (t.candPasses >= need) passing++;
    const at = { model: c.model, mode: c.mode, task: t.task };
    if (!isBaselinePassing) {
      info.push({
        code: 'replay-baseline-failing',
        severity: 'info',
        ...at,
        detail: `baseline ${t.basePasses}/${c.runs}: not baseline-passing, so it cannot regress`,
      });
    }
    // Reading (06 §5.4, high radius): "no flaky replay task may exist in the baseline" covers every
    // gated replay task EXCEPT a safety-fix target. The safety-fix path exists for replay tasks
    // that fail in the baseline, and a target at 1/3 is exactly such a task; holding it to the
    // flaky rule would make it unfixable. The target is held to 3 of 3 on the candidate instead.
    if (exempt.has(t.task)) continue;
    if (radius === 'high' && t.basePasses > 0 && t.basePasses < c.runs) {
      blocked.push({
        code: 'flaky-baseline',
        severity: 'blocked',
        ...at,
        detail: `baseline ${t.basePasses}/${c.runs}: fix or quarantine ${t.task}, then re-baseline; this says nothing about the candidate`,
      });
    }
    if (isBaselinePassing && t.candPasses < need) {
      regressions.push(t.task);
      reasons.push({
        code: 'replay-regression',
        severity: 'fail',
        ...at,
        detail: `baseline ${t.basePasses}/${c.runs}, candidate ${t.candPasses}/${c.runs}, needs ${need}/${c.runs}`,
      });
    }
  }
  if (baselinePassing === 0) {
    info.push({
      code: 'safety-vacuous',
      severity: 'info',
      model: c.model,
      mode: c.mode,
      detail: `0 of ${c.replay.length} replay task(s) baseline-passing: the replay constraint cannot fail here`,
    });
  }
  return { reasons, blocked, info, regressions, baselinePassing, passing };
}

/** The non-regression rule of one gate: the algorithm version selects it (06 §5.4, §5.8). */
interface NonRegression {
  /** True for versions ≥ 3 (the exact test); false for the legacy fixed count. */
  exact: boolean;
  alpha: number;
  /** LEGACY (versions ≤ 2): the fixed-count fraction. */
  fraction: number;
}

/** LEGACY (algorithm ≤ 2): over every objective task, the cell loses at most `lossBound` passes. */
function noWorseFixedCount(c: CellStats, fraction: number): boolean {
  return c.diffUnits >= -lossBound(c.objective.length * c.runs, fraction);
}

/** Algorithm ≥ 3: the cell is a regression when the exact one-sided p for "the candidate is worse"
 * over every objective task is ≤ alpha. A loss that is not significant passes. */
function noWorseExact(c: CellStats, alpha: number): boolean {
  return c.lossP === null || !(c.lossP <= alpha);
}

function noWorse(c: CellStats, rule: NonRegression): boolean {
  return rule.exact ? noWorseExact(c, rule.alpha) : noWorseFixedCount(c, rule.fraction);
}

/** A p-value for a reason text: 3 significant digits (the comparison itself uses the exact value). */
const shownP = (p: number | null): string =>
  p === null ? 'not computed' : `${Number(p.toPrecision(3))}`;

function lossDetail(c: CellStats, rule: NonRegression): string {
  const shape = `Δ ${c.diffUnits} passes over ${c.objective.length} tasks × ${c.runs} runs`;
  if (!rule.exact) {
    // LEGACY wording, unchanged.
    return `${shape}; at most ${lossBound(c.objective.length * c.runs, rule.fraction)} may be lost`;
  }
  const total = c.objective.length * c.runs;
  const passes = (k: 'basePasses' | 'candPasses') => c.objective.reduce((s, o) => s + o[k], 0);
  return `baseline ${passes('basePasses')}/${total}, candidate ${passes('candPasses')}/${total}: ${shape}; one-sided exact p ${shownP(c.lossP)} ≤ alpha ${rule.alpha}`;
}

function capabilityLabel(mode: GateMode): ReasonCode {
  return mode === 'isolation' ? 'capability-regression' : 'production-regression';
}

/** True for the cells whose efficacy is the strict test (06 §5.4): isolation mode, on both models
 * at high radius and on `frontier` otherwise. */
function strictCell(c: CellStats, role: 'frontier' | 'small', radius: BlastRadius): boolean {
  return c.mode === 'isolation' && (radius === 'high' || role === 'frontier');
}

/** Why a strict cell cannot be tested at all (06 §5.2), or null. */
function powerProblem(c: CellStats, alpha: number, skill: string | undefined): PolicyReason | null {
  const at = { model: c.model, mode: c.mode };
  if (c.slice.length === 0) {
    return {
      code: 'no-slice',
      severity: 'blocked',
      ...at,
      detail:
        skill === undefined
          ? 'no objective task is gated'
          : `no gated objective task exercises ${skill}: its slice is empty`,
    };
  }
  if (c.minP !== null && !(c.minP < alpha)) {
    return {
      code: 'underpowered',
      severity: 'blocked',
      ...at,
      detail: `attainable minimum p ${c.minP} ≥ ${alpha}: ${c.slice.length} slice task(s) × ${c.runs} runs, baseline ${c.slice.map((o) => `${o.basePasses}/${c.runs}`).join(', ')}; no candidate outcome could be significant`,
    };
  }
  return null;
}

/** Standard-path capability rules for one cell (06 §5.4 efficacy and production columns). An
 * underpowered strict cell gets no efficacy verdict here (`powerProblem` reports it). */
function standardCapability(
  c: CellStats,
  role: 'frontier' | 'small',
  radius: BlastRadius,
  alpha: number,
  rule: NonRegression,
  powered: boolean,
): PolicyReason[] {
  const at = { model: c.model, mode: c.mode };
  const out: PolicyReason[] = [];
  if (c.mode === 'isolation') {
    if (strictCell(c, role, radius)) {
      if (powered) {
        const detail = `Δ ${c.sliceDiff} passes over ${c.slice.length} slice task(s) × ${c.runs} runs`;
        // §5.1 step 4: "strictly greater", then p < alpha.
        if (c.sliceDiff <= 0)
          out.push({ code: 'no-strict-improvement', severity: 'fail', ...at, detail });
        if (c.pValue === null || !(c.pValue < alpha)) {
          out.push({
            code: 'not-significant',
            severity: 'fail',
            ...at,
            detail: `p ${c.pValue === null ? 'not computed' : c.pValue} ≥ ${alpha}`,
          });
        }
      }
      // The slice may improve while the rest of the bench falls: the whole objective set is
      // held to the non-regression rule as well.
      if (!noWorse(c, rule)) {
        out.push({
          code: 'capability-regression',
          severity: 'fail',
          ...at,
          detail: lossDetail(c, rule),
        });
      }
      return out;
    }
    // medium: small not regressed; low: no efficacy rule on small.
    if (radius === 'medium' && !noWorse(c, rule)) {
      return [
        { code: 'capability-regression', severity: 'fail', ...at, detail: lossDetail(c, rule) },
      ];
    }
    return [];
  }
  // production: both models at high and medium, frontier only at low.
  const checked = radius !== 'low' || role === 'frontier';
  if (checked && !noWorse(c, rule)) {
    return [
      { code: 'production-regression', severity: 'fail', ...at, detail: lossDetail(c, rule) },
    ];
  }
  return [];
}

/**
 * Applies the §5.4 table. Pure: the same input always gives the same output, byte for byte.
 */
export function applyPolicy(input: PolicyInput): PolicyOutput {
  const runs = input.runs ?? DEFAULT_RUNS;
  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const rule: NonRegression = {
    exact: (input.algorithm ?? GATE_ALGORITHM) >= EXACT_NON_REGRESSION_SINCE,
    alpha,
    fraction: input.nonRegressionFraction ?? DEFAULT_NON_REGRESSION_FRACTION,
  };
  const modes = sortModes(input.modes);
  const roles = [
    ['frontier', input.models.frontier],
    ['small', input.models.small],
  ] as const;
  const modelIds = roles.map(([, id]) => id);
  const outlet = input.outlet ?? 'skill';
  const gated = gatedTasks(input.tasks, outlet === 'skill' ? input.skill : undefined);
  const reasons: PolicyReason[] = [...gated.reasons];

  const invalid = validity({
    models: modelIds,
    modes,
    tasks: input.tasks,
    gated,
    baseline: input.baseline,
    candidate: input.candidate,
    runs,
  });
  if (input.models.frontier === input.models.small) {
    invalid.push({
      code: 'models-not-distinct',
      severity: 'invalid',
      model: input.models.frontier,
      detail: 'the gate pair must be two different models (06 §5.3)',
    });
  }
  const modeProblems = modeReasons(modes, input.declaredModes, gated);
  invalid.push(...modeProblems.filter((r) => r.severity === 'invalid'));
  reasons.push(...modeProblems.filter((r) => r.severity === 'info'));
  if (outlet === 'template' && !input.template) {
    invalid.push({
      code: 'template-evidence-missing',
      severity: 'invalid',
      detail: 'a template candidate needs generated-app test and mutant results (06 §5.6)',
    });
  } else if (outlet === 'template' && input.template) {
    // No lane or no mutant means nothing was shown at all: not a template evaluation.
    if (input.template.lanes.length === 0) {
      invalid.push({ code: 'template-no-lanes', severity: 'invalid' });
    }
    if (input.template.mutants.length === 0) {
      invalid.push({ code: 'template-no-mutants', severity: 'invalid' });
    }
  }
  if (modes.length === 0) {
    invalid.push({ code: 'mode-missing', severity: 'invalid', detail: 'no modes evaluated' });
  } else if (outlet === 'skill' && input.path === 'standard' && !modes.includes('isolation')) {
    // §5.1 step 4: efficacy is measured in isolation mode; a standard gate without it cannot pass
    // or fail on efficacy, so it is not a gate result at all.
    invalid.push({
      code: 'mode-missing',
      severity: 'invalid',
      mode: 'isolation',
      detail: 'the standard path needs isolation mode',
    });
  }
  if (invalid.length > 0) {
    return {
      decision: 'invalid',
      path: input.path,
      results: [],
      reasons: [...reasons, ...invalid],
      tieBreak: false,
    };
  }
  if (gated.objective.length === 0) {
    reasons.push({ code: 'no-objective-tasks', severity: 'info' });
  }
  const standardSkill = input.path === 'standard' && outlet === 'skill';
  if (standardSkill && input.skill !== undefined) {
    reasons.push({
      code: 'efficacy-slice',
      severity: 'info',
      detail: `${input.skill}: ${[...gated.slice].join(', ') || 'no objective task'}`,
    });
  }

  const targets = new Set(input.path === 'safety-fix' ? (input.safetyFixTargets ?? []) : []);
  const pathReasons: PolicyReason[] = [];
  if (input.path === 'safety-fix') {
    if (targets.size === 0) pathReasons.push({ code: 'safety-fix-no-targets', severity: 'fail' });
    const replayIds = new Set(gated.replay.map((t) => t.id));
    for (const t of targets) {
      if (!replayIds.has(t)) {
        pathReasons.push({
          code: 'safety-fix-target-unknown',
          severity: 'fail',
          task: t,
          detail: 'not an active gated replay task',
        });
      }
    }
  }
  if (input.path === 'neutral') {
    if (!input.neutralReason?.trim()) {
      pathReasons.push({ code: 'neutral-needs-reason', severity: 'fail' });
    }
    if (input.neutralPendingForSkill) {
      pathReasons.push({ code: 'neutral-already-pending', severity: 'fail' });
    }
  }
  if (outlet === 'template' && input.template) {
    const { lanes, mutants } = input.template;
    for (const l of lanes) {
      if (!l.passed) {
        pathReasons.push({ code: 'template-lane-failed', severity: 'fail', detail: l.lane });
      }
    }
    for (const m of mutants) {
      if (!m.caught) {
        pathReasons.push({ code: 'template-mutant-escaped', severity: 'fail', detail: m.id });
      }
    }
  }

  type Cell = {
    stats: CellStats;
    role: 'frontier' | 'small';
    safety: ReturnType<typeof replaySafety>;
    capability: PolicyReason[];
    target: PolicyReason[];
    /** Set when this strict cell's efficacy test cannot reach alpha (06 §5.2). */
    power: PolicyReason | null;
  };
  const cells: Cell[] = [];
  const targetFailsSomewhere = new Set<string>();
  for (const [role, model] of roles) {
    for (const mode of modes) {
      const stats = cellStats(model, mode, gated, {
        baseline: input.baseline,
        candidate: input.candidate,
        pValue: input.pValue,
        runs,
        // Reading (08 §8 "null when not computed"): p is computed for isolation mode, where the
        // efficacy objective lives (§4.7); production mode is a non-regression check only.
        computeP: mode === 'isolation',
      });
      const safety = replaySafety(stats, input.radius, targets);
      const power =
        standardSkill && strictCell(stats, role, input.radius)
          ? powerProblem(stats, alpha, input.skill)
          : null;
      // Reading (06 §5.6 template): "capability rollouts on cells using the template do not
      // regress in either mode" is the non-regression rule of §5.4, on every model.
      const capability = standardSkill
        ? standardCapability(stats, role, input.radius, alpha, rule, power === null)
        : // Reading (06 §5.4, alternative paths): "non-regression must hold" applies to every
          // model in both modes, which is stricter than the standard path's per-radius
          // production column.
          noWorse(stats, rule)
          ? []
          : [
              {
                code: capabilityLabel(mode),
                severity: 'fail' as const,
                model,
                mode,
                detail: lossDetail(stats, rule),
              },
            ];
      const target: PolicyReason[] = [];
      for (const t of stats.replay) {
        if (!targets.has(t.task)) continue;
        if (t.basePasses < twoThirds(runs)) targetFailsSomewhere.add(t.task);
        // Reading (06 §5.4 safety-fix): "become baseline-passing under the candidate … on every
        // model" is checked in every evaluated mode too, at the radius threshold.
        const need = replayThreshold(input.radius, runs);
        if (t.candPasses < need) {
          target.push({
            code: 'safety-fix-target-not-fixed',
            severity: 'fail',
            model,
            mode,
            task: t.task,
            detail: `candidate ${t.candPasses}/${runs}, needs ${need}/${runs}`,
          });
        }
      }
      cells.push({ stats, role, safety, capability, target, power });
    }
  }
  if (input.path === 'safety-fix') {
    for (const t of targets) {
      if (gated.replay.some((r) => r.id === t) && !targetFailsSomewhere.has(t)) {
        pathReasons.push({
          code: 'safety-fix-target-not-failing',
          severity: 'fail',
          task: t,
          detail: 'baseline-passing on every model and mode',
        });
      }
    }
  }

  const cellPasses = (c: Cell) =>
    c.safety.reasons.length === 0 &&
    c.capability.length === 0 &&
    c.target.length === 0 &&
    c.power === null;
  const underpowered = cells.some((c) => c.power !== null);
  let tieBreak = false;
  const standardAccepts = cells.every(cellPasses) && pathReasons.length === 0;
  // Reading (06 §5.5): the tie-break is an equivalence claim, so it is not offered when the
  // efficacy test is underpowered: a slice too small to show a gain cannot show "no change".
  if (standardSkill && !standardAccepts && !underpowered && input.tieBreak?.enabled) {
    // 06 §5.5: replay constraint holds; a tie on both models (Reading: in every evaluated mode)
    // with p ≥ alpha where computed; SKILL.md shrinks by ≥ 10%, by deletions only. The line
    // counts and the deletions-only claim are derived here from the two texts.
    const text = shorterByDeletion(input.tieBreak.before, input.tieBreak.after);
    const flat = cells.every(
      (c) =>
        c.safety.reasons.length === 0 &&
        Math.abs(c.stats.diffUnits) <= tieTolerance(c.stats.objective.length * c.stats.runs) &&
        (c.stats.pValue === null || c.stats.pValue >= alpha),
    );
    if (text.shorter && text.deletionsOnly && flat) {
      tieBreak = true;
      reasons.push({
        code: 'tie-break-shorter',
        severity: 'info',
        detail: `SKILL.md ${text.linesBefore} → ${text.linesAfter} lines, deletions only`,
      });
    }
  }

  const results: GateResult[] = cells.map((c) => ({
    model: c.stats.model,
    mode: c.stats.mode,
    split: 'val',
    runs,
    replay: {
      total: c.stats.replay.length,
      baselinePassing: c.safety.baselinePassing,
      candidatePassing: c.safety.passing,
      regressions: c.safety.regressions,
    },
    capability: {
      before: c.stats.before,
      after: c.stats.after,
      delta: c.stats.after - c.stats.before,
      pValue: c.stats.pValue,
      minP: c.stats.minP,
    },
    decision: cellPasses(c) || (tieBreak && c.safety.reasons.length === 0) ? 'pass' : 'fail',
  }));
  for (const c of cells) reasons.push(...c.safety.info);
  const blocked = cells.flatMap((c) => c.safety.blocked);
  if (blocked.length > 0) {
    // A flaky baseline task (high radius) is a property of the baseline: no decision is made, and
    // nothing is recorded against the candidate. Every other finding is withheld with it.
    return {
      decision: 'blocked',
      path: input.path,
      results,
      reasons: [...reasons, ...blocked],
      tieBreak: false,
    };
  }
  if (!tieBreak) {
    for (const c of cells) reasons.push(...c.safety.reasons, ...c.capability, ...c.target);
  } else {
    for (const c of cells) reasons.push(...c.safety.reasons, ...c.target);
  }
  reasons.push(...pathReasons);
  const failed = reasons.some((r) => r.severity === 'fail');
  if (failed) {
    // A rule that needs no statistical power failed (replay, non-regression, a path rule, or a
    // powered cell's efficacy): a rejection, whatever the power of the remaining cells.
    for (const c of cells) if (c.power) reasons.push({ ...c.power, severity: 'info' });
    return { decision: 'reject', path: input.path, results, reasons, tieBreak };
  }
  if (underpowered) {
    for (const c of cells) if (c.power) reasons.push(c.power);
    return { decision: 'underpowered', path: input.path, results, reasons, tieBreak: false };
  }
  return { decision: 'accept', path: input.path, results, reasons, tieBreak };
}

export interface EarlyStopInput {
  models: { frontier: string; small: string };
  modes: readonly GateMode[];
  tasks: readonly PolicyTask[];
  baseline: readonly BenchOutcome[];
  runs?: number;
}

/**
 * The early stop (06 §1.3 step 3, §9): the baseline already scores capability 1.0 with every
 * replay passing on both models, so the proposer is not run and the harness records `no-action`.
 * Reading: "every replay passing" means every run (R of R) in every evaluated mode; at least one
 * objective task must exist (an empty objective has no capability of 1.0); and a fallback-served or
 * grader-error baseline outcome means the baseline cannot be trusted, so there is no early stop.
 */
export function earlyStop(input: EarlyStopInput): { stop: boolean; detail: string } {
  const runs = input.runs ?? DEFAULT_RUNS;
  const gated = gatedTasks(input.tasks);
  if (gated.objective.length === 0) return { stop: false, detail: 'no objective tasks' };
  if (input.baseline.some((o) => o.servedBy !== o.model)) {
    return { stop: false, detail: 'fallback-served baseline outcome' };
  }
  if (input.baseline.some((o) => o.graderError !== undefined)) {
    return { stop: false, detail: 'grader-error baseline outcome' };
  }
  const modes = sortModes(input.modes);
  if (modes.length === 0) return { stop: false, detail: 'no modes evaluated' };
  for (const model of [input.models.frontier, input.models.small]) {
    for (const mode of modes) {
      const m = perTaskMeans(input.baseline, model, mode);
      for (const t of [...gated.replay, ...gated.objective]) {
        if (!taskModes(t).includes(mode)) continue;
        const s = m.get(t.id);
        if (!s || s.runs !== runs || s.passes !== runs) {
          return {
            stop: false,
            detail: `${t.id} on ${model}/${mode} is ${s?.passes ?? 0}/${runs}`,
          };
        }
      }
    }
  }
  return { stop: true, detail: 'early stop: baseline capability 1.0 and every replay passing' };
}

export interface ReleasePolicyInput {
  models: { frontier: string; small: string };
  modes: readonly GateMode[];
  /** As PolicyInput.declaredModes: absent, every mode a gated test task declares is required. */
  declaredModes?: readonly GateMode[];
  tasks: readonly PolicyTask[];
  /** The previously released skill set on the test split. */
  previous: readonly BenchOutcome[];
  candidate: readonly BenchOutcome[];
  runs?: number;
  /** Reading (06 §5.7): at high radius a test replay "regression" uses the 3-of-3 threshold of
   * §5.4, stricter than the general 2-of-3. Defaults to medium (2 of 3). */
  radius?: BlastRadius;
  /** The fixed-count fraction (`lossBound`). The release check records no algorithm version, so
   * it still uses the fixed count. Default 0.1. */
  nonRegressionFraction?: number;
}

/**
 * The release check (06 §5.7): blocked when any test replay task regresses, or test capability
 * falls by more than the non-regression bound (`lossBound`) on either model, in either mode.
 */
export function releasePolicy(input: ReleasePolicyInput): {
  decision: 'pass' | 'blocked' | 'invalid';
  results: GateResult[];
  reasons: PolicyReason[];
} {
  const runs = input.runs ?? DEFAULT_RUNS;
  const radius = input.radius ?? 'medium';
  const rule: NonRegression = {
    exact: false,
    alpha: DEFAULT_ALPHA,
    fraction: input.nonRegressionFraction ?? DEFAULT_NON_REGRESSION_FRACTION,
  };
  const modes = sortModes(input.modes);
  const gated = gatedTasks(input.tasks);
  const ids = [input.models.frontier, input.models.small];
  const reasons: PolicyReason[] = [...gated.reasons];
  const invalid = validity({
    models: ids,
    modes,
    tasks: input.tasks,
    gated,
    baseline: input.previous,
    candidate: input.candidate,
    runs,
  });
  const modeProblems = modeReasons(modes, input.declaredModes, gated);
  invalid.push(...modeProblems.filter((r) => r.severity === 'invalid'));
  reasons.push(...modeProblems.filter((r) => r.severity === 'info'));
  if (modes.length === 0) invalid.push({ code: 'mode-missing', severity: 'invalid' });
  if (invalid.length > 0) {
    return { decision: 'invalid', results: [], reasons: [...reasons, ...invalid] };
  }
  const results: GateResult[] = [];
  for (const model of ids) {
    for (const mode of modes) {
      const c = cellStats(model, mode, gated, {
        baseline: input.previous,
        candidate: input.candidate,
        runs,
        computeP: false,
      });
      // §5.7 has no flaky-baseline rule; only regressions block.
      const safety = replaySafety(c, radius, new Set());
      const fails = safety.reasons.filter((r) => r.code === 'replay-regression');
      if (!noWorse(c, rule)) {
        fails.push({
          code: capabilityLabel(mode),
          severity: 'fail',
          model,
          mode,
          detail: lossDetail(c, rule),
        });
      }
      reasons.push(...fails);
      results.push({
        model,
        mode,
        split: 'test',
        runs,
        replay: {
          total: c.replay.length,
          baselinePassing: safety.baselinePassing,
          candidatePassing: safety.passing,
          regressions: safety.regressions,
        },
        capability: {
          before: c.before,
          after: c.after,
          delta: c.after - c.before,
          pValue: null,
          minP: null,
        },
        decision: fails.length === 0 ? 'pass' : 'fail',
      });
    }
  }
  return {
    decision: results.every((r) => r.decision === 'pass') ? 'pass' : 'blocked',
    results,
    reasons,
  };
}
