// src/index.ts
async function pingTarget(t, fetchFn = fetch) {
  const target = `${t.name}:${t.env}`;
  const base = { target, name: t.name, env: t.env, remediate: t.remediate };
  const kind = t.kind ?? "supabase";
  const path = t.probePath ?? (kind === "oci" ? "/" : "/rest/v1/");
  const url = `${t.url.replace(/\/+$/, "")}${path}`;
  const headers = t.anonKey ? { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` } : void 0;
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(1e4) });
    return { ...base, ok: res.status > 0 && res.status < 500, status: res.status };
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
async function runKeepalive(targets, fetchFn = fetch) {
  return Promise.all(targets.map((t) => pingTarget(t, fetchFn)));
}
async function alertGithubIssue(sink, failures, fetchFn = fetch) {
  if (failures.length === 0 || !sink.githubRepo || !sink.githubToken) return false;
  const auth = {
    Authorization: `Bearer ${sink.githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "greenlight-keepalive"
  };
  const open = await fetchFn(
    `https://api.github.com/repos/${sink.githubRepo}/issues?state=open&labels=keepalive&per_page=1`,
    { headers: auth }
  ).catch(() => null);
  if (open?.ok) {
    const issues = await open.json().catch(() => []);
    if (Array.isArray(issues) && issues.length > 0) return false;
  }
  const body = [
    "Greenlight keepalive detected unreachable target(s):",
    "",
    ...failures.map((f) => `- \`${f.target}\` \u2014 ${f.status ?? f.error ?? "unknown"}`)
  ].join("\n");
  const res = await fetchFn(`https://api.github.com/repos/${sink.githubRepo}/issues`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `keepalive: ${failures.length} target(s) failing`,
      body,
      labels: ["keepalive"]
    })
  });
  return res.ok;
}
async function dispatchRemediation(sink, failures, fetchFn = fetch) {
  if (!sink.dispatchRepo || !sink.githubToken) return 0;
  const remediable = failures.filter((f) => f.remediate && f.name);
  const fired = await Promise.all(
    remediable.map(
      (f) => fetchFn(`https://api.github.com/repos/${sink.dispatchRepo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sink.githubToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "greenlight-keepalive"
        },
        body: JSON.stringify({
          event_type: `remediate-${f.name}`,
          client_payload: {
            tool: f.name,
            env: f.env,
            reason: f.status ?? f.error ?? "unreachable"
          }
        })
      }).then((res) => res.ok).catch(() => false)
    )
  );
  return fired.filter(Boolean).length;
}
function parseTargets(raw) {
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
    const detail = r.status ? ` (${r.status})` : r.error ? ` ${r.error}` : "";
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.target}${detail}`);
  }
  const failures = results.filter((r) => !r.ok);
  const [, fired] = await Promise.all([
    alertGithubIssue(
      { githubRepo: env.ALERT_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },
      failures
    ),
    dispatchRemediation(
      { dispatchRepo: env.DISPATCH_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },
      failures
    )
  ]);
  if (fired > 0) console.log(`dispatched ${fired} remediation(s)`);
  return results;
}
var index_default = {
  async scheduled(_c, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
  // On-demand trigger (manual run / the verify drill): returns the sweep as JSON.
  async fetch(_req, env) {
    const results = await sweep(env);
    return new Response(`${JSON.stringify(results, null, 2)}
`, {
      status: results.length > 0 && results.every((r) => r.ok) ? 200 : 503,
      headers: { "content-type": "application/json" }
    });
  }
};
export {
  alertGithubIssue,
  index_default as default,
  dispatchRemediation,
  parseTargets,
  pingTarget,
  runKeepalive
};
