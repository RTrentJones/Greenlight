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
}

export interface PromoteResult {
  promoted: boolean;
  from: string;
  to: string;
  reason: string;
}

function git(repoDir: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}

function gitOut(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

/** Resolve a branch to a usable ref, preferring a local branch but falling back to its
 * remote-tracking ref (`origin/<branch>`). A fresh CI checkout (e.g. the promote workflow) has only
 * the checked-out branch locally; the other side exists solely as `origin/<branch>` — without this
 * fallback promote wrongly reports "branch not found". Returns null if neither ref resolves. */
function resolveRef(repoDir: string, branch: string): string | null {
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      git(repoDir, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function canPromote(repoDir: string, from = 'develop', to = 'main'): PromoteCheck {
  const fromRef = resolveRef(repoDir, from);
  const toRef = resolveRef(repoDir, to);
  if (!fromRef || !toRef) {
    return { canPromote: false, reason: `branch "${from}" or "${to}" not found in ${repoDir}` };
  }

  try {
    // exits 0 iff `to` is an ancestor of `from` (fast-forward is possible)
    git(repoDir, ['merge-base', '--is-ancestor', toRef, fromRef]);
    return { canPromote: true, reason: `"${to}" can fast-forward to "${from}"` };
  } catch {
    return {
      canPromote: false,
      reason: `"${to}" has diverged from "${from}" — fast-forward refused. Reconcile first (rebase "${from}" onto "${to}", or merge "${to}" into "${from}") before promoting.`,
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
  opts: { from?: string; to?: string; push?: boolean } = {},
): PromoteResult {
  const from = opts.from ?? 'develop';
  const to = opts.to ?? 'main';

  const check = canPromote(repoDir, from, to);
  if (!check.canPromote) return { promoted: false, from, to, reason: check.reason };

  // canPromote confirmed both refs resolve + `to` is an ancestor of `from` (a true fast-forward).
  const fromRef = resolveRef(repoDir, from) as string;
  const fromCommit = gitOut(repoDir, ['rev-parse', fromRef]);
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
    return { promoted: true, from, to, reason: `"${to}" fast-forwarded to "${from}" and pushed` };
  }

  // Local-only fast-forward (developer machine). Move the local <to> ref to <from>'s commit without
  // a full checkout: `merge --ff-only` when <to> is checked out, else update the ref directly.
  if (current === to) {
    git(repoDir, ['merge', '--ff-only', fromRef]);
  } else {
    git(repoDir, ['update-ref', `refs/heads/${to}`, fromCommit]);
  }

  return { promoted: true, from, to, reason: `"${to}" fast-forwarded to "${from}"` };
}
