import { canPromote, promote } from '@rtrentjones/greenlight-loop';

/**
 * Gated develop→main fast-forward (greenlight-v1.md §12).
 *   default          report eligibility only (safe)
 *   --perform        run the fast-forward locally
 *   --push           also push the promoted branch (implies --perform)
 */
export async function promoteCommand(args: string[]): Promise<void> {
  const push = args.includes('--push');
  const perform = push || args.includes('--perform');
  const cwd = process.cwd();

  if (!perform) {
    const check = canPromote(cwd);
    console.log(`${check.canPromote ? '✔' : '✘'} ${check.reason}`);
    if (check.canPromote) console.log('\nEligible. Re-run with --perform (and --push) to promote.');
    process.exit(check.canPromote ? 0 : 1);
  }

  const result = promote(cwd, { push });
  console.log(`${result.promoted ? '✔' : '✘'} ${result.reason}`);
  process.exit(result.promoted ? 0 : 1);
}
