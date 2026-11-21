// A deliberately WEAK grader (13 §2.7): it only checks that a trajectory was recorded, so it
// cannot tell a push-first run from a preview-first one. check-graders must report the escaping
// mutant by id.
export default async function grade(ctx) {
  return ctx.result([ctx.check('trajectory recorded', Array.isArray(ctx.trajectory))]);
}
