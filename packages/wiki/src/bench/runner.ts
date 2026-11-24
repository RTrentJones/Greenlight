/**
 * `greenlight bench run` (vision 06 §1.3–§1.5, §4.2, §4.8, §9; 08 §5, §8, §10; roadmap M1-05/06).
 *
 * One evaluation = the selected tasks × models × runs in one mode, under one BaselineIdentity:
 * 1. resolve the selection, compute the identity (identity.ts), and for a train run reuse a
 *    sealed train EvaluationRecord with the identical identity unless `force` (06 §1.5);
 * 2. refuse BEFORE any request when the budget (bench/budget.json, `checkBudget`) or the model
 *    check (`checkModels`) says no;
 * 3. run each rollout: a fresh sandbox (sandbox.ts) holding the fixture and the skills, the ReAct
 *    loop on the host (the model key never enters the sandbox), every tool call executed inside,
 *    the shim channel (shims.ts) recording commands; then kill every agent process, export the
 *    final tree, remove the sandbox, and grade in a separate container (grade.ts);
 * 4. write one `bench` RawRecord per rollout (`.greenlight/raw/`), a `spend` ledger event per model
 *    per invocation, and — once every rollout has an outcome — the sealed EvaluationRecord under
 *    `<wiki>/evidence/eval/<hash>.json`.
 *
 * Quota is scheduled per model (06 §4.8): before each rollout the runner checks that the model's
 * remaining daily quota covers the rollout's request cap (`harness.limits.requestsPerRollout`,
 * plus the eval judge's call on the judge model) and otherwise skips that model for today; it
 * always runs next the model with the most quota left, so the models interleave. A rollout that
 * is deferred anyway (the model stayed unavailable with fallback off, or another process spent
 * the quota) defers ONLY its model; the others keep running. Progress persists at
 * `.greenlight/bench/runs/<evaluationId>/progress.json` and the run returns `deferred` with the
 * keys left per model; `resume` continues it later under an identical identity (a changed
 * identity, the limits included, is refused). A rollout refused by the redaction guard, a harness
 * error and a model error produce NO outcome: the evaluation stays unsealed (invalid), never a
 * fake 0. A trajectory that is incomplete (an origin ref moved with no recorded command, a lost or
 * truncated shim event) is an outcome with `graderError`: invalid at the gate, never a pass.
 *
 * External rollouts (06 §4.9): when the selected models are `external` in bench/models.json, step
 * 3's ReAct loop is replaced by an agent launched from outside the harness. The runner opens up to
 * `concurrency` sandboxes at once, serves each through the rollout server (external.ts) and writes
 * a manifest for the launcher; the agent drives the SAME tools through the rollout client, and
 * everything after the agent's last step (kill, export, grading, raw record, sealing) is the same
 * code. No model client, no quota and no spend event exist for an external model; the identity
 * carries `agent.vendor: external` and the declared agent id as `agent.version`.
 */

export {
  ROLLOUT_RETRY_DELAYS_MS,
  type RunnerAssets,
  type EvalRole,
  type SandboxKind,
  type BenchRunOptions,
  type RunStatus,
  type RolloutSummary,
  type RunResult,
  type QuotaStore,
  REQUESTS_PER_ROLLOUT,
  DEFAULT_MAX_STEPS,
  ANNOUNCE_REMAINING_STEPS,
  rolloutRequestCap,
} from './runner/types';
export { globToRegExp, resolveModels, UsageError, normalizeModelId } from './runner/selection';
export { readGateConfigFile, PrerequisiteError } from './runner/config';
export { ProgressSchema, type Progress, progressPath, sealedRecordFor } from './runner/progress';
export { loadEvaluationRecords, findCachedTrain, findCachedRecord } from './runner/records';
export { AGENT_ROLE_PROMPT, budgetNote, sliceLines, maintainerFinish } from './runner/tools';
export { MissingSkillError, loadSkillsFor } from './runner/skills';
export {
  fixtureAwareDetector,
  flaggedLeaves,
  REDACTED_ARTIFACTS,
  redactArtifacts,
} from './runner/redact';
export { JUDGE_RESPONSE_SCHEMA, maintainerPrompt } from './runner/finish';
export { runBench } from './runner/driver';
export { activateTasks } from './runner/activate';
