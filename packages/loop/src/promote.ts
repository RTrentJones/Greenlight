import { execFileSync } from 'node:child_process';

/**
 * Promote = fast-forward `develop` → `main` after beta verify passes
 * (greenlight-v1.md §12). The guard enforces the divergence policy: a
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

export function canPromote(repoDir: string, from = 'develop', to = 'main'): PromoteCheck {
  const run = (args: string[]): void => git(repoDir, args);

  try {
    run(['rev-parse', '--verify', '--quiet', from]);
    run(['rev-parse', '--verify', '--quiet', to]);
  } catch {
    return { canPromote: false, reason: `branch "${from}" or "${to}" not found in ${repoDir}` };
  }

  try {
    // exits 0 iff `to` is an ancestor of `from` (fast-forward is possible)
    run(['merge-base', '--is-ancestor', to, from]);
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

  const original = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  try {
    git(repoDir, ['checkout', to]);
    git(repoDir, ['merge', '--ff-only', from]);
    if (opts.push) git(repoDir, ['push', 'origin', to]);
  } finally {
    if (original && original !== 'HEAD' && original !== to) {
      try {
        git(repoDir, ['checkout', original]);
      } catch {
        // best-effort restore
      }
    }
  }

  return {
    promoted: true,
    from,
    to,
    reason: `"${to}" fast-forwarded to "${from}"${opts.push ? ' and pushed' : ''}`,
  };
}
