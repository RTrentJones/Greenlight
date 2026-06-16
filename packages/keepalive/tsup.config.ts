import { defineConfig } from 'tsup';

// Bundle the Worker to a single ESM file. Terraform's cloudflare_workers_script reads
// this as `content` (a self-contained module). No deps (global fetch), so the bundle is tiny.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  outDir: 'dist',
});
