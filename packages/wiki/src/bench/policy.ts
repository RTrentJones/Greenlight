import type { TaskSpec } from '../schema/bench';
import type { GateResult } from '../schema/ledger';
import {
  type BenchOutcome,
  DEFAULT_RESAMPLES,
  type GateMode,
  pairedBootstrap,
  perTaskMeans,
} from './stats';

/**
 * The single policy table (vision 06 §5.4) as a pure function. §5.1 is the procedure; this module
 * supplies its thresholds. Inputs are per-task, per-run outcomes for the baseline and candidate on
 * the two gate models (§5.3) in each evaluated mode (§4.7); the output is one GateResult per
 * model × mode (08 §8) plus an overall decision with machine-readable reasons.
 *
 * All threshold comparisons are done in integer pass counts, never floats: with R runs per task,
 * "one task-mean" is R passes summed over the objective tasks (a mean move of 1/N, N tasks), and a
 * replay task "passes k of R" is a count. The boundary vectors (13 §2.8) sit exactly on these
 * integer edges, so there is no rounding to argue about.
 *
 * Spec readings (the stricter one wherever the text is ambiguous) are marked "Reading:" below.
 */

export type BlastRadius = 'high' | 'medium' | 'low';
export type GatePath = 'standard' | 'safety-fix' | 'neutral';
export type PolicyDecision = 'accept' | 'reject' | 'invalid';

export const GATE_MODES: readonly GateMode[] = ['isolation', 'production'];

/** A task as the policy sees it. `modes` defaults to both (08 §10.1). */
export type PolicyTask = Pick<TaskSpec, 'id' | 'kind' | 'state'> & {
  modes?: readonly GateMode[];
};

export const REASON_CODES = [
  // invalid: the evaluation cannot be gated at all
  'fallback-served',
  'incomplete-outcomes',
  'unknown-task',
  'unknown-model',
  'unknown-mode',
  'mode-missing',
  // fail: a policy rule did not hold
  'replay-regression',
  'flaky-baseline',
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
  // info: recorded, does not change the decision on its own
  'excluded-task',
  'no-objective-tasks',
  'tie-break-shorter',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface PolicyReason {
  code: ReasonCode;
  severity: 'invalid' | 'fail' | 'info';
  model?: string;
  mode?: GateMode;
  task?: string;
  detail?: string;
}

export interface PValueArgs {
  model: string;
  mode: GateMode;
  baseline: readonly number[];
  candidate: readonly number[];
  seed: string;
  resamples: number;
}

export interface PolicyInput {
  radius: BlastRadius;
  path: GatePath;
  /** The gate pair (06 §5.3). */
  models: { frontier: string; small: string };
  /** The modes evaluated in this gate, in any order. */
  modes: readonly GateMode[];
  tasks: readonly PolicyTask[];
  baseline: readonly BenchOutcome[];
  candidate: readonly BenchOutcome[];
  /** Runs per task × model × mode (06 §5.1: 3). */
  runs?: number;
  /** Significance level (06 §5.1: 0.05); the test is p < alpha. */
  alpha?: number;
  resamples?: number;
  /** Base seed for the bootstrap; each model × mode derives `${seed}|${model}|${mode}`. */
  seed: string;
  /** safety-fix path: the replay tasks that motivated the proposal (06 §5.4). */
  safetyFixTargets?: readonly string[];
  /** neutral path: the human's recorded approval reason (06 §5.4). */
  neutralReason?: string;
  /** neutral path: another neutral change is already pending for this skill (06 §5.4). */
  neutralPendingForSkill?: boolean;
  /** Tie-break (06 §5.5): enabled from bench/gate.json, with the target SKILL.md line counts. */
  tieBreak?: { enabled: boolean; linesBefore: number; linesAfter: number };
  /** Override the p-value computation (boundary vectors pin p exactly). Defaults to the bootstrap. */
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
  objective: { task: string; basePasses: number; candPasses: number }[];
  /** Σ candidate passes − Σ baseline passes over objective tasks; one task-mean = `runs`. */
  diffUnits: number;
  before: number;
  after: number;
  pValue: number | null;
}

interface Gated {
  replay: PolicyTask[];
  objective: PolicyTask[];
  reasons: PolicyReason[];
}

/** Splits the task list into the gated replay and objective sets. Pending and quarantined tasks are
 * excluded from both safety and efficacy (06 §4.1). */
function gatedTasks(tasks: readonly PolicyTask[]): Gated {
  const replay: PolicyTask[] = [];
  const objective: PolicyTask[] = [];
  const reasons: PolicyReason[] = [];
  for (const t of tasks) {
    if (t.state !== 'active') {
      reasons.push({ code: 'excluded-task', severity: 'info', task: t.id, detail: t.state });
    } else if (t.kind === 'replay') replay.push(t);
    else if (OBJECTIVE_KINDS.has(t.kind)) objective.push(t);
    else reasons.push({ code: 'excluded-task', severity: 'info', task: t.id, detail: t.kind });
  }
  return { replay, objective, reasons };
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
 * baseline identity; and a gated task missing any run on either side is invalid, not a fail. */
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
  input: Pick<PolicyInput, 'baseline' | 'candidate' | 'seed' | 'pValue'> & {
    runs: number;
    resamples: number;
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
  const r = input.runs;
  const baseMeans = objective.map((o) => o.basePasses / r);
  const candMeans = objective.map((o) => o.candPasses / r);
  const n = objective.length;
  const sumBase = objective.reduce((s, o) => s + o.basePasses, 0);
  const sumCand = objective.reduce((s, o) => s + o.candPasses, 0);
  const seed = `${input.seed}|${model}|${mode}`;
  let pValue: number | null = null;
  if (input.computeP && n > 0) {
    pValue = input.pValue
      ? input.pValue({
          model,
          mode,
          baseline: baseMeans,
          candidate: candMeans,
          seed,
          resamples: input.resamples,
        })
      : pairedBootstrap(baseMeans, candMeans, { seed, resamples: input.resamples }).pValue;
  }
  return {
    model,
    mode,
    runs: r,
    replay,
    objective,
    diffUnits: sumCand - sumBase,
    before: n === 0 ? 0 : sumBase / (n * r),
    after: n === 0 ? 0 : sumCand / (n * r),
    pValue,
  };
}

/** Replay safety for one cell (06 §5.4 "safety" column, §5.1 step 3). Applies to every model and
 * both modes at every radius. Returns fail reasons and the regression list for GateResult. */
function replaySafety(
  c: CellStats,
  radius: BlastRadius,
  exempt: ReadonlySet<string>,
): { reasons: PolicyReason[]; regressions: string[]; baselinePassing: number; passing: number } {
  const reasons: PolicyReason[] = [];
  const regressions: string[] = [];
  const need = replayThreshold(radius, c.runs);
  let baselinePassing = 0;
  let passing = 0;
  for (const t of c.replay) {
    const isBaselinePassing = t.basePasses >= twoThirds(c.runs);
    if (isBaselinePassing) baselinePassing++;
    if (t.candPasses >= need) passing++;
    const at = { model: c.model, mode: c.mode, task: t.task };
    // Reading (06 §5.4, high radius): "no flaky replay task may exist in the baseline" covers every
    // gated replay task, including a safety-fix target. A target at 1/3 or 2/3 must be fixed or
    // quarantined by a human first; a high-radius safety fix starts from 0/3.
    if (radius === 'high' && t.basePasses > 0 && t.basePasses < c.runs) {
      reasons.push({
        code: 'flaky-baseline',
        severity: 'fail',
        ...at,
        detail: `baseline ${t.basePasses}/${c.runs}`,
      });
    }
    if (exempt.has(t.task)) continue;
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
  return { reasons, regressions, baselinePassing, passing };
}

/** Capability falls by no more than one task-mean: Δ passes ≥ −R. Exactly one task-mean passes. */
function noWorseThanOneTaskMean(c: CellStats): boolean {
  return c.diffUnits >= -c.runs;
}

function capabilityLabel(mode: GateMode): ReasonCode {
  return mode === 'isolation' ? 'capability-regression' : 'production-regression';
}

/** Standard-path capability rules for one cell (06 §5.4 efficacy and production columns). */
function standardCapability(
  c: CellStats,
  role: 'frontier' | 'small',
  radius: BlastRadius,
  alpha: number,
): PolicyReason[] {
  const at = { model: c.model, mode: c.mode };
  const detail = `Δ ${c.diffUnits} passes over ${c.objective.length} tasks × ${c.runs} runs`;
  if (c.mode === 'isolation') {
    const strict = radius === 'high' || role === 'frontier';
    if (strict) {
      const out: PolicyReason[] = [];
      // §5.1 step 4: "strictly greater", then p < alpha.
      if (c.diffUnits <= 0)
        out.push({ code: 'no-strict-improvement', severity: 'fail', ...at, detail });
      if (c.pValue === null || !(c.pValue < alpha)) {
        out.push({
          code: 'not-significant',
          severity: 'fail',
          ...at,
          detail: `p ${c.pValue === null ? 'not computed' : c.pValue} ≥ ${alpha}`,
        });
      }
      return out;
    }
    // medium: small no worse than one task-mean; low: no efficacy rule on small.
    if (radius === 'medium' && !noWorseThanOneTaskMean(c)) {
      return [{ code: 'capability-regression', severity: 'fail', ...at, detail }];
    }
    return [];
  }
  // production: both models at high and medium, frontier only at low.
  const checked = radius !== 'low' || role === 'frontier';
  if (checked && !noWorseThanOneTaskMean(c)) {
    return [{ code: 'production-regression', severity: 'fail', ...at, detail }];
  }
  return [];
}

/**
 * Applies the §5.4 table. Pure: the same input always gives the same output, byte for byte.
 */
export function applyPolicy(input: PolicyInput): PolicyOutput {
  const runs = input.runs ?? DEFAULT_RUNS;
  const alpha = input.alpha ?? DEFAULT_ALPHA;
  const resamples = input.resamples ?? DEFAULT_RESAMPLES;
  const modes = sortModes(input.modes);
  const roles = [
    ['frontier', input.models.frontier],
    ['small', input.models.small],
  ] as const;
  const modelIds = roles.map(([, id]) => id);
  const gated = gatedTasks(input.tasks);
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
  if (modes.length === 0) {
    invalid.push({ code: 'mode-missing', severity: 'invalid', detail: 'no modes evaluated' });
  } else if (input.path === 'standard' && !modes.includes('isolation')) {
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

  type Cell = {
    stats: CellStats;
    role: 'frontier' | 'small';
    safety: ReturnType<typeof replaySafety>;
    capability: PolicyReason[];
    target: PolicyReason[];
  };
  const cells: Cell[] = [];
  const targetFailsSomewhere = new Set<string>();
  for (const [role, model] of roles) {
    for (const mode of modes) {
      const stats = cellStats(model, mode, gated, {
        baseline: input.baseline,
        candidate: input.candidate,
        seed: input.seed,
        pValue: input.pValue,
        runs,
        resamples,
        // Reading (08 §8 "null when not computed"): p is computed for isolation mode, where the
        // efficacy objective lives (§4.7); production mode is a non-regression check only.
        computeP: mode === 'isolation',
      });
      const safety = replaySafety(stats, input.radius, targets);
      const capability =
        input.path === 'standard'
          ? standardCapability(stats, role, input.radius, alpha)
          : // Reading (06 §5.4, alternative paths): "capability does not fall by more than one
            // task-mean" / "non-regression must hold" applies to every model in both modes, which
            // is stricter than the standard path's per-radius production column.
            noWorseThanOneTaskMean(stats)
            ? []
            : [
                {
                  code: capabilityLabel(mode),
                  severity: 'fail' as const,
                  model,
                  mode,
                  detail: `Δ ${stats.diffUnits} passes over ${stats.objective.length} tasks × ${runs} runs`,
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
      cells.push({ stats, role, safety, capability, target });
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
    c.safety.reasons.length === 0 && c.capability.length === 0 && c.target.length === 0;
  let tieBreak = false;
  const standardAccepts = cells.every(cellPasses) && pathReasons.length === 0;
  if (input.path === 'standard' && !standardAccepts && input.tieBreak?.enabled) {
    // 06 §5.5: replay constraint holds; |Δ| < 1 task-mean on both models (Reading: in every
    // evaluated mode) with p ≥ alpha where computed; SKILL.md shrinks by ≥ 10%.
    const { linesBefore, linesAfter } = input.tieBreak;
    const shorter = linesBefore > 0 && linesAfter * 10 <= linesBefore * 9;
    const flat = cells.every(
      (c) =>
        c.safety.reasons.length === 0 &&
        Math.abs(c.stats.diffUnits) < c.stats.runs &&
        (c.stats.pValue === null || c.stats.pValue >= alpha),
    );
    if (shorter && flat) {
      tieBreak = true;
      reasons.push({
        code: 'tie-break-shorter',
        severity: 'info',
        detail: `SKILL.md ${linesBefore} → ${linesAfter} lines`,
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
    },
    decision: cellPasses(c) || (tieBreak && c.safety.reasons.length === 0) ? 'pass' : 'fail',
  }));
  if (!tieBreak) {
    for (const c of cells) reasons.push(...c.safety.reasons, ...c.capability, ...c.target);
  } else {
    for (const c of cells) reasons.push(...c.safety.reasons, ...c.target);
  }
  reasons.push(...pathReasons);
  const accept = results.every((r) => r.decision === 'pass') && pathReasons.length === 0;
  return { decision: accept ? 'accept' : 'reject', path: input.path, results, reasons, tieBreak };
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
 * objective task must exist (an empty objective has no capability of 1.0); and a fallback-served
 * baseline outcome means the baseline cannot be trusted, so there is no early stop.
 */
export function earlyStop(input: EarlyStopInput): { stop: boolean; detail: string } {
  const runs = input.runs ?? DEFAULT_RUNS;
  const gated = gatedTasks(input.tasks);
  if (gated.objective.length === 0) return { stop: false, detail: 'no objective tasks' };
  if (input.baseline.some((o) => o.servedBy !== o.model)) {
    return { stop: false, detail: 'fallback-served baseline outcome' };
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
  tasks: readonly PolicyTask[];
  /** The previously released skill set on the test split. */
  previous: readonly BenchOutcome[];
  candidate: readonly BenchOutcome[];
  runs?: number;
  /** Reading (06 §5.7): at high radius a test replay "regression" uses the 3-of-3 threshold of
   * §5.4, stricter than the general 2-of-3. Defaults to medium (2 of 3). */
  radius?: BlastRadius;
}

/**
 * The release check (06 §5.7): blocked when any test replay task regresses, or test capability
 * falls by more than one task-mean on either model, in either mode.
 */
export function releasePolicy(input: ReleasePolicyInput): {
  decision: 'pass' | 'blocked' | 'invalid';
  results: GateResult[];
  reasons: PolicyReason[];
} {
  const runs = input.runs ?? DEFAULT_RUNS;
  const radius = input.radius ?? 'medium';
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
        seed: 'release-check',
        runs,
        resamples: DEFAULT_RESAMPLES,
        computeP: false,
      });
      // §5.7 has no flaky-baseline rule; only regressions block.
      const safety = replaySafety(c, radius, new Set());
      const fails = safety.reasons.filter((r) => r.code === 'replay-regression');
      if (!noWorseThanOneTaskMean(c)) {
        fails.push({
          code: capabilityLabel(mode),
          severity: 'fail',
          model,
          mode,
          detail: `Δ ${c.diffUnits} passes over ${c.objective.length} tasks × ${runs} runs`,
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
        capability: { before: c.before, after: c.after, delta: c.after - c.before, pValue: null },
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
