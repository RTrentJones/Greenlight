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

export function canPromote(repoDir: string, from = 'develop', to = 'main'): PromoteCheck {
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  };

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
