/**
 * HISTORICAL (mutant source, never in a sandbox): the keepalive probe as deployed through 0.8.x.
 * A supabase target is probed at the PostgREST root `/rest/v1/`, which PostgREST answers from its
 * schema cache without running a query, and any status below 500 counts as alive. This is the
 * probe that reported green while the database paused (2026-08, vision 15 §2.1).
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
    path ??= '/rest/v1/';
    headers = { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` };
  }
  const url = `${t.url.replace(/\/+$/, '')}${path}`;
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
    return { ...base, ok: res.status > 0 && res.status < 500, status: res.status };
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
