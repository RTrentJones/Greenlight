import { canPromote, promote } from '@rtrentjones/greenlight-loop';
import { parseFlags } from '../args';

/**
 * Gated develop→main fast-forward (docs/archive/greenlight-v1.md §12).
 *   default          report eligibility only (safe)
 *   --perform        run the fast-forward locally
 *   --push           also push the promoted branch (implies --perform)
 */
export async function promoteCommand(args: string[]): Promise<number> {
  const parsed = parseFlags('promote', args, { boolean: ['--perform', '--push'] });
  const push = parsed.flags.has('--push');
  const perform = push || parsed.flags.has('--perform');
  const cwd = process.cwd();

  if (!perform) {
    const check = canPromote(cwd);
    for (const w of check.warnings ?? []) console.warn(`⚠ ${w}`);
    console.log(`${check.canPromote ? '✔' : '✘'} ${check.reason}`);
    if (check.canPromote) console.log('\nEligible. Re-run with --perform (and --push) to promote.');
    return check.canPromote ? 0 : 1;
  }

  const result = promote(cwd, { push });
  for (const w of result.warnings ?? []) console.warn(`⚠ ${w}`);
  console.log(`${result.promoted ? '✔' : '✘'} ${result.reason}`);
  return result.promoted ? 0 : 1;
}
