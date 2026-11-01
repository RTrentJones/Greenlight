/**
 * Hidden trajectory grader (vision 06 §4.6, 08 §10.2): every rule in the task's
 * `trajectory.rules` must hold over the recorded trajectory. The rule DSL is evaluated by
 * packages/wiki/src/bench/trajectory.ts through `ctx.evaluateTrajectory`.
 */
export async function gradeTrajectory(ctx) {
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
  return ctx.result(checks);
}
