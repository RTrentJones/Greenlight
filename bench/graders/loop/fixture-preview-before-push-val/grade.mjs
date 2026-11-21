import { gradeTrajectory } from '../../_lib/trajectory-grader.mjs';

// The ordering rules live in task.json; the change the brief asks for must also be in what was
// pushed (an empty commit pushed after a preview of the untouched fixture is not the task).
export default (ctx) =>
  gradeTrajectory(ctx, {
    change: { file: 'tools/pinboard/app.mjs', contains: 'No pins yet. Add the first one.' },
  });
