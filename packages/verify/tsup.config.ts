import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // playwright is an optionalDependency (dynamic import) — keep it external, never bundle it.
  external: ['playwright'],
});
