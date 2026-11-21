import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DataBackend,
  type GreenlightConfig,
  type Lane,
  type Target,
  loadConfig,
} from '@rtrentjones/greenlight-shared';
import {
  CHECK_ID_RE,
  type VerifyConfigMeta,
  type VerifyCoverage,
  type VerifySpec,
  declaredIds,
} from '@rtrentjones/greenlight-verify';
import { createJiti } from 'jiti';

/** Manifest file names, in precedence order. The `.mjs`/`.js` forms are plain-object manifests (no
 * package import), as the bench fixtures use so a sandbox needs no dependency install. */
export const MANIFEST_FILES = [
  'greenlight.config.ts',
  'greenlight.config.example.ts',
  'greenlight.config.mjs',
  'greenlight.config.js',
] as const;

export function findManifestPath(cwd = process.cwd()): string | null {
  for (const name of MANIFEST_FILES) {
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

/** A loaded verify config: the specs for one context, plus its named `meta` export (vision 08 §6). */
export interface LoadedVerifyConfig {
  specs: VerifySpec | VerifySpec[];
  meta: VerifyConfigMeta;
}

async function importConfig(relPath: string): Promise<Record<string, unknown> | null> {
  const path = resolve(process.cwd(), relPath);
  if (!existsSync(path)) return null;
  const jiti = createJiti(import.meta.url);
  try {
    return (await jiti.import(path)) as Record<string, unknown>;
  } catch (e) {
    // The file exists but failed to evaluate (syntax/import error) — name it rather than throwing a
    // raw stack with no file context (missing-file already returns null above).
    throw new Error(
      `Could not load verify spec ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Validate the named `meta` export strictly, like a spec: an unknown key or a malformed id must
 * fail loudly rather than silently drop an invariant (C7). */
function readMeta(relPath: string, mod: Record<string, unknown>): VerifyConfigMeta {
  if (!('meta' in mod) || mod.meta === undefined) return {};
  const meta = mod.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error(`${relPath}: export "meta" must be an object`);
  }
  for (const k of Object.keys(meta)) {
    if (k !== 'invariant') throw new Error(`${relPath}: meta has unsupported field "${k}"`);
  }
  const inv = (meta as { invariant?: unknown }).invariant;
  if (inv === undefined) return {};
  if (!Array.isArray(inv) || !inv.every((x) => typeof x === 'string' && CHECK_ID_RE.test(x))) {
    throw new Error(`${relPath}: meta.invariant must be an array of kebab-case check ids`);
  }
  return { invariant: [...inv] as string[] };
}

async function evaluateDefault(
  relPath: string,
  mod: Record<string, unknown>,
  ctx: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[]> {
  let def = 'default' in mod ? mod.default : mod;
  if (typeof def === 'function') {
    try {
      def = await (def as (c: VerifyConfigContext) => unknown)(ctx);
    } catch (e) {
      throw new Error(
        `Verify config function ${relPath} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (Array.isArray(def)) return def.map((s) => asSpec(relPath, s as { mode?: unknown }));
  return asSpec(relPath, def as { mode?: unknown });
}

/** Load a verify config with its named exports preserved (vision 08 §6): the specs for `ctx`, and
 * the validated `meta`. Null when the file does not exist. */
export async function loadVerifyConfigAt(
  relPath: string,
  ctx?: VerifyConfigContext,
): Promise<LoadedVerifyConfig | null> {
  const mod = await importConfig(relPath);
  if (!mod) return null;
  return {
    specs: await evaluateDefault(relPath, mod, ctx ?? ctxFromEnv()),
    meta: readMeta(relPath, mod),
  };
}

/** Load a verify spec — or an ARRAY of specs (to combine modes, e.g. `[test, api]`) — from
 * a specific file (default export), or null if it doesn't exist. The default export may also be
 * a FUNCTION `(ctx: VerifyConfigContext) => spec | spec[]` (sync or async) — the explicit
 * alternative to reading GREENLIGHT_* env vars at module-eval time. */
export async function loadVerifySpecAt(
  relPath: string,
  ctx?: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[] | null> {
  return (await loadVerifyConfigAt(relPath, ctx))?.specs ?? null;
}

const COVERAGE_CTXS: ReadonlyArray<VerifyConfigContext> = [
  { env: 'preview', preview: true },
  { env: 'beta', preview: false },
  { env: 'prod', preview: false },
];

/** Per-environment coverage of a config's check ids (vision 08 §6, C7). The default export is
 * evaluated once per context; a context whose evaluation throws counts as zero coverage there.
 * `missing` lists each `meta.invariant` id absent from an env. Null when the file does not exist. */
export async function verifyCoverageAt(relPath: string): Promise<VerifyCoverage | null> {
  const mod = await importConfig(relPath);
  if (!mod) return null;
  const meta = readMeta(relPath, mod);
  const invariant = meta.invariant ?? [];
  const byEnv = { preview: [], beta: [], prod: [] } as VerifyCoverage['byEnv'];
  for (const ctx of COVERAGE_CTXS) {
    let ids: string[] = [];
    try {
      const specs = await evaluateDefault(relPath, mod, ctx);
      ids = (Array.isArray(specs) ? specs : [specs]).flatMap((sp) => declaredIds(sp));
    } catch {
      ids = [];
    }
    byEnv[ctx.env] = [...new Set(ids)];
  }
  const missing = COVERAGE_CTXS.flatMap((ctx) =>
    invariant.filter((id) => !byEnv[ctx.env].includes(id)).map((id) => ({ env: ctx.env, id })),
  );
  return { invariant, byEnv, missing };
}

/** Verify config file names for a local tool, in precedence order (`.ts`, then the plain-JS forms
 * a dependency-free fixture uses). */
export const VERIFY_CONFIG_FILES = ['verify.config.ts', 'verify.config.mjs', 'verify.config.js'];

/** Load a local tool's `<dir>/verify.config.{ts,mjs,js}` if present (the first that exists). */
export function loadVerifySpec(
  dir: string,
  ctx?: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[] | null> {
  const name =
    VERIFY_CONFIG_FILES.find((f) => existsSync(resolve(process.cwd(), dir, f))) ??
    VERIFY_CONFIG_FILES[0];
  return loadVerifySpecAt(`${dir}/${name}`, ctx);
}

/** Load an external (registry) tool's spec, which lives in the wrapper at
 * `verify/<name>.config.ts` (the tool's code is in another repo). */
export function loadExternalVerifySpec(
  name: string,
  ctx?: VerifyConfigContext,
): Promise<VerifySpec | VerifySpec[] | null> {
  return loadVerifySpecAt(`verify/${name}.config.ts`, ctx);
}
