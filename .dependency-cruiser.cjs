/**
 * dependency-cruiser config — enforces seam rule 15.2.2 (greenlight-v1.md):
 * load-bearing logic lives only in `packages/*` and `cli/`, and framework
 * code must never depend on consumer content (tools/apps).
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the package split (Phase 7) fragile.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'framework-no-consumer-imports',
      severity: 'error',
      comment:
        'Framework code (cli/, packages/) must not import consumer content (tools/, apps/). ' +
        'The dependency direction is consumer -> framework, never the reverse.',
      from: { path: '^(cli|packages)/' },
      to: { path: '^(tools|apps)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
};
