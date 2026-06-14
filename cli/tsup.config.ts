import { defineConfig } from 'tsup';

// CLI: a library entry (index) + the executable bin. The bin keeps its #!/usr/bin/env
// node shebang and is emitted as dist/bin.js. Workspace deps + jiti stay external.
export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  outDir: 'dist',
});
