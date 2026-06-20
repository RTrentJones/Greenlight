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

const VERIFY_MODES = new Set(['api', 'mcp', 'playwright', 'test']);

function asSpec(relPath: string, spec: { mode?: unknown }): VerifySpec {
  if (typeof spec?.mode !== 'string' || !VERIFY_MODES.has(spec.mode)) {
    throw new Error(
      `${relPath} must export a spec (or array of specs) with mode ${[...VERIFY_MODES].join('|')}`,
    );
  }
  return spec as VerifySpec;
}

/** Load a verify spec — or an ARRAY of specs (to combine modes, e.g. `[test, api]`) — from
 * a specific file (default export), or null if it doesn't exist. */
export async function loadVerifySpecAt(relPath: string): Promise<VerifySpec | VerifySpec[] | null> {
  const path = resolve(process.cwd(), relPath);
  if (!existsSync(path)) return null;
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(path)) as Record<string, unknown>;
  const def = 'default' in mod ? mod.default : mod;
  if (Array.isArray(def)) return def.map((s) => asSpec(relPath, s as { mode?: unknown }));
  return asSpec(relPath, def as { mode?: unknown });
}

/** Load a local tool's `<dir>/verify.config.ts` if present. */
export function loadVerifySpec(dir: string): Promise<VerifySpec | VerifySpec[] | null> {
  return loadVerifySpecAt(`${dir}/verify.config.ts`);
}

/** Load an external (registry) tool's spec, which lives in the wrapper at
 * `verify/<name>.config.ts` (the tool's code is in another repo). */
export function loadExternalVerifySpec(name: string): Promise<VerifySpec | VerifySpec[] | null> {
  return loadVerifySpecAt(`verify/${name}.config.ts`);
}
