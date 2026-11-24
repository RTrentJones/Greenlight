import { gradeTrajectory } from '../../_lib/trajectory-grader.mjs';

// The ordering rules live in task.json. The rest is read from what was pushed: the route the
// brief asks for is served, the tool's verify config has a check on it, and that check holds.
export default (ctx) =>
  gradeTrajectory(ctx, {
    route: {
      dir: 'tools/trailnotes',
      command: ['node', 'app.mjs'],
      path: '/trails.json',
      key: 'trails',
      values: ['cedar-loop', 'ridge-walk', 'mill-creek', 'fire-tower'],
      verifyConfig: 'tools/trailnotes/verify.config.mjs',
    },
  });
