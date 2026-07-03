import { execFileSync } from 'node:child_process';

/**
 * Promote = fast-forward `develop` → `main` after beta verify passes
 * (docs/archive/greenlight-v1.md §12). The guard enforces the divergence policy: a
 * fast-forward is only possible if `main` is an ancestor of `develop`. If `main`
 * has diverged (e.g. a direct hotfix), refuse with a reconcile instruction
 * rather than force-push.
 */
export interface PromoteCheck {
  canPromote: boolean;
  reason: string;
  /** The exact commit promotion will advance `to` to — resolved from `opts.commit` (the verified
   * sha) when given, else the from-branch tip. Set only when `canPromote` is true. */
  fromCommit?: string;
  /** Non-fatal advisories — e.g. a stale local branch that differs from its `origin/` ref. */
  warnings?: string[];
}

/** Pin promotion to a specific verified commit (E1): `commit` is the sha the beta verify ran
 * against. Without it, promote advances `to` to whatever the from-branch tip is AT PROMOTE TIME —
 * a push landing between "verify beta" and "promote" would fast-forward an unverified commit. */
export interface CanPromoteOptions {
  commit?: string;
}

export interface PromoteResult {
  promoted: boolean;
  from: string;
  to: string;
  reason: string;
  /** Non-fatal advisories carried up from the eligibility check (see PromoteCheck). */
  warnings?: string[];
}

function git(repoDir: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}

function gitOut(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

/** SHA of a ref, or null if it doesn't resolve. */
function tryRev(repoDir: string, ref: string): string | null {
  try {
    return gitOut(repoDir, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null;
  }
}

/** Refresh the remote-tracking refs for the branches in play so promotion reasons about the
 * *verified remote* state (what beta deployed + verified), not a stale local checkout. Best-effort,
 * but reports the outcome so the caller can WARN when an `origin` exists yet the fetch failed
 * (offline?) — vs. staying quiet for a purely-local repo with no `origin` to fetch. */
function fetchRefs(repoDir: string, branches: string[]): { ok: boolean; hasOrigin: boolean } {
  try {
    git(repoDir, ['remote', 'get-url', 'origin']); // throws if there is no `origin` remote
  } catch {
    return { ok: false, hasOrigin: false }; // local-only repo — nothing to refresh, not an error
  }
  try {
    git(repoDir, ['fetch', '--no-tags', 'origin', ...branches]);
    return { ok: true, hasOrigin: true };
  } catch {
    return { ok: false, hasOrigin: true }; // origin exists but the fetch failed (offline / auth?)
  }
}

/** Resolve a branch to a usable ref. Promotion advances the *remote* prod branch to the *verified
 * remote* develop, so prefer `origin/<branch>` (the state beta verified) and fall back to a local
 * branch only when the remote-tracking ref is absent (e.g. a purely local repo, or a non-default
 * branch a CI checkout never materialized). Preferring the local branch was a footgun: a stale
 * local `develop` (common after `git push origin HEAD:develop`, which never moves a local ref) would
 * silently promote an old commit and report success. Returns null if neither ref resolves. */
function resolveRef(repoDir: string, branch: string): string | null {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      git(repoDir, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Advisory: when a local branch exists AND differs from its `origin/` counterpart, the local one is
 * stale (or ahead). Promotion uses the origin (verified) state regardless — surface the gap so a
 * stale local `develop`/`main` never silently confuses (the old footgun reported a phantom success). */
function staleLocalWarnings(repoDir: string, branches: string[]): string[] {
  const warnings: string[] = [];
  for (const branch of branches) {
    const local = tryRev(repoDir, branch);
    const origin = tryRev(repoDir, `origin/${branch}`);
    if (local && origin && local !== origin) {
      warnings.push(
        `local "${branch}" (${local.slice(0, 7)}) differs from origin/${branch} (${origin.slice(0, 7)}) — ` +
          `promoting the origin (verified) state. Sync with \`git fetch && git branch -f ${branch} origin/${branch}\`.`,
      );
    }
  }
  return warnings;
}

export function canPromote(
  repoDir: string,
  from = 'develop',
  to = 'main',
  opts: CanPromoteOptions = {},
): PromoteCheck {
  // Reason about the verified *remote* state — refresh tracking refs before resolving (best-effort).
  const warnings: string[] = [];
  const fetched = fetchRefs(repoDir, [from, to]);
  if (fetched.hasOrigin && !fetched.ok) {
    warnings.push(
      'could not `git fetch origin` — eligibility may be based on stale remote-tracking refs (offline / auth?). Re-run after a successful fetch.',
    );
  }

  const fromRef = resolveRef(repoDir, from);
  const toRef = resolveRef(repoDir, to);
  if (!fromRef || !toRef) {
    return {
      canPromote: false,
      reason: `branch "${from}" or "${to}" not found in ${repoDir}`,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  warnings.push(...staleLocalWarnings(repoDir, [from, to]));

  // Resolve the exact commit promotion advances `to` to. With `opts.commit` (the sha the beta
  // verify ran against) the gate is IDENTITY-pinned: a push landing on `from` after verification
  // can no longer ride an unverified commit into prod — we promote the verified commit itself,
  // and the newer tip stays unpromoted until it verifies.
  let fromCommit: string;
  if (opts.commit) {
    const resolved = tryRev(repoDir, `${opts.commit}^{commit}`);
    if (!resolved) {
      return {
        canPromote: false,
        reason: `commit "${opts.commit}" not found in ${repoDir} — fetch first, or check the sha`,
        warnings,
      };
    }
    fromCommit = resolved;
    const tip = gitOut(repoDir, ['rev-parse', fromRef]);
    if (tip !== fromCommit) {
      try {
        // The verified commit must actually be (or have been) the from-branch state.
        git(repoDir, ['merge-base', '--is-ancestor', fromCommit, fromRef]);
        warnings.push(
          `"${from}" (${tip.slice(0, 7)}) has moved past the verified commit ${fromCommit.slice(0, 7)} — ` +
            `promoting ONLY the verified commit; the newer ${from} commit(s) stay unpromoted until they verify.`,
        );
      } catch {
        return {
          canPromote: false,
          reason: `commit ${fromCommit.slice(0, 7)} is not on "${fromRef}" — it was never the verified ${from} state (or history was rewritten). Re-verify before promoting.`,
          warnings,
        };
      }
    }
  } else {
    fromCommit = gitOut(repoDir, ['rev-parse', fromRef]);
  }

  try {
    // exits 0 iff `to` is an ancestor of the target commit (fast-forward is possible)
    git(repoDir, ['merge-base', '--is-ancestor', toRef, fromCommit]);
    return {
      canPromote: true,
      reason: `"${to}" can fast-forward to ${opts.commit ? `verified commit ${fromCommit.slice(0, 7)}` : `"${from}"`}`,
      fromCommit,
      warnings,
    };
  } catch {
    return {
      canPromote: false,
      reason: `"${to}" has diverged from "${from}" — fast-forward refused. Reconcile first (rebase "${from}" onto "${to}", or merge "${to}" into "${from}") before promoting.`,
      warnings,
    };
  }
}

/**
 * Perform the gated promotion: fast-forward `to` (main) to `from` (develop), and
 * optionally push. Refuses (no-op) if `canPromote` is false. Restores the original
 * branch afterwards. The fast-forward-only merge can never create a merge commit or
 * rewrite history — if it isn't a clean fast-forward, git errors and nothing moves.
 */
export function promote(
  repoDir: string,
  opts: { from?: string; to?: string; push?: boolean; commit?: string } = {},
): PromoteResult {
  const from = opts.from ?? 'develop';
  const to = opts.to ?? 'main';

  const check = canPromote(repoDir, from, to, { commit: opts.commit });
  if (!check.canPromote || !check.fromCommit) {
    return { promoted: false, from, to, reason: check.reason, warnings: check.warnings };
  }
  const warnings = check.warnings;

  // Use the EXACT commit canPromote resolved (the verified sha under --commit) — re-resolving the
  // branch here would reopen the verify→promote race a pinned promotion exists to close.
  const fromCommit = check.fromCommit;
  const current = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  if (opts.push) {
    // Server-side fast-forward of origin/<to> to <from>'s commit. This works even when <to>/<from>
    // are only remote-tracking refs in a fresh CI checkout (the promote workflow), and git rejects
    // a non-fast-forward push — so the divergence guarantee still holds at the remote.
    git(repoDir, ['push', 'origin', `${fromCommit}:refs/heads/${to}`]);
    // Best-effort: keep a local <to> in sync (skip when it's the current branch, to avoid leaving
    // the worktree behind its branch pointer). Safe — it's a verified fast-forward.
    if (current !== to) {
      try {
        git(repoDir, ['update-ref', `refs/heads/${to}`, fromCommit]);
      } catch {
        // local sync is cosmetic; the pushed remote is what matters
      }
    }
    return {
      promoted: true,
      from,
      to,
      reason: `"${to}" fast-forwarded to "${from}" and pushed`,
      warnings,
    };
  }

  // Local-only fast-forward (developer machine). Move the local <to> ref to the target commit
  // without a full checkout: `merge --ff-only` when <to> is checked out, else update the ref.
  if (current === to) {
    git(repoDir, ['merge', '--ff-only', fromCommit]);
  } else {
    git(repoDir, ['update-ref', `refs/heads/${to}`, fromCommit]);
  }

  return { promoted: true, from, to, reason: `"${to}" fast-forwarded to "${from}"`, warnings };
}
