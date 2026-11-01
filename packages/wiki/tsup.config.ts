import { defineConfig } from 'tsup';

// Emits dist/ for publishing. Dev still consumes src/ (package.json main → src);
// publishConfig swaps the published pointers to dist. Workspace + npm deps stay
// external (tsup auto-externalizes package.json dependencies).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
});
