/**
 * Hidden trajectory grader (vision 06 §4.6, 08 §10.2): every rule in the task's
 * `trajectory.rules` must hold over the recorded trajectory. The rule DSL is evaluated by
 * packages/wiki/src/bench/trajectory.ts through `ctx.evaluateTrajectory`.
 *
 * `options.change` adds the one TREE check a loop task needs: the requested change is in what
 * was pushed. Without it, a rollout that previews the untouched fixture, makes an empty commit
 * and pushes satisfies every ordering rule. `{ file, contains }`: that file contains that text
 *   - in `ctx.pushedTree`, the tree of the origin's target branch exported by the runner after
 *     the rollout (ground truth: what a deploy from that branch would ship), or
 *   - in `ctx.tree` when the layer is synthetic (check-graders: a reference or mutant has no
 *     origin, so its working tree stands in for the pushed one).
 * In a real rollout with nothing on the origin branch the check fails.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CHANGE_CHECK = 'the requested change is in what was pushed';

function readChange(ctx, change) {
  const where = ctx.pushedKnown ? 'the pushed branch' : 'the tree';
  const root = ctx.pushedKnown ? ctx.pushedTree : ctx.tree;
  if (!root) return { passed: false, detail: 'nothing was pushed to the target branch' };
  const p = join(root, change.file);
  if (!existsSync(p) || !statSync(p).isFile())
    return { passed: false, detail: `${change.file} is not in ${where}` };
  const text = readFileSync(p, 'utf8');
  return text.includes(change.contains)
    ? { passed: true, detail: `${change.file} in ${where} has the requested text` }
    : { passed: false, detail: `${change.file} in ${where} does not contain the requested text` };
}

export async function gradeTrajectory(ctx, options = {}) {
  const checks = [];
  if (!ctx.trajectory) {
    checks.push(ctx.check('trajectory recorded', false, 'no trajectory.jsonl for this run'));
    return ctx.result(checks);
  }
  checks.push(
    ctx.check(
      'trajectory well-formed',
      ctx.trajectoryErrors.length === 0,
      ctx.trajectoryErrors.length
        ? ctx.trajectoryErrors.join('; ')
        : `${ctx.trajectory.length} events`,
    ),
  );
  for (const r of ctx.evaluateTrajectory()) checks.push(ctx.check(r.label, r.passed, r.detail));
  if (options.change) {
    const r = readChange(ctx, options.change);
    checks.push(ctx.check(CHANGE_CHECK, r.passed, r.detail));
  }
  return ctx.result(checks);
}
