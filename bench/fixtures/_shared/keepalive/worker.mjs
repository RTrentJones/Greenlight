/**
 * Greenlight keepalive Worker (vendored from @rtrentjones/greenlight-keepalive 0.10.1).
 *
 * A Cloudflare Worker Cron Trigger. Every sweep reads `KEEPALIVE_TARGETS` (the JSON array in
 * `keepalive/targets.json`, passed through by `infra/keepalive.tf`) and probes each target.
 *
 * Target shape:
 *   name         tool name
 *   env          "beta" | "prod"
 *   url          base URL: the Supabase project API (https://<ref>.supabase.co) or a service URL
 *   kind         "supabase" (default) | "oci"
 *   anonKey      supabase only: the anon (publishable) key
 *   probeTable   supabase only: table the probe SELECTs from (required unless probePath is set)
 *   probeSchema  supabase only: Postgres schema of probeTable, sent as Accept-Profile
 *   probeSelect  supabase only: columns for select= (default "*")
 *   probePath    explicit probe path; overrides probeTable for supabase, defaults to "/" for oci
 *   remediate    oci only: fire a repository_dispatch on failure
 *
 * A supabase target is healthy only on a 2xx; an oci target on any status below 500.
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
      if (!t.probeTable) {
        return { ...base, ok: false, error: 'supabase target needs probeTable (or probePath)' };
      }
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

async function sweep(env) {
  const results = await runKeepalive(parseTargets(env.KEEPALIVE_TARGETS));
  for (const r of results) {
    const detail = r.status ? ` (${r.status})` : r.error ? ` ${r.error}` : '';
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.target}${detail}`);
  }
  return results;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
  async fetch(_req, env) {
    const results = await sweep(env);
    return new Response(`${JSON.stringify(results, null, 2)}\n`, {
      status: results.length > 0 && results.every((r) => r.ok) ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  },
};
