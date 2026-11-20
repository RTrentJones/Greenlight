/**
 * `greenlight bench iterate` (vision 06 §1.3 steps 1–5, §10; roadmap M2-01, M2-04): one complete
 * WikiSkill iteration as a RESUMABLE STATE MACHINE. On the Gemini free tier one iteration spans
 * many days (06 §4.8: about one rollout per model per day), so every step persists its progress in
 * `.greenlight/bench/iterations/<iterationId>/state.json` before and after it acts, and a later
 * `--resume <iterationId>` continues at the first unfinished step. Steps, in order:
 *
 * 1. `train`      — training evidence under the accepted skill set: the sealed train
 *                    EvaluationRecord with this identity, else `bench run --split train` (resumed
 *                    across days).
 * 2. `maintainer` — the maintainer bundle (train records + field raw, ≤5 failing / ≤3 passing, the
 *                    incidents), the §2.2 prompt through `runReact`, `finish(MaintainerOutput)`
 *                    validated by `applyMaintainerOutput` + lint (rejections are fed back, three
 *                    submissions), applied atomically, log appended.
 * 3. `baseline`   — `bench run --split val --role baseline` under the accepted skill set (a sealed
 *                    baseline of the same identity, at most `maxBaselineAgeDays` old, is reused);
 *                    then the early stop (06 §1.3).
 * 4. `proposer`   — the proposer bundle, the §3.3 prompt with read-only tools (`read_file` over the
 *                    bundle; `wiki_read` / `wiki_traces` through the access-logged interface), and
 *                    `finish(ProposerOutput)` validated by `checkProposal` (≥4 logged raw reads).
 * 5. `evaluate`   — by outlet (06 §5.6): a skill patch is applied to a SCRATCH copy of the skill
 *                    set (never the repo's skills), `bench run --split val --role candidate` with it,
 *                    then `decide()`; every other outlet goes to `evaluateOutlet` (outlets.ts).
 * 6. `control`    — every `bench/controls/*.json` is evaluated exactly like a skill candidate and
 *                    labelled `control: true` (06 §10.2 step 4).
 * 7. `record`     — the gate input records under `wiki/evidence/eval/`, the sealed ledger events
 *                    (06 §6.1), the log entries and a re-rendered `skill-impact.md`.
 * 8. `handoff`    — `handoff.md` / `handoff.json`: a PR for skill/template outlets, an issue for
 *                    mechanism/doctor/verify, a review note for `no_action` (M2-04). The CLI never
 *                    calls GitHub here; the orchestrator posts it.
 *
 * Every step is idempotent: a rollout step stores its evaluation id and resumes it; a model call
 * stores its validated output before applying it, and applying checks what is already on disk; a
 * ledger event is appended only when its eventId is not in the ledger yet. A quota deferral (a
 * model's day is spent or it stays unavailable) persists the step as `deferred` and returns exit 1
 * with what remains. `reviewIteration` records the owner's review (06 §0 condition 4).
 *
 * EXTERNAL ROLES (06 §2.5, §3.6). When `bench/models.json` sets `roles.maintainer` or
 * `roles.proposer` to `external`, that step makes no model call: it writes the same bundle, stores
 * the step as `awaiting-external`, and the iteration stops as `awaiting-agent` (exit 5) with the
 * bundle path and the exact command that hands the output back. The agent (anything that can read
 * the bundle and run the CLI) writes one JSON file; `--resume <id> --maintainer-output <file>` or
 * `--proposal <file>`, each with `--agent <id>`, feeds it through the SAME validation and
 * application as a harness-produced output. No quota is reserved, no spend event is written.
 */

export {
  ITERATION_STEPS,
  type IterationStep,
  type StepStatus,
  type IterationStatus,
  type ExternalRole,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSIONS,
  AGENT_ID_RE,
  DEFAULT_AGENT_MAX_STEPS,
  type DecisionSummary,
  type CandidateState,
  type ControlState,
  type IterationState,
  type IterationPins,
  type PinnedTree,
  type IterateOptions,
  type IterateResult,
  IterationError,
} from './iterate/types';
export {
  iterationDir,
  iterationStatePath,
  loadIterationState,
  awaitingIterations,
  processStart,
  acquireLock,
  iterationPins,
  assertOutsideSkills,
} from './iterate/state';
export {
  blastRadius,
  type RecordBinding,
  type IdentityExpectation,
  recordBindingProblem,
} from './iterate/context';
export { materializeCandidate, pinTree, loadControls, gatePathFor } from './iterate/evaluate';
export {
  type Handoff,
  iterationCost,
  buildHandoff,
  benchHeldOut,
  renderHandoffMarkdown,
  writeHandoff,
} from './iterate/handoff';
export { unrecordedMerge, resolveAcceptedSkillSet, iterate, planIteration } from './iterate/driver';
export { reviewIteration } from './iterate/review';
