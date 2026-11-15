import { gradeTrajectory } from '../../_lib/trajectory-grader.mjs';

// The ordering rules live in task.json. The rest is read from what was pushed: the route the
// brief asks for is served, the tool's verify config has a check on it, and that check holds.
export default (ctx) =>
  gradeTrajectory(ctx, {
    route: {
      dir: 'tools/changelog',
      command: ['node', 'server.mjs'],
      path: '/releases.json',
      key: 'releases',
      values: ['1.4.0', '1.3.2', '1.3.1'],
      verifyConfig: 'tools/changelog/verify.config.mjs',
    },
  });
