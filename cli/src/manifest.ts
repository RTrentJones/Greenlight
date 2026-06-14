import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GreenlightConfig,
  type Lane,
  type Target,
  loadConfig,
} from '@rtrentjones/greenlight-shared';

export function findManifestPath(cwd = process.cwd()): string | null {
  for (const name of ['greenlight.config.ts', 'greenlight.config.example.ts']) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function loadManifest(cwd = process.cwd()): Promise<{
  path: string;
  config: GreenlightConfig;
}> {
  const path = findManifestPath(cwd);
  if (!path) {
    throw new Error(
      'No greenlight.config.ts (or greenlight.config.example.ts) found in this directory.',
    );
  }
  return { path, config: await loadConfig(path) };
}

export interface ResolvedEntry {
  /** undefined = the blog (apex); a string = a subdomain tool. */
  name: string | undefined;
  lane: Lane;
  target: Target;
  /** Directory the tool lives in, relative to the repo root. */
  dir: string;
}

/** Resolve a manifest entry by name. `blog` maps to the apex (no subdomain name). */
export function resolveEntry(config: GreenlightConfig, name: string): ResolvedEntry {
  if (name === 'blog') {
    return {
      name: undefined,
      lane: config.blog.lane,
      target: config.blog.target,
      dir: 'apps/blog',
    };
  }
  const tool = config.tools.find((t) => t.name === name);
  if (!tool) {
    const known = ['blog', ...config.tools.map((t) => t.name)].join(', ');
    throw new Error(`no entry "${name}" in manifest (known: ${known})`);
  }
  return { name: tool.name, lane: tool.lane, target: tool.target, dir: `tools/${tool.name}` };
}
