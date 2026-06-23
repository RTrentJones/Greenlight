/**
 * Greenlight keepalive — a Cloudflare Worker Cron Trigger that keeps `data: supabase`
 * projects from hitting Supabase's 7-day idle pause (the failure that took HeistMind
 * down) and health-checks `target: oci` services, alerting via the `github-issue` sink
 * if anything stops responding.
 *
 * A Worker cron (not a GitHub Actions schedule) is used deliberately: it's immune to
 * GitHub's "disable scheduled workflows after 60 days of repo inactivity" rule
 * (docs/archive/greenlight-v1.md §6). The pure functions below are unit-tested; the Worker's
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
  /** Opt this (oci) target into AUTO-remediation: on failure, fire a repository_dispatch so the
   * wrapper re-applies + redeploys it (vs only alerting). See dispatchRemediation. */
  remediate?: boolean;
}

/** @deprecated use KeepaliveTarget. */
export type SupabaseTarget = KeepaliveTarget;

export interface KeepaliveResult {
  /** `name:env`. */
  target: string;
  /** The tool name + env, carried through so a sink can build the dispatch event/payload. */
  name?: string;
  env?: string;
  /** Whether this target opted into auto-remediation. */
  remediate?: boolean;
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
  const base = { target, name: t.name, env: t.env, remediate: t.remediate };
  const kind = t.kind ?? 'supabase';
  const path = t.probePath ?? (kind === 'oci' ? '/' : '/rest/v1/');
  const url = `${t.url.replace(/\/+$/, '')}${path}`;
  // Supabase needs the key to authenticate the REST ping; OCI health is unauthenticated.
  const headers = t.anonKey
    ? { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` }
    : undefined;
  try {
    // INVARIANT (locked by a test): this is a READ-ONLY probe — no `method`/`body`, so it's a plain
    // GET. The supabase ping must never write/INSERT; resetting the 7-day idle timer only needs a
    // read. A regression that adds a body/write here would mutate the user's DB on every cron tick.
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
    // Any HTTP response means the project is awake (the request reset the idle timer) — even
    // a 401 from the PostgREST root. Only a 5xx (paused/broken) or a thrown error is "down".
    return { ...base, ok: res.status > 0 && res.status < 500, status: res.status };
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
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

export interface RemediateSink {
  /** owner/repo to fire `repository_dispatch` at (the wrapper that owns the infra + deploy). */
  dispatchRepo?: string;
  /** token with `contents: write` on the dispatch repo (the dispatch endpoint requires it — a
   * superset of the `issues: write` the alert sink needs; one PAT can hold both). */
  githubToken?: string;
}

/** Fire a `repository_dispatch` for each failed target that opted into auto-remediation
 * (`kind:"oci"`, `remediate:true`). The wrapper's `greenlight-remediate-<tool>.yml` listens on
 * `remediate-<tool>` and re-applies + redeploys + re-verifies. No-op (returns 0) when the sink
 * isn't configured or nothing is remediable.
 *
 * Anti-flap is handled downstream, not here: the remediate workflow shares the deploy job's
 * `concurrency: deploy-<tool>` group, so dispatches never overlap a deploy or each other, and
 * re-applying an already-healthy instance is an idempotent no-op (terraform finds no diff). The
 * alert issue is still opened in parallel for an audit trail. */
export async function dispatchRemediation(
  sink: RemediateSink,
  failures: KeepaliveResult[],
  fetchFn: FetchFn = fetch,
): Promise<number> {
  if (!sink.dispatchRepo || !sink.githubToken) return 0;
  const remediable = failures.filter((f) => f.remediate && f.name);
  let fired = 0;
  for (const f of remediable) {
    const res = await fetchFn(`https://api.github.com/repos/${sink.dispatchRepo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sink.githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'greenlight-keepalive',
      },
      body: JSON.stringify({
        event_type: `remediate-${f.name}`,
        client_payload: { tool: f.name, env: f.env, reason: f.status ?? f.error ?? 'unreachable' },
      }),
    });
    if (res.ok) fired++;
  }
  return fired;
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
  /** secret with issues:write (+ contents:write if DISPATCH_GITHUB_REPO is set). */
  GITHUB_TOKEN?: string;
  /** owner/repo to fire `repository_dispatch` at for auto-remediation. Omit to disable self-heal
   * (alert-only). Usually the wrapper repo itself. */
  DISPATCH_GITHUB_REPO?: string;
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
  const failures = results.filter((r) => !r.ok);
  // Audit trail (always) + self-heal (for opted-in oci targets). Both no-op when unconfigured.
  await alertGithubIssue(
    { githubRepo: env.ALERT_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },
    failures,
  );
  const fired = await dispatchRemediation(
    { dispatchRepo: env.DISPATCH_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },
    failures,
  );
  if (fired > 0) console.log(`dispatched ${fired} remediation(s)`);
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
