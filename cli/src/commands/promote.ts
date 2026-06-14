import { canPromote } from '@rtrentjones/greenlight-loop';

/**
 * Phase 1: report promote eligibility (the fast-forward guard, greenlight-v1.md §12).
 * Phase 3 wires this into a gated `promote` workflow that performs the fast-forward.
 */
export async function promoteCommand(_args: string[]): Promise<void> {
  const check = canPromote(process.cwd());
  console.log(`${check.canPromote ? '✔' : '✘'} ${check.reason}`);
  if (check.canPromote) {
    console.log(
      '\nEligible. (Phase 3 will perform the gated fast-forward via the promote workflow.)',
    );
  }
  process.exit(check.canPromote ? 0 : 1);
}
