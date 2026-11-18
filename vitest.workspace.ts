import { defineWorkspace } from 'vitest/config';

// These files run `greenlight preview` on bench fixtures in the process sandbox, which binds the
// fixture's fixed host port (4310, 4321, 4330, …). Run in parallel they collide: on 2026-11-18 a
// CI run lost a harness rollout's preview to another file's server on the same port, and the
// `git add/commit/push` after it never ran. One fork runs them one file at a time.
const HOST_PREVIEW = [
  'cli/src/__tests__/bench-run.test.ts',
  'cli/src/__tests__/bench-external.test.ts',
  'cli/src/__tests__/bench-iterate.test.ts',
  'bench/references/loop/reference-gates.test.ts',
];

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/**/*.test.ts', 'cli/**/*.test.ts', 'bench/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', ...HOST_PREVIEW],
    },
  },
  {
    test: {
      name: 'host-preview',
      include: HOST_PREVIEW,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
