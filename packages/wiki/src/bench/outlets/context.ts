import type { TaskSpec } from '../../schema/bench';
import type { AssertionSpec } from './assertion';
import type { LoadedRepro, ReproRun } from './repro';
import type { CheckAllResult, OutletTreeRef } from './types';

export interface OutletContext {
  /** The harness's own checkout: the trusted repros (`bench/repro/`), the CLI that runs verify. */
  repoRoot: string;
  proposalId: string;
  /** mechanism / doctor: the commit the repro must fail on, and the candidate it must pass on. */
  base: OutletTreeRef;
  candidate: OutletTreeRef;
  /** The bench task specs. Reserved for the outlet regression guards of 06 §5.6 (same-class
   * replay tasks), which need rollouts and are not run in M2. */
  tasks: readonly TaskSpec[];
  /** Injectable clock for the ledger event's `ts`. */
  now: () => Date;
  /** `owner/repo` for commit evidence refs (default `RTrentJones/greenlight`). */
  sourceRepo?: string;
  /** true for a control-arm proposal (06 §10.2): labelled in the event, never merged. */
  control?: boolean;
  /** The opened issue (`issue:o/r#n`), recorded as `change.ref` when known. */
  issueRef?: string;
  /** Pin one repro by id (`repro/<slug>`); default: every reviewed repro whose `outlets` include
   * the proposal's outlet and whose `patterns` intersect the proposal's. */
  repro?: string;
  /** verify outlet: the faulty artifact (a historical commit or mutant tree) and the fixed one,
   * and how to serve each (argv run in the artifact tree with `PORT` set). */
  artifacts?: {
    faulty: OutletTreeRef;
    fixed: OutletTreeRef;
    serve: { command: string[]; readyPath?: string; readyTimeoutMs?: number };
  };
  /** verify outlet: a JSON file holding the assertion, instead of a block in the issue body. */
  assertionFile?: string;
  /** Installs a tree's dependencies from its (base) lockfile: a checked-out base commit, and the
   * evaluated tree (default: `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
   * --ignore-pnpmfile --config.registry=<DEFAULT_REGISTRY>`, in `installEnv()`: no secrets). Never
   * run on a given directory, and never on the candidate as it stands. */
  prepareTree?: (tree: string) => Promise<void>;
  /** The framework suite on the evaluated tree (default: `runSandboxedCheckAll`, the HARNESS
   * tree's `check-all` commands inside the docker sandbox; `unavailable` when there is no
   * sandbox, which makes the evaluation `invalid`). Tests inject it. */
  checkAll?: (tree: string) => Promise<CheckAllResult>;
  /** One trusted repro against a tree (default: `runSandboxedRepro`, in the docker sandbox;
   * `unavailable` without one, which makes the evaluation `invalid`). Tests inject it. */
  runRepro?: (repro: LoadedRepro, tree: string) => Promise<ReproRun>;
  /** verify outlet: runs the assertion against one served artifact (default: the harness CLI's
   * `greenlight verify --url <served> --spec <assertion>`). */
  runAssertion?: (
    spec: AssertionSpec,
    artifact: { dir: string; url: string },
  ) => Promise<{ passed: boolean; detail?: string }>;
}
