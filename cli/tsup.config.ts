import { defineConfig } from 'tsup';

// CLI: a library entry (index) + the executable bin. The bin keeps its #!/usr/bin/env
// node shebang and is emitted as dist/bin.js. The @rtrentjones/greenlight-* workspace libs
// are BUNDLED in (noExternal) so the CLI is the single published package; third-party deps
// (zod, mcp-sdk, jiti, and the optional playwright/anthropic) stay external.
export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  outDir: 'dist',
  noExternal: [/^@rtrentjones\/greenlight-/],
  // tsup externalizes `dependencies` (zod, mcp-sdk, jiti) automatically, but NOT
  // optionalDependencies — keep playwright/anthropic external so they stay lazy-loaded.
  external: ['playwright', '@anthropic-ai/sdk'],
});
