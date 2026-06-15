import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GreenlightConfig,
  type Lane,
  type Target,
  loadConfig,
} from '@rtrentjones/greenlight-shared';
import type { VerifySpec } from '@rtrentjones/greenlight-verify';
import { createJiti } from 'jiti';

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
  /** Directory the tool builds/deploys from, relative to the repo root. */
  dir: string;
  /** Code lives in another repo — registry pointer; not built/deployed here. */
  external: boolean;
}

/** Resolve a manifest entry by name. `blog` maps to the apex (no subdomain name). */
export function resolveEntry(config: GreenlightConfig, name: string): ResolvedEntry {
  if (name === 'blog') {
    if (!config.blog) throw new Error('this manifest has no blog');
    return {
      name: undefined,
      lane: config.blog.lane,
      target: config.blog.target,
      dir: 'apps/blog',
      external: false,
    };
  }
  const tool = config.tools.find((t) => t.name === name);
  if (!tool) {
    const known = [...(config.blog ? ['blog'] : []), ...config.tools.map((t) => t.name)].join(', ');
    throw new Error(`no entry "${name}" in manifest (known: ${known})`);
  }
  return {
    name: tool.name,
    lane: tool.lane,
    target: tool.target,
    dir: tool.dir ?? `tools/${tool.name}`,
    external: tool.external,
  };
}

const VERIFY_MODES = new Set(['api', 'mcp', 'playwright']);

/** Load a per-tool `verify.config.ts` if present (default export = a VerifySpec). */
export async function loadVerifySpec(dir: string): Promise<VerifySpec | null> {
  const path = resolve(process.cwd(), dir, 'verify.config.ts');
  if (!existsSync(path)) return null;
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(path)) as Record<string, unknown>;
  const spec = ('default' in mod ? mod.default : mod) as { mode?: unknown };
  if (typeof spec?.mode !== 'string' || !VERIFY_MODES.has(spec.mode)) {
    throw new Error(`${dir}/verify.config.ts must export a spec with mode api|mcp|playwright`);
  }
  return spec as VerifySpec;
}
