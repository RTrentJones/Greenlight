import { defineWorkspace } from 'vitest/config';

// These files run `greenlight preview` on bench fixtures in the process sandbox, which binds the
// fixture's fixed host port (4310, 4321, 4330, …). Run in parallel they collide: on 2026-11-18 a
// CI run lost a harness rollout's preview to another file's server on the same port, and the
// `git add/commit/push` after it never ran. One fork runs them one file at a time.
//
// The two grader-runtime files join them for a different reason: they start real app processes
// under the fake clock (and the real bench self-test grades every task at once), so they are the
// files most hurt by CPU contention. With the rest of the suite on every core, the real-bench
// self-test and the 20-poll clock test each failed once on load alone (2026-11-19).
const HOST_PREVIEW = [
  'cli/src/__tests__/bench-run.test.ts',
  'cli/src/__tests__/bench-external.test.ts',
  'cli/src/__tests__/bench-iterate.test.ts',
  'bench/references/loop/reference-gates.test.ts',
  'packages/wiki/src/bench/__tests__/check-graders.test.ts',
  'packages/wiki/src/bench/__tests__/grader-api.test.ts',
];

// Gates run inside tests must not write raw records into this checkout's `.greenlight/raw`,
// which is the field evidence a maintainer bundle samples. Capture tests pass their own env.
const env = { GREENLIGHT_RAW: 'off' };

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      env,
      include: ['packages/**/*.test.ts', 'cli/**/*.test.ts', 'bench/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', ...HOST_PREVIEW],
    },
  },
  {
    test: {
      name: 'host-preview',
      env,
      include: HOST_PREVIEW,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
