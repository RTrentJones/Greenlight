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
    {
      name: 'gate-never-depends-on-knowledge',
      severity: 'error',
      comment:
        'The deploy gate must not depend on the knowledge plane, so a broken wiki can never break a ' +
        'deploy (vision 03 §3). Only cli/ wires wiki to verify/loop.',
      from: { path: '^packages/(verify|loop|adapters|shared)/' },
      to: { path: '(^packages/wiki/|greenlight-wiki)' },
    },
    {
      name: 'wiki-imports-only-shared',
      severity: 'error',
      comment:
        'packages/wiki consumes verify/loop output as data, never as code (vision 03 §3): it may ' +
        'import packages/shared only.',
      from: { path: '^packages/wiki/' },
      to: {
        path: '(^packages/(verify|loop|adapters)/|^cli/|greenlight-(verify|loop|adapters)$|@rtrentjones/greenlight$)',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Generated/copied assets, not framework source.
    exclude: { path: '(^|/)(dist|templates|assets)/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
};
