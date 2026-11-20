import type { DailyUsage, RateLimitPersistence } from '../../llm/limits';
import type { BaselineIdentity, EvaluationRecord, TaskSpec } from '../../schema/bench';

/** Backoff for transient model errors (429/5xx) inside a rollout. Free-tier demand spikes
 * last minutes, and a rollout cannot resume part-way, so the client's default (~10 s in total)
 * throws away a rollout's spent requests on the first spike. Three retries reaching ~1 minute
 * in total keep a rollout well inside the shortest task timeout (10 min). Part of the
 * runner's behaviour, so it is covered by RUNNER_VERSION in the identity. */
export const ROLLOUT_RETRY_DELAYS_MS: readonly number[] = [4_000, 15_000, 45_000];

export interface RunnerAssets {
  /** Directory of the built CLI (`greenlight.mjs` + `node_modules/`), mounted read-only. */
  cliDir: string;
  /** hashTree(cliDir): part of `depsHash`. */
  cliBuildHash: string;
  greenlightVersion: string;
  /** The grading bundle (`bench-grade.mjs`). */
  gradeBundle: string;
  /** The bench runner's lockfile (`pnpm-lock.yaml`). */
  lockfile: string;
}

export type EvalRole = 'train' | 'baseline' | 'candidate';
export type SandboxKind = 'docker' | 'process';
export type Split = TaskSpec['split'];

export interface BenchRunOptions {
  repoRoot: string;
  benchDir: string;
  skillsDir: string;
  /** Wiki root (ledger + evidence/eval). */
  wikiRoot: string;
  /** Holds `raw/`, `bench/runs/`, `quota/` (default `<repoRoot>/.greenlight`). */
  stateDir?: string;
  /** Called once the evaluation's progress file exists, before any rollout runs, so a caller can
   * record the id durably: a process killed mid-evaluation then resumes it instead of starting a
   * fresh one and discarding the finished rollouts. */
  onEvaluationStarted?: (evaluationId: string) => void;
  runnerDir?: string;
  split?: Split;
  /** Globs over task ids (`*` within a segment, `**` across). */
  tasks?: string[];
  /** Role names (`frontier`, `small`) or model ids. Default both. */
  models?: string[];
  runs?: number;
  mode?: 'isolation';
  role?: EvalRole;
  proposalId?: string;
  sandbox: SandboxKind;
  resume?: string;
  force?: boolean;
  /** A baseline evaluation reuses a sealed baseline record of exactly this identity (the accepted
   * skill set's R_best, 06 §5.1 step 1) that covers every requested rollout and is at most this
   * many days old (`bench/gate.json` `maxBaselineAgeDays`). Unset: a baseline always runs. */
  reuseBaselineMaxAgeDays?: number;
  /** Max ReAct steps per rollout (default {@link DEFAULT_MAX_STEPS}; on resume, the evaluation's). */
  maxSteps?: number;
  /** Hard cap on LLM requests per rollout, retries included (default `maxSteps + 2`). Part of the
   * identity, and what the per-model quota check reserves before a rollout starts. */
  rolloutRequestCap?: number;
  /** Hard cap on LLM requests for this invocation (also capped by `perGateMaxRequests`). */
  maxRequests?: number;
  /** For the budget estimate (bench/README-models.md: 12). */
  requestsPerRollout?: number;
  /** The daily quota store (default: `FileQuotaStore` under `<stateDir>/..`); tests inject one. */
  quotaStore?: QuotaStore;
  assets: RunnerAssets;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** The free-tier rpm throttle's clock (tests pass a fake one). */
  throttle?: { now: () => number; sleep: (ms: number) => Promise<void> };
  skipModelsCheck?: boolean;
  /** Overrides each task's `timeoutMin` (tests). */
  rolloutTimeoutMs?: number;
  dockerBin?: string;
  log?: (s: string) => void;
  /** `external`: the rollouts are driven by an outside agent (06 §4.9). Unset: decided by the
   * selected models (external in bench/models.json or not); set, it must agree with them. */
  agentMode?: 'harness' | 'external';
  /** External rollouts: the declared agent id (who drives them, e.g. `claude-code/<model>`).
   * Recorded as the identity's `agent.version`; on resume, the evaluation's own by default. */
  agent?: string;
  /** External rollouts: the manifest file a launcher polls (default: next to the client). */
  manifest?: string;
  /** External rollouts: where the client is written (default: a fresh directory under the
   * system temp dir, outside the repository). */
  externalDir?: string;
  /** External rollouts: sandboxes open at once (default 4). */
  concurrency?: number;
  /** External rollouts: an open rollout nobody claims within this is deferred (default 10 min). */
  claimTimeoutMs?: number;
  /** External rollouts: the wall clock is the rollout timeout times this (default 3). Part of
   * `harness.limits`. */
  externalTimeoutFactor?: number;
}

export type RunStatus =
  | 'complete'
  | 'cached'
  | 'deferred'
  | 'incomplete'
  | 'refused'
  | 'budget-refused'
  | 'models-unavailable'
  | 'policy-refused'
  | 'usage';

export interface RolloutSummary {
  task: string;
  model: string;
  run: number;
  rawId: string;
  status: 'graded' | 'deferred' | 'refused' | 'error';
  score?: 0 | 1;
  reason?: string;
  requests: number;
  killedProcesses?: number;
}

export interface RunResult {
  status: RunStatus;
  message: string;
  evaluationId?: string;
  identity?: BaselineIdentity;
  record?: EvaluationRecord;
  recordPath?: string;
  rollouts: RolloutSummary[];
  /** Requests made by this invocation. */
  requests: number;
  /** On `deferred`: the rollout keys (`task|model|run`) still to run, per model. */
  remaining?: Record<string, string[]>;
  /** On `deferred`: why each deferred model stopped (quota, unavailable, request cap). */
  deferredModels?: Record<string, string>;
  /** External rollouts: the manifest the invocation wrote. */
  manifest?: string;
}

/** The daily quota persistence the runner reads remaining quota from and seeds from the ledger. */
export interface QuotaStore extends RateLimitPersistence {
  /** Raises today's count to at least `count` (never lowers it). */
  raise(modelId: string, day: string, count: number): DailyUsage;
}

export const ROLLOUT_KEY = (t: string, m: string, r: number) => `${t}|${m}|${r}`;

export const REQUESTS_PER_ROLLOUT = 12;
/** 25: reading the first sealed baselines showed 15 steps too tight for the replay tasks (most
 * rollouts spent 6–10 of them exploring), as 10 had been before (bench/README-models.md). */
export const DEFAULT_MAX_STEPS = 25;
/** From this many steps left, every tool response says how many remain (06 §4.8). */
export const ANNOUNCE_REMAINING_STEPS = 5;
/** The per-rollout request cap for `maxSteps`: one request per step plus two retries' headroom. */
export const rolloutRequestCap = (maxSteps: number): number => maxSteps + 2;
