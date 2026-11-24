import type { BundleContext } from '../../bundle';
import type { LintContext } from '../../lint';
import type { GateInputRecord, GateResult, LedgerEvent, ProposerOutput } from '../../schema';
import type { ControlOutcome, GateDecision, decide } from '../gate';
import type {
  ControlArm,
  OutletContext,
  OutletResult,
  OutletTreeRef,
  evaluateOutlet as defaultEvaluateOutlet,
} from '../outlets';
import type { BlastRadius, PolicyReason } from '../policy';
import type { BenchRunOptions, QuotaStore, RunnerAssets, SandboxKind } from '../runner';

export const ITERATION_STEPS = [
  'train',
  'maintainer',
  'baseline',
  'proposer',
  'evaluate',
  'control',
  'record',
  'handoff',
] as const;
export type IterationStep = (typeof ITERATION_STEPS)[number];

export type StepStatus =
  | 'pending'
  | 'deferred'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'skipped'
  /** maintainer / proposer only: the bundle is written and an external agent's output is awaited. */
  | 'awaiting-external';
export type IterationStatus =
  | 'running'
  | 'deferred'
  | 'blocked'
  | 'failed'
  | 'complete'
  /** Stopped at a step whose role is external: a human or an agent must act (exit 5). */
  | 'awaiting-agent';

export type ExternalRole = 'maintainer' | 'proposer';

/** A submitted output file is untrusted input: at most this many bytes, JSON only. */
export const MAX_SUBMISSION_BYTES = 1024 * 1024;
/** Submissions an external agent has per bundle, as `runReact`'s `maxFinishAttempts` (06 §2.4). */
export const MAX_SUBMISSIONS = 3;
/** `--agent`: who produced a submitted output, e.g. `claude-code/claude-sonnet-5-5`. One token,
 * since it is written into `log.md` as the entry's actor. */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;

/** What an external role's state carries on top of the harness role's. */
interface ExternalRoleState {
  /** Who does the role in this iteration; absent in a state written before external roles. */
  source?: 'harness' | 'external';
  /** `--agent` of the accepted submission (in place of the model id a harness role records). */
  agent?: string;
  /** Submissions refused for the current bundle; `MAX_SUBMISSIONS` fail it. */
  submissions?: number;
  /** The issues of the last refused submission. */
  issues?: string[];
}

/** The default step caps for the two LLM roles: each needs its whole cap (steps + 2) left in the
 * model's day before it starts, so both fit one free-tier day (20 RPD) on their own. */
export const DEFAULT_AGENT_MAX_STEPS = { maintainer: 12, proposer: 16 } as const;

export interface EvalStep {
  status: StepStatus;
  message?: string;
  evaluationId?: string;
  record?: string;
  remaining?: Record<string, string[]>;
}

/** What a decision needs to be shown and recorded; the sealed event is appended at `record`. */
export interface DecisionSummary {
  decision: GateDecision['decision'];
  path: GateDecision['path'];
  reasons: PolicyReason[];
  results: GateResult[];
  /** The decision algorithm (06 §5.2). Absent in a state written before the exact test. */
  algorithm?: number;
  baselineRecords: string[];
  candidateRecords: string[];
}

export interface CandidateState extends EvalStep {
  proposalId: string;
  skill: string;
  /** The decision timestamp, fixed once so a resumed decision reproduces byte for byte. */
  ts?: string;
  /** The scratch skill set the candidate rollouts ran under (inside the iteration directory). */
  candidateSkills?: string;
  candidateSkillSetHash?: string;
  radius?: BlastRadius;
  /** The decision's own status, apart from the evaluation's (`record` set = sealed): a failed
   * decision is retried from the sealed record on resume, without a rollout. */
  decisionStatus?: StepStatus;
  decision?: DecisionSummary;
  gateInput?: GateInputRecord;
  event?: LedgerEvent;
}

export interface ControlState extends CandidateState {
  /** The control file, relative to the bench directory. */
  file: string;
  controlId: string;
  proposal: ProposerOutput;
  /** The rejection the control must earn (`ControlArm.expect`). */
  expect: ControlArm['expect'];
  /** True when the decision is `rejectedForReplayRegression(decision, expect.task)`. */
  expectMet?: boolean;
  /** `controlOutcome(decision, expect.task)`: `inconclusive` when the gate could not have
   * rejected for the expected regression (06 §10.3), which is not a failed control. */
  outcome?: ControlOutcome;
  /** Val replay tasks the control was rejected for (`rejectedForReplayRegression`). */
  replayRegressions?: string[];
}

export interface IterationState {
  v: 1;
  iterationId: string;
  createdAt: string;
  updatedAt: string;
  status: IterationStatus;
  /** The step the iteration stopped at (or `handoff` when complete). */
  step: IterationStep;
  message?: string;
  /** Fixed at creation: resuming uses these, whatever the caller passes. */
  settings: {
    scope: string;
    sandbox: SandboxKind;
    models?: string[];
    runs?: number;
    maxSteps?: number;
    rolloutRequestCap?: number;
    /** External rollouts (06 §4.9): the declared agent id every evaluation of the iteration
     * runs under (`identity.agent.version`), so its records stay comparable. */
    rolloutAgent?: string;
    agentMaxSteps: { maintainer: number; proposer: number };
    incidents: string[];
    /** The controls directory, relative to the bench directory. */
    controlsDir: string;
    /** The owner's safety-fix targets (06 §5.4), sorted; absent on a standard-path iteration. */
    safetyFixTargets?: string[];
  };
  /** The accepted skill set (06 §1.5) every baseline and train record must carry. */
  acceptedSkillSetHash: string;
  /** What the iteration was created against; every resume refuses (exit 4) when one differs. */
  pins?: IterationPins;
  /** The checkout's HEAD commit at creation. scripts/evo-restore.mjs restores a wiki page the
   * iteration wrote only while the checkout's copy still equals the copy at this commit (a page
   * a human committed since is never reverted). */
  baseCommit?: string;
  notes: string[];
  train: EvalStep;
  maintainer: ExternalRoleState & {
    status: StepStatus;
    message?: string;
    attempts: number;
    bundleId?: string;
    bundleDir?: string;
    /** The validated MaintainerOutput, stored before it is applied. */
    outputFile?: string;
    /** Files the output writes, with the sha256 of their content: applying is idempotent. */
    writes?: { path: string; sha256: string }[];
    applied?: boolean;
    indexCorrections?: string[];
    rawIds?: string[];
    model?: string;
  };
  baseline: EvalStep & { earlyStop?: boolean };
  proposer: ExternalRoleState & {
    status: StepStatus;
    message?: string;
    attempts: number;
    bundleId?: string;
    bundleDir?: string;
    proposalId?: string;
    proposal?: ProposerOutput;
    rawReads?: string[];
    model?: string;
  };
  evaluate: {
    status: StepStatus;
    message?: string;
    kind?: 'skill' | 'outlet' | 'no-action' | 'early-stop';
    candidate?: CandidateState;
    outlet?: {
      ts: string;
      /** The trees the outlet rule judges, pinned on first entry (a resume never re-resolves a
       * moving ref such as HEAD, and refuses a different --candidate). */
      base?: PinnedTree;
      candidate?: PinnedTree;
      result?: {
        decision: OutletResult['decision'];
        reasons: string[];
        evidence: OutletResult['evidence'];
      };
    };
    event?: LedgerEvent;
  };
  control: { status: StepStatus; message?: string; items: ControlState[] };
  record: { status: StepStatus; message?: string; eventIds?: string[] };
  handoff: { status: StepStatus; message?: string; file?: string };
  review?: {
    decision: 'accept' | 'reject';
    reason: string;
    ts: string;
    eventIds: string[];
    by?: string;
  };
  /** A review whose events are computed and saved before they are appended: a retry after a
   * crash appends the same events (same eventIds) instead of new ones. */
  reviewPending?: {
    decision: 'accept' | 'reject';
    reason: string;
    ts: string;
    events: LedgerEvent[];
    by?: string;
  };
}

/** Hashes of the inputs an iteration's evidence depends on (06 §1.5), fixed at creation. */
export interface IterationPins {
  skillSet: string;
  models: string;
  gate: string;
  splits: string;
  tasks: string;
  /** `bench/controls/**`: the control arms and the rejections they must earn. */
  controls: string;
  /** `bench/repro/**`: the trusted repros the mechanism / doctor outlets are judged by. */
  repro: string;
}

/** An outlet tree, resolved once: `key` names what it resolved to (a commit sha, a clean HEAD). */
export interface PinnedTree {
  tree: OutletTreeRef;
  key: string;
}

export interface IterateOptions {
  repoRoot: string;
  benchDir: string;
  /** The accepted (installed) skills. Never written: candidates run from scratch copies. */
  skillsDir: string;
  wikiRoot: string;
  /** `.greenlight/` (default `<repoRoot>/.greenlight`). */
  stateDir?: string;
  /** Lane templates (`tools`), for a template proposal's paths. */
  templatesDir?: string;
  /** `all` (default) or one managed skill. */
  scope?: string;
  resume?: string;
  /** `--safety-fix <replay task>[,…]` (06 §5.4): the OWNER's choice to gate this iteration's
   * skill proposal on the safety-fix path, naming the val replay tasks that fail in the baseline
   * and that the proposal must fix. Fixed at creation; the control arm stays on the standard
   * path. */
  safetyFixTargets?: string[];
  sandbox: SandboxKind;
  assets: RunnerAssets;
  /** Gate models (default both) and val runs (default `bench/gate.json`). */
  models?: string[];
  runs?: number;
  maxSteps?: number;
  rolloutRequestCap?: number;
  agentMaxSteps?: Partial<{ maintainer: number; proposer: number }>;
  /** Incident pages for the maintainer bundle (default: every incident page of the wiki). */
  incidents?: string[];
  /** Default `<bench>/controls`. */
  controlsDir?: string;
  /** `context.json` of the maintainer bundle (the CLI passes the installed version and cells). */
  context?: BundleContext;
  /** Lint context for the maintainer's scratch wiki (default: the framework wiki, no seam terms). */
  lint?: Pick<LintContext, 'kind' | 'seam' | 'secretValues'>;
  /** The gate (default gate.ts `decide`); injectable so a failed decision can be tested. */
  decide?: typeof decide;
  /** The non-skill outlet evaluator (default outlets.ts `evaluateOutlet`). */
  evaluateOutlet?: typeof defaultEvaluateOutlet;
  /** mechanism / doctor: the base tree (default: the checkout's HEAD commit). */
  outletBase?: OutletTreeRef;
  /** mechanism / doctor / verify: the candidate change the outlet rule judges. Without it only
   * an `invalid` verdict is taken; a decision waits for it (the step is blocked). */
  outletCandidate?: OutletTreeRef;
  /** Further OutletContext fields (artifacts, repro pin, injected prepareTree/checkAll…). */
  outletContext?: Partial<OutletContext>;
  /** Fixed id for a new iteration (tests). */
  iterationId?: string;
  /** `--adopt-pins`: a resumed state missing a pin adopts the current input (logged); without it
   * the resume is refused (exit 4). */
  adoptPins?: boolean;
  /** `--break-lock`: remove a lock written on another host (which cannot be checked here). */
  breakLock?: boolean;
  /** `--maintainer-output <file>`: an external agent's MaintainerOutput JSON (absolute path).
   * Only with `resume` and `agent`, and only while the maintainer step is `awaiting-external`. */
  maintainerOutput?: string;
  /** `--proposal <file>`: an external agent's ProposerOutput JSON (absolute path); as above. */
  proposal?: string;
  /** `--agent <id>`: who produced the submitted file (`AGENT_ID_RE`). */
  agent?: string;
  /** `--rollout-agent <id>`: external rollouts (06 §4.9), when the gate models are external in
   * bench/models.json: the declared id of the agent that drives them. Fixed at creation. While a
   * rollout step runs, `iterate` itself is the rollout server: it blocks, and the launcher
   * dispatches agents from the manifest. */
  rolloutAgent?: string;
  /** External rollouts: the manifest file (rewritten by every rollout step). */
  rolloutManifest?: string;
  rolloutConcurrency?: number;
  rolloutClaimTimeoutMs?: number;
  externalTimeoutFactor?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  throttle?: BenchRunOptions['throttle'];
  quotaStore?: QuotaStore;
  skipModelsCheck?: boolean;
  rolloutTimeoutMs?: number;
  dockerBin?: string;
  log?: (s: string) => void;
  /** Called as each step starts. */
  onStep?: (step: IterationStep) => void;
}

export interface IterateResult {
  status: IterationStatus | 'usage' | 'refused';
  iterationId?: string;
  step?: IterationStep;
  message: string;
  state?: IterationState;
  /** On a rollout deferral: the rollout keys left per model. */
  remaining?: Record<string, string[]>;
  /** On `awaiting-agent`: what the external agent needs. `bundle` is inside the iteration
   * directory; `command` hands the output back. */
  awaiting?: {
    role: ExternalRole;
    bundle: string;
    skill: string;
    command: string;
    /** Refused submissions for this bundle, of `MAX_SUBMISSIONS`. */
    submissions: number;
  };
  /** The issues of a submission refused in THIS invocation (it counted as one attempt). */
  issues?: string[];
  /** 07 §0: 0 complete, 1 deferred/blocked/failed, 2 usage, 3 missing prerequisite, 4 policy,
   * 5 awaiting an external agent (a human or an agent must act; nothing failed). */
  exitCode: 0 | 1 | 2 | 3 | 4 | 5;
}

export class IterationError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4 = 1,
  ) {
    super(message);
    this.name = 'IterationError';
  }
}
