/**
 * Greenlight keepalive — a Cloudflare Worker Cron Trigger that keeps `data: supabase`
 * projects from hitting Supabase's 7-day idle pause (the failure that took HeistMind
 * down) and health-checks `target: oci` services, alerting via the `github-issue` sink
 * if anything stops responding.
 *
 * A Worker cron (not a GitHub Actions schedule) is used deliberately: it's immune to
 * GitHub's "disable scheduled workflows after 60 days of repo inactivity" rule
 * (greenlight-v1.md §6). The pure functions below are unit-tested; the Worker's
 * `scheduled`/`fetch` handlers are thin wrappers over them.
 *
 * Note: keepalive does NOT prevent OCI Always-Free idle-reclaim — that needs the tenancy
 * on Pay-As-You-Go (docs/oci-payg-runbook.md). For OCI it only health-checks + alerts.
 */

export interface KeepaliveTarget {
  /** Tool name, e.g. "heistmind". */
  name: string;
  /** Env label, e.g. "beta" | "prod". */
  env: string;
  /** Base URL — Supabase project API (https://<ref>.supabase.co) or an OCI service. */
  url: string;
  /** 'supabase' = authed REST ping that resets the 7-day pause; 'oci' = plain health GET. Default 'supabase'. */
  kind?: 'supabase' | 'oci';
  /** anon (publishable) key for the Supabase REST request. Omit for `oci`. */
  anonKey?: string;
  /** Probe path; defaults to `/rest/v1/` (supabase) or `/` (oci). */
  probePath?: string;
}

/** @deprecated use KeepaliveTarget. */
export type SupabaseTarget = KeepaliveTarget;

export interface KeepaliveResult {
  /** `name:env`. */
  target: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface AlertSink {
  /** owner/repo for the github-issue sink. */
  githubRepo?: string;
  /** token with `issues: write` on that repo. */
  githubToken?: string;
}

type FetchFn = typeof fetch;

/** Ping one target. For supabase, an authed REST request that counts as activity (resets
 * the 7-day pause); for oci, a plain health GET. A 2xx means alive; anything else (or a
 * thrown network error / a paused project returning 5xx) is a failure. */
export async function pingTarget(
  t: KeepaliveTarget,
  fetchFn: FetchFn = fetch,
): Promise<KeepaliveResult> {
  const target = `${t.name}:${t.env}`;
  const kind = t.kind ?? 'supabase';
  const path = t.probePath ?? (kind === 'oci' ? '/' : '/rest/v1/');
  const url = `${t.url.replace(/\/+$/, '')}${path}`;
  // Supabase needs the key to authenticate the REST ping; OCI health is unauthenticated.
  const headers = t.anonKey
    ? { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` }
    : undefined;
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
    // Any HTTP response means the project is awake (the request reset the idle timer) — even
    // a 401 from the PostgREST root. Only a 5xx (paused/broken) or a thrown error is "down".
    return { target, ok: res.status > 0 && res.status < 500, status: res.status };
  } catch (e) {
    return { target, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ping every target concurrently. */
export async function runKeepalive(
  targets: KeepaliveTarget[],
  fetchFn: FetchFn = fetch,
): Promise<KeepaliveResult[]> {
  return Promise.all(targets.map((t) => pingTarget(t, fetchFn)));
}

/** Open a GitHub issue for the failures. No-op (returns false) when there are no
 * failures or the sink isn't configured. */
export async function alertGithubIssue(
  sink: AlertSink,
  failures: KeepaliveResult[],
  fetchFn: FetchFn = fetch,
): Promise<boolean> {
  if (failures.length === 0 || !sink.githubRepo || !sink.githubToken) return false;
  const body = [
    'Greenlight keepalive detected unreachable target(s):',
    '',
    ...failures.map((f) => `- \`${f.target}\` — ${f.status ?? f.error ?? 'unknown'}`),
  ].join('\n');
  const res = await fetchFn(`https://api.github.com/repos/${sink.githubRepo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sink.githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'greenlight-keepalive',
    },
    body: JSON.stringify({
      title: `keepalive: ${failures.length} target(s) failing`,
      body,
      labels: ['keepalive'],
    }),
  });
  return res.ok;
}

/** Parse the `KEEPALIVE_TARGETS` var (a JSON array). Bad/empty input → []. */
export function parseTargets(raw: string | undefined): KeepaliveTarget[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as KeepaliveTarget[]) : [];
  } catch {
    return [];
  }
}

export interface Env {
  /** JSON array of KeepaliveTarget — set by the wrapper at deploy (wrangler var). */
  KEEPALIVE_TARGETS?: string;
  /** github-issue sink repo (owner/repo). */
  ALERT_GITHUB_REPO?: string;
  /** secret with issues:write. */
  GITHUB_TOKEN?: string;
}

// Minimal Workers runtime shapes (avoids a @cloudflare/workers-types dependency).
interface ScheduledController {
  cron: string;
  scheduledTime: number;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

async function sweep(env: Env): Promise<KeepaliveResult[]> {
  const results = await runKeepalive(parseTargets(env.KEEPALIVE_TARGETS));
  for (const r of results) {
    const detail = r.status ? ` (${r.status})` : r.error ? ` ${r.error}` : '';
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.target}${detail}`);
  }
  await alertGithubIssue(
    { githubRepo: env.ALERT_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },
    results.filter((r) => !r.ok),
  );
  return results;
}

export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
  // On-demand trigger (manual run / the verify drill): returns the sweep as JSON.
  async fetch(_req: Request, env: Env): Promise<Response> {
    const results = await sweep(env);
    return new Response(`${JSON.stringify(results, null, 2)}\n`, {
      status: results.length > 0 && results.every((r) => r.ok) ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  },
};
