import type { ModelsConfig } from '../schema';
import { GEMINI_BASE_URL, GeminiClient, type GeminiClientOptions, geminiHeaders } from './gemini';
import { type RateLimitPersistence, RateLimiter } from './limits';

/** Wiring between `bench/models.json` (08 §10.6) and the client: role resolution, shared rate
 * limiters, and the `bench models --check` core (ADR-20: the pair is verified against
 * `models.list` at every gate). */

export type ModelRole = 'maintainer' | 'proposer' | 'judge';
type Entry = ModelsConfig['roles']['frontier'];

/** The entry ('frontier' | 'small') a role maps to. */
export function entryForRole(config: ModelsConfig, role: ModelRole): Entry {
  return config.roles[config.roles[role]];
}

/** Every distinct model entry in the config, and fallbacks that name another entry's id. */
function entries(config: ModelsConfig): Entry[] {
  return [config.roles.frontier, config.roles.small];
}

/** Limits for any id: an entry's own, else the entry it is the fallback of (a fallback with no
 * entry of its own is throttled at its primary's limits, the conservative choice). */
export function limitsFor(config: ModelsConfig, id: string): Entry['limits'] | undefined {
  const all = entries(config);
  return all.find((e) => e.id === id)?.limits ?? all.find((e) => e.fallback === id)?.limits;
}

/** One `RateLimiter` per model id in the config (primaries and fallbacks). Share the map across
 * every client of one process: the free-tier quota is per project, not per client. */
export function createLimiters(
  config: ModelsConfig,
  opts: Omit<ConstructorParameters<typeof RateLimiter>[0], 'modelId' | 'rpm' | 'rpd'> & {
    persistence?: RateLimitPersistence;
  } = {},
): Map<string, RateLimiter> {
  const m = new Map<string, RateLimiter>();
  for (const e of entries(config)) {
    for (const id of [e.id, e.fallback]) {
      if (!id || m.has(id)) continue;
      const l = limitsFor(config, id) as Entry['limits'];
      m.set(id, new RateLimiter({ ...opts, modelId: id, rpm: l.rpm, rpd: l.rpd }));
    }
  }
  return m;
}

/** A client for a role, with the config's key env, temperature and fallback. */
export function clientForRole(
  config: ModelsConfig,
  role: ModelRole | 'frontier' | 'small',
  opts: Omit<GeminiClientOptions, 'model' | 'keyEnv' | 'temperature'> & { temperature?: number },
): GeminiClient {
  if (config.provider !== 'gemini') {
    throw new Error(`provider "${config.provider}" is not implemented by the Greenlight harness`);
  }
  const e =
    role === 'frontier' || role === 'small' ? config.roles[role] : entryForRole(config, role);
  return new GeminiClient({
    ...opts,
    model: { id: e.id, ...(e.fallback ? { fallback: e.fallback } : {}) },
    keyEnv: config.keyEnv,
    temperature: opts.temperature ?? config.temperature,
  });
}

export interface ModelsCheck {
  ok: boolean;
  /** Ids the config names (primaries and fallbacks). */
  checked: string[];
  /** Named ids absent from `models.list`, listing no generation methods, or lacking
   * `generateContent`. */
  missing: string[];
  /** Named ids the API marks deprecated: still usable today, so `ok` is unaffected, but the gate
   * pair should move before the model is retired (a retired id re-baselines everything). */
  deprecated: string[];
  /** Every id `models.list` returned that supports `generateContent`. */
  available: string[];
}

interface ListedModel {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  deprecated?: boolean;
  state?: string;
  deprecationTime?: string;
  deprecationDate?: string;
}

/** True when the listing marks the model deprecated: an explicit flag or state, a deprecation
 * date, or "deprecated" in its display name or description (where Gemini announces it). */
export function isDeprecated(m: ListedModel): boolean {
  if (m.deprecated === true) return true;
  if (typeof m.state === 'string' && /deprecat|retir/i.test(m.state)) return true;
  if (m.deprecationTime || m.deprecationDate) return true;
  return /\bdeprecated\b/i.test(`${m.displayName ?? ''} ${m.description ?? ''}`);
}

/** `bench models --check`: lists the provider's models and fails on any configured id that is not
 * available for `generateContent`. Throws on a transport/HTTP failure (that is not a verdict). */
export async function checkModels(
  config: ModelsConfig,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  opts: { env?: Record<string, string | undefined>; baseUrl?: string } = {},
): Promise<ModelsCheck> {
  const env = opts.env ?? process.env;
  const available = new Set<string>();
  const deprecatedIds = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetchImpl(`${opts.baseUrl ?? GEMINI_BASE_URL}/models?${q}`, {
      headers: geminiHeaders(config.keyEnv, env),
    });
    if (!res.ok) throw new Error(`models.list failed: HTTP ${res.status}`);
    const data = (await res.json()) as { models?: ListedModel[]; nextPageToken?: string };
    for (const m of data.models ?? []) {
      // A model that lists no methods cannot be shown to serve generateContent: unusable.
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      available.add(id);
      if (isDeprecated(m)) deprecatedIds.add(id);
    }
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  const checked = [
    ...new Set(entries(config).flatMap((e) => [e.id, e.fallback].filter(Boolean) as string[])),
  ];
  const missing = checked.filter((id) => !available.has(id));
  const deprecated = checked.filter((id) => deprecatedIds.has(id));
  return {
    ok: missing.length === 0,
    checked,
    missing,
    deprecated,
    available: [...available].sort(),
  };
}
