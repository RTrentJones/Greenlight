/**
 * Outlet evaluation for the outlets a human applies (vision 06 §3.5, §5.6; roadmap M2-02). The
 * skill outlet goes through the gate (gate.ts); everything else comes here:
 *
 * - **mechanism / doctor**: a `repro` grader (06 §4.6). A trusted reproduction, a fixture plus a
 *   script reviewed by a human, lives at `bench/repro/<slug>/{repro.json,run.mjs}` in the
 *   harness's own tree (`ctx.repoRoot`), never in the candidate, so a candidate cannot rewrite the
 *   test it is judged by. It runs against the base and the candidate trees. Accept iff it fails on
 *   base, passes on the candidate, and the harness's `check-all` commands pass on the candidate.
 *   The candidate is never run as it stands: the evaluated tree is a fresh copy of the BASE with
 *   the candidate's diff overlaid (`buildEvaluatedTree`), and a diff that touches the harness's
 *   own configuration (`HARNESS_CONFIG_PATHS`: any package.json or .gitignore, the lockfile and
 *   workspace, .npmrc/.pnpmfile, turbo/vitest/biome/tsconfig/depcruise configs, `scripts/`,
 *   `.github/`, `bench/`) is `invalid` (`candidate-touches-harness-config`). Dependencies come
 *   from the base lockfile only (`--frozen-lockfile --ignore-scripts --ignore-pnpmfile`, registry
 *   pinned); a candidate's `node_modules`, `.git`, `.turbo` and `*.tsbuildinfo` are never copied.
 * - **Every process that runs tree code runs in the docker sandbox**, the repro included
 *   (`runSandboxedRepro`, `runSandboxedCheckAll`): uid 10000, read-only root, `--network none`,
 *   no capabilities, `no-new-privileges`, pid/memory/cpu limits, no harness environment. The
 *   evaluated tree is mounted READ-ONLY at its host path; the only writable places are fresh
 *   tmpfs mounts per container (`/tmp`, HOME, and the declared outputs `checkOutputDirs`: each
 *   workspace package's `.turbo`, the root `.vitest-tmp/` and `node_modules/.vite`), so every
 *   command and every repro starts from the pristine tree and nothing a step writes reaches a
 *   later one. The repro script is mounted read-only from the HARNESS tree; its verdict is the
 *   container's exit code, never a file. The tree is re-hashed (`treeSnapshot`) before and after
 *   every repro and after every check-all command: any drift is `invalid`
 *   (`candidate-mutated-tree`). Without docker the outlet is `invalid` (`no-sandbox`): candidate
 *   code never runs unsandboxed.
 * - Trees: a `{commit}` is resolved in the HARNESS repository and checked out with
 *   `git worktree add` (host git with `safeGitEnv` and `-c core.fsmonitor= -c core.hooksPath=/dev/null`).
 *   Host git never runs inside a `{dir}`: a directory with its own `.git` is refused (name its
 *   commit), and a directory is pinned by its content hash (`treeContentHash`) plus a named,
 *   non-commit evidence ref.
 * - **verify**: an artifact check. The proposed assertion (a JSON `api` verify check in the issue
 *   body, or `ctx.assertionFile`) must fail against the faulty artifact and pass on the fixed one.
 * - **template**: not in M2 (it waits for M4); always `invalid`.
 *
 * `invalid` is never a result for the ledger, as at the gate (06 §4.8): the evaluation could not
 * show anything either way, so it carries no ledger event. Accept and reject carry a sealed
 * `candidate-accepted` / `candidate-rejected` event with `repro` or `artifact` evidence (08 §8).
 *
 * Proposer text is data, never code: the issue body contributes only a JSON assertion, which is
 * validated and restricted to `api` checks (no `test` mode, no `logsOnFailure` command).
 */

export {
  type OutletTreeRef,
  type CheckAllResult,
  type OutletDecision,
  type OutletReason,
  type OutletResult,
  OUTLET_REASON_CODES,
} from './outlets/types';
export type { OutletContext } from './outlets/context';
export {
  ReproSpecSchema,
  type ReproSpec,
  type LoadedRepro,
  loadRepros,
  type ReproVerdict,
  type ReproRun,
  runSandboxedRepro,
} from './outlets/repro';
export { type AssertionSpec, extractAssertion, parseAssertion } from './outlets/assertion';
export { evaluateOutlet } from './outlets/evaluate';
export { treeContentHash, installEnv, DEFAULT_REGISTRY } from './outlets/trees';
export { safeGitEnv, SAFE_GIT_ARGS, safeGit } from './outlets/git';
export {
  HARNESS_CONFIG_PATHS,
  type TreeEntry,
  listTreeEntries,
  candidateDiff,
  harnessConfigTouches,
  SUPPRESSION_MARKERS,
  suppressionNotes,
  buildEvaluatedTree,
  checkAllCommands,
  type SandboxOptions,
  type SandboxedCheckAllOptions,
} from './outlets/evaluated-tree';
export {
  workspacePackages,
  checkOutputDirs,
  type TreeSnapshot,
  treeSnapshot,
  snapshotDrift,
  runSandboxedCheckAll,
} from './outlets/sandbox';
export { ControlArmSchema, type ControlArm, loadControlArm } from './outlets/control';
