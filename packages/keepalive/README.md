# `@rtrentjones/greenlight-keepalive`

A Cloudflare Worker **Cron Trigger** that pings every `data: supabase` project so it never
hits Supabase's **7-day idle pause** (the failure that took HeistMind down), and opens a
GitHub issue (the `alerts.sink`) if a project stops responding. A Worker cron is used so it
is **immune to GitHub's "disable scheduled workflows after repo inactivity"** rule.

## Deploy (from the wrapper repo)

```sh
# vars: the projects to ping + the alert repo
wrangler deploy \
  --var KEEPALIVE_TARGETS:"$(terraform -chdir=infra output -json keepalive_targets)" \
  --var ALERT_GITHUB_REPO:"<owner>/<site-repo>"
# secret: a token with issues:write on ALERT_GITHUB_REPO
wrangler secret put GITHUB_TOKEN
```

`KEEPALIVE_TARGETS` is a JSON array of `{ name, env, url, anonKey, probePath? }`. The
wrapper's Terraform emits it from the `module "supabase"` outputs, so adding a Supabase
tool to the registry automatically extends keepalive coverage. **Never commit these values.**

## Verify / on-demand run

The Worker also exposes a `fetch` handler that runs the sweep immediately and returns the
results as JSON (200 if all alive, 503 otherwise) — used by the recreate drill and for a
manual health check.

## Schedule

Every 3 days at 06:00 UTC (`wrangler.jsonc` → `triggers.crons`), comfortably inside the
7-day window. Tune there.
