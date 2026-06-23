# Phase 8 — Keepalive (implementation plan)

> **Parent:** [greenlight-v1.md](greenlight-v1.md) §16 Phase 8 (and §6 liveness, §13 data model). **Goal of this doc:** the concrete, ordered build plan for keepalive — what to create, in what order, and how we know it's done.

## Objective

Make Greenlight tools **stay alive on their own**. The load-bearing failure this phase fixes is **Supabase's 7-day idle pause** (it took HeistMind down) and, secondarily, **OCI service health**. Deliver a **Cloudflare Worker Cron Trigger** that pings every `data: supabase` project (an authed REST call that counts as activity, resetting the pause) and health-checks every `target: oci` service, **alerting via the `alerts.sink`** (`github-issue`) on failure. The worker is **deployed as code** (Terraform) and **configured from the wrapper**, not by a hand-run `wrangler deploy`.

A Worker cron — not a GitHub Actions schedule — is deliberate: it is **immune to GitHub's "disable scheduled workflows after repo inactivity"** rule (§6).

**Not solved by keepalive:** OCI Always-Free **idle-reclaim**. Pings don't count — only account standing does. That's a manual **PAYG + budget-alarm** runbook ([oci-payg-runbook.md](oci-payg-runbook.md)); the harness only nags via `doctor`.

## Decisions — LOCKED

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Scheduler | **Cloudflare Worker Cron** ✅ | Immune to GitHub's inactivity auto-disable; same plane as the rest of the stack. |
| D2 | Probes | **supabase (authed REST) + oci (health GET)** ✅ | Supabase needs a real authed request to reset the pause; OCI just needs liveness. One `KeepaliveTarget` with `kind`. |
| D3 | Deployment | **Terraform** (`cloudflare_workers_script` + `cloudflare_workers_cron_trigger`) ✅ | IaC, declarative, recreatable — not a one-off `wrangler deploy`. |
| D4 | Configuration | **In the wrapper** ✅ | Targets (from the `module "supabase"` outputs), alert repo, schedule are set in the wrapper's infra — the registry is the source of truth for *which* tools get kept alive. |
| D5 | Supabase env model | **One project, schema-per-env** ✅ | Free tier is one project; HeistMind uses a single `heistmind-db`. Keepalive pings the one project. |
| D6 | OCI idle-reclaim | **PAYG runbook, not pings** ✅ | Reclaim is not traffic-based; only converting the tenancy to Pay-As-You-Go stops it. |
| D7 | Alert sink | **`github-issue`** (token-gated) ✅ | Reuses `alerts.sink`; an optional `GITHUB_TOKEN` secret binding. No token → alerts no-op, pings still run. |

## Build plan (ordered)

1. **The worker** — `packages/keepalive`: pure, unit-tested `pingTarget` / `runKeepalive` / `alertGithubIssue` / `parseTargets` + the `scheduled`/`fetch` handlers. `tsup` emits a single-file ESM bundle (`dist/index.js`) for Terraform to upload.
2. **The IaC module** — `infra/modules/keepalive`: `cloudflare_workers_script` (`content` = the bundle, `main_module`, `KEEPALIVE_TARGETS`/`ALERT_GITHUB_REPO` as `plain_text` bindings, `GITHUB_TOKEN` as an optional `secret_text`) + `cloudflare_workers_cron_trigger`. Mock-provider `tftest`.
3. **doctor** — a pure **keepalive coverage** check listing tools that need it (`data:supabase` / `target:oci`). The *live* checks (keepalive health, OCI PAYG status, billing-alarm presence) stay `skip` until wired to creds.
4. **The runbook** — `docs/oci-payg-runbook.md`: the manual OCI → PAYG + budget-alarm steps.
5. **Wrapper config** — `RTrentJones.dev/infra`: `module "keepalive"` (by `?ref`) with `targets_json` built from the `module "supabase"` outputs, `alert_github_repo`, `cron`. This is the "configured in the wrapper" piece.
6. **Apply (gated)** — `terraform apply` deploys the worker + cron. Needs a Cloudflare token with **Workers Scripts: Edit** (includes cron triggers).

## Status

- **Built (1–4):** worker (both probes) + IaC module + doctor coverage + runbook — unit-tested + mock-tested; on `main` at `v0.2.1`.
- **In progress (5):** wrapper `module "keepalive"` configuration.
- **Gated (6):** the live `apply` needs a Workers-scoped Cloudflare token (the current `CLOUDFLARE_API_TOKEN` lacks cron permission — a hand `wrangler deploy` failed on the schedule API, confirming the scope gap). Live `doctor` checks + an OCI tool (BAMCP, Phase 9b) remain.

## Verification (how we know it's done)

- `pnpm test packages/keepalive` green (probe behavior incl. the oci no-auth path; alert posts the right issue; only-on-failure).
- `pnpm run infra:test` green — the `keepalive` module plans under mock providers (script name + cron asserted).
- `greenlight doctor` reports `keepalive coverage` listing the supabase/oci tools.
- **Live (post-apply):** the worker exists with a cron trigger; its `fetch` handler returns `200` (all targets alive); a forced-failure target opens a GitHub issue; HeistMind's `heistmind-db` survives a 7-day window.

## Out of scope (later)

- Live `doctor` checks (keepalive health, OCI PAYG status, billing-alarm presence) — need provider creds.
- The OCI probe is built but unexercised until **BAMCP** is adopted (Phase 9b, needs the oci deploy adapter).
- Multi-tool keepalive beyond HeistMind (the module already fans out over `KEEPALIVE_TARGETS`).
