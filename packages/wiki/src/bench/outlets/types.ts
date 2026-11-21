import type { z } from 'zod';
import type { EvidenceSchema, LedgerEvent } from '../../schema/ledger';

export type Evidence = z.infer<typeof EvidenceSchema>;

/** A tree to evaluate: a commit of `ctx.repoRoot` (checked out with `git worktree add`, removed
 * afterwards), or an existing directory used as is. Host git never runs inside a directory: one
 * with its own `.git` is refused (name the commit instead), and a directory needs an explicit,
 * non-`commit:` evidence `ref` (a `commit:` ref cannot be checked without git) — else it cannot be
 * recomputed, so evaluating it is `invalid` (`unpinned-tree`). `hash` (`treeContentHash`, set by
 * the iteration's pin) must still match the directory's contents. */
export type OutletTreeRef = { commit: string } | { dir: string; ref?: string; hash?: string };

export interface CheckAllResult {
  ok: boolean;
  detail?: string;
  /** No sandbox could run the suite (no docker, no runner image): neither a pass nor a fail. */
  unavailable?: boolean;
  /** The tree changed under a command (`treeSnapshot` drift): the run proves nothing. */
  mutated?: string;
}

export type OutletDecision = 'accept' | 'reject' | 'invalid';
export interface OutletReason {
  code: (typeof OUTLET_REASON_CODES)[number];
  detail?: string;
}

/** accept / reject carry evidence and a sealed `candidate-*` event; `invalid` never reaches the
 * ledger (as `GateDecision.ledgerEvent` is null when invalid), and has evidence only when both
 * trees were pinned. */
export type OutletResult = (
  | {
      decision: 'accept' | 'reject';
      reasons: OutletReason[];
      evidence: Evidence;
      ledgerEvent: LedgerEvent;
    }
  | { decision: 'invalid'; reasons: OutletReason[]; evidence: Evidence | null; ledgerEvent: null }
) & {
  /** For the owner's hand-off, never a verdict: suppression markers the candidate's diff adds
   * (`suppressionNotes`: biome-ignore, @ts-nocheck, @ts-ignore, eslint-disable, .skip, .only). */
  notes?: string[];
};

export const OUTLET_REASON_CODES = [
  // accept
  'repro-fails-on-base',
  'repro-passes-on-candidate',
  'check-all-passed',
  'assertion-fails-on-faulty',
  'assertion-passes-on-fixed',
  // reject
  'repro-fails-on-candidate',
  'check-all-failed',
  'assertion-passes-on-faulty',
  'assertion-fails-on-fixed',
  // invalid
  'template-outlet-not-in-M2',
  'unsupported-outlet',
  'no-trusted-repro',
  'repro-unreviewed',
  'repro-passes-on-base',
  'repro-error',
  'unpinned-tree',
  'checkout-failed',
  'no-artifacts',
  'no-assertion',
  'assertion-invalid',
  'assertion-error',
  'candidate-touches-harness-config',
  'candidate-unsafe-tree',
  'candidate-mutated-tree',
  'no-sandbox',
] as const;
