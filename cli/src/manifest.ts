import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DataBackend,
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

export interface PreviewDescriptor {
  command: string;
  teardown?: string;
  port?: number;
  path?: string;
}

export interface ResolvedEntry {
  /** undefined = the blog (apex); a string = a subdomain tool. */
  name: string | undefined;
  lane: Lane;
  target: Target;
  data: DataBackend;
  /** Directory the tool builds/deploys from, relative to the repo root. */
  dir: string;
  /** Code lives in another repo — registry pointer; not built/deployed here. */
  external: boolean;
  /** Container port (target: oci); also the default local preview port. */
  port?: number;
  /** Per-tool readiness window override (ms) for preview/verify waits. */
  readyTimeoutMs?: number;
  /** How `greenlight preview` spins this tool up locally (target with no built-in serve). */
  preview?: PreviewDescriptor;
  /** Project-scoped secret names this tool needs (conformance/docs). */
  tokens?: string[];
  /** Per-tool provider-token overrides (multi-account): default env var → alternate secret name. */
  tokenOverrides?: Record<string, string>;
}

/** Resolve a manifest entry by name. `blog` maps to the apex (no subdomain name). */
export function resolveEntry(config: GreenlightConfig, name: string): ResolvedEntry {
  if (name === 'blog') {
    if (!config.blog) throw new Error('this manifest has no blog');
    return {
      name: undefined,
      lane: config.blog.lane,
      target: config.blog.target,
      data: config.blog.data,
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
    data: tool.data,
    dir: tool.dir ?? `tools/${tool.name}`,
    external: tool.external,
    port: tool.port,
    readyTimeoutMs: tool.readyTimeoutMs,
    preview: tool.preview,
    tokens: tool.tokens,
    tokenOverrides: tool.tokenOverrides,
  };
}

const VERIFY_MODES = new Set(['api', 'mcp', 'playwright', 'test', 'agent-web', 'eval']);

/** What a FUNCTION-shaped verify config receives (S3). Object configs that branch on env state
 * had to read `GREENLIGHT_PREVIEW`/`GREENLIGHT_VERIFY_URL` at module-eval time — which made a
 * spec's meaning depend on ambient process state and import ordering ("set BEFORE loading the
 * spec"). Export a function instead and the context arrives explicitly:
 *
 *   export default ({ preview }: VerifyConfigContext) => [
 *     { mode: 'mcp', expectTools: [...], requireAuthRejection: !preview },
 *   ];
 */
export interface VerifyConfigContext {
  /** The env this verify targets ('preview' for local/preview URLs). */
  env: 'preview' | 'beta' | 'prod';
  /** The URL being verified, when known at load time. */
  url?: string;
  /** True under `greenlight preview` (local run — e.g. skip an auth-rejection a local no-auth
   * server can't satisfy). */
  preview: boolean;
}

/** Back-compat default: derive the context from the env vars the harness already sets, so a
 * function config loaded through an older call path still gets a truthful ctx. */
function ctxFromEnv(): VerifyConfigContext {
  const preview = process.env.GREENLIGHT_PREVIEW === '1';
  return {
    env: preview ? 'preview' : ((process.env.GREENLIGHT_VERIFY_ENV as 'beta' | 'prod') ?? 'prod'),
    url: process.env.GREENLIGHT_VERIFY_URL,
    preview,
  };
}

function asSpec(relPath: string, spec: { mode?: unknown }): VerifySpec {
  if (typeof spec?.mode !== 'string' || !VERIFY_MODES.has(spec.mode)) {
    throw new Error(
      `${relPath} must export a spec (or array of specs) with mode ${[...VERIFY_MODES].join('|')}`,
    );
  }
  return spec as VerifySpec;
}

/** Load a verify spec — or an ARRAY of specs (to combine modes, e.g. `[test, api]`) — from
 * a specific file (default export), or null if it doesn't exist. The default export may also be
 * a FUNCTION `(ctx: VerifyConfigContext) => spec | spec[]` (sync or async) — the explicit
 * alternative to reading GREENLIGHT_* env vars at module-eval time. */
export async function loadVerifySpecAt(
  relPath: string,
  ctx?: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[] | null> {
  const path = resolve(process.cwd(), relPath);
  if (!existsSync(path)) return null;
  const jiti = createJiti(import.meta.url);
  let mod: Record<string, unknown>;
  try {
    mod = (await jiti.import(path)) as Record<string, unknown>;
  } catch (e) {
    // The file exists but failed to evaluate (syntax/import error) — name it rather than throwing a
    // raw stack with no file context (missing-file already returns null above).
    throw new Error(
      `Could not load verify spec ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let def = 'default' in mod ? mod.default : mod;
  if (typeof def === 'function') {
    try {
      def = await (def as (c: VerifyConfigContext) => unknown)(ctx ?? ctxFromEnv());
    } catch (e) {
      throw new Error(
        `Verify config function ${relPath} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (Array.isArray(def)) return def.map((s) => asSpec(relPath, s as { mode?: unknown }));
  return asSpec(relPath, def as { mode?: unknown });
}

/** Load a local tool's `<dir>/verify.config.ts` if present. */
export function loadVerifySpec(
  dir: string,
  ctx?: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[] | null> {
  return loadVerifySpecAt(`${dir}/verify.config.ts`, ctx);
}

/** Load an external (registry) tool's spec, which lives in the wrapper at
 * `verify/<name>.config.ts` (the tool's code is in another repo). */
export function loadExternalVerifySpec(
  name: string,
  ctx?: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[] | null> {
  return loadVerifySpecAt(`verify/${name}.config.ts`, ctx);
}
