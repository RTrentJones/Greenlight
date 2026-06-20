import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve bundled assets (lane templates, the agent skill) from the CLI package root
// when installed, falling back to the repo layout in dev. `here` is cli/src in dev and
// cli/dist when published — both are one level under the package root.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** Directory containing the `_template-<lane>` dirs. */
export function templatesRoot(): string {
  const packaged = resolve(packageRoot, 'templates'); // published: cli/templates
  if (existsSync(packaged)) return packaged;
  return resolve(process.cwd(), 'tools'); // dev: repo tools/
}

/** Directory of a bundled skill (default: the deploy-verify-promote loop skill).
 * Pass a provider skill name (`provider-vercel`, …) for the per-provider skills. */
export function skillAssetDir(name = 'deploy-verify-promote'): string {
  const packaged = resolve(packageRoot, 'assets', 'skills', name);
  if (existsSync(packaged)) return packaged;
  // dev: repo root (cwd-independent, so adopt/agent sync work from any directory)
  return resolve(packageRoot, '..', '.claude', 'skills', name);
}
