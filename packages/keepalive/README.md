# `@rtrentjones/greenlight-keepalive`

A Cloudflare Worker **Cron Trigger** that keeps Greenlight tools alive:

- **`data: supabase`** — an authenticated REST ping that counts as activity, so the project
  never hits Supabase's **7-day idle pause** (the failure that took HeistMind down).
- **`target: oci`** — a plain health `GET`, alerting if the service is down.

On any failure it opens a GitHub issue (the `alerts.sink`). A Worker cron is used so it is
**immune to GitHub's "disable scheduled workflows after repo inactivity"** rule.

> **OCI note:** keepalive does **not** prevent OCI Always-Free idle-reclaim — that needs the
> tenancy on Pay-As-You-Go. See [docs/oci-payg-runbook.md](../../docs/oci-payg-runbook.md).
> For OCI, keepalive only health-checks + alerts.

## Deployed as code (not `wrangler deploy`)

The Worker is deployed by Terraform — `infra/modules/keepalive` (`cloudflare_workers_script`
+ `cloudflare_workers_cron_trigger`). The wrapper configures it:

- `content` = this package's built bundle (`pnpm --filter @rtrentjones/greenlight-keepalive build` → `dist/index.js`).
- `targets_json` = `KEEPALIVE_TARGETS`, one `{ name, env, url, kind?, anonKey?, probePath? }` per
  `data:supabase` / `target:oci` tool (the wrapper builds this from the supabase module outputs).
- `alert_github_repo` + an optional `github_token` secret for the issue sink.
- `cron` (default every 3 days at 06:00 UTC — inside the 7-day window).

The Cloudflare token used for `apply` needs **Workers Scripts: Edit** (which includes cron
triggers).

## Local test

`wrangler dev` runs it locally; the `fetch` handler runs the sweep on demand and returns the
results as JSON (200 if all alive, 503 otherwise). The pure functions (`pingTarget`,
`runKeepalive`, `alertGithubIssue`) are unit-tested.
