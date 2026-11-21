/**
 * HISTORICAL (mutant source, never in a sandbox): the keepalive probe as released in 0.10.0.
 * It passes both `cache: 'no-store'` and `cf.cacheTtl: 0`; the Workers runtime rejects the pair
 * ("CacheTtl: 0, is not compatible with cache: no-store") and throws before the request leaves, so
 * every sweep fails and no probe reaches Postgres (the 2026-10 keepalive outage).
 */

export async function pingTarget(t, fetchFn = fetch) {
  const target = `${t.name}:${t.env}`;
  const base = { target, name: t.name, env: t.env, remediate: t.remediate };
  const kind = t.kind ?? 'supabase';
  let headers;
  let path = t.probePath;
  if (kind === 'oci') {
    path ??= '/';
  } else {
    if (!t.anonKey) return { ...base, ok: false, error: 'supabase target has no anonKey' };
    if (!path) {
      if (!t.probeTable) return { ...base, ok: false, error: 'supabase target needs probeTable' };
      const select = encodeURIComponent(t.probeSelect ?? '*');
      path = `/rest/v1/${encodeURIComponent(t.probeTable)}?select=${select}&limit=1`;
    }
    headers = { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` };
    if (t.probeSchema) headers['Accept-Profile'] = t.probeSchema;
  }
  const url = `${t.url.replace(/\/+$/, '')}${path}`;
  try {
    const res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      cf: { cacheTtl: 0 },
    });
    const ok =
      kind === 'oci' ? res.status > 0 && res.status < 500 : res.status >= 200 && res.status < 300;
    return { ...base, ok, status: res.status };
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runKeepalive(targets, fetchFn = fetch) {
  return Promise.all(targets.map((t) => pingTarget(t, fetchFn)));
}

export function parseTargets(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runKeepalive(parseTargets(env.KEEPALIVE_TARGETS)));
  },
  async fetch(_req, env) {
    const results = await runKeepalive(parseTargets(env.KEEPALIVE_TARGETS));
    return new Response(JSON.stringify(results), {
      status: results.every((r) => r.ok) ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  },
};
