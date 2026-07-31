---
name: provider-supabase
description: Supabase in a Greenlight setup — the `data: supabase` store (Postgres + auth + storage + realtime), schema-per-env, the 7-day pause trap solved by keepalive. Use when wiring a tool's database, debugging a paused project, or a Supabase apply.
---

# provider-supabase

`data: supabase` is for tools that need bundled **auth + storage + realtime** together
(HeistMind). One Supabase **project**, **schema-per-env** (beta/prod share the project — NOT
project-per-env; branching is paid). The project is **imported**, not recreated: name/region are
replace-forcing, so the module sets `ignore_changes` to protect the live DB.

## Token — `SUPABASE_ACCESS_TOKEN`

Creation + verify live in
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).
Management API PAT, **account-scoped** (it manages every project in the account — keep it tight).
Single store: GitHub Actions secrets. The DB password (`TF_VAR_supabase_database_password`) is only
used if the project is *recreated* — ignored on import, so `import-placeholder` is fine for an
existing project.

## Terraform module — `infra/modules/supabase`

Single project, import-safe. Outputs `url`, `anon_key`, `service_role_key`, `project_ref` — feed
these straight into the consumer (e.g. the Vercel env block). To re-apply from fresh state, import
first: `terraform import module.<name>_supabase.supabase_project.this <ref>`.

## Keepalive — non-negotiable

Supabase **pauses a free project after ~7 days idle** — this is what takes tools down. The
**keepalive** Worker (cloudflare) pings the project on a cron. Add the tool to the aggregated
`module.keepalive.targets_json`: `{ name, env, url = module.<name>_supabase.url, anonKey = …,
probeTable = "<table>" }`.

**`probeTable` is required, and the choice matters.** Supabase measures *database* activity, not
HTTP traffic, so the probe has to run a query that reaches Postgres — it issues
`GET /rest/v1/<probeTable>?select=*&limit=1`. Pinging the PostgREST root (`/rest/v1/`) does **not**
work: PostgREST answers it from its in-memory schema cache without touching the database, so the
idle timer keeps running. (That is exactly how heistmind-db was paused in 2026-07 while keepalive
reported healthy.) Pick a table the `anon` role can `SELECT`; RLS returning zero rows is fine — the
query still executed. Add `probeSchema` when the table lives outside `public` (schema-per-env), and
`probeSelect` to keep row data off the wire.

Only a **2xx** counts as alive for supabase targets: a 401/403/404 means the key is dead or the
table is wrong, i.e. no query ran, so it alerts instead of passing silently. (`oci` targets keep the
lenient rule — a 401 from an auth-gated endpoint still proves the service is serving.)

## MCP
`.mcp.json` wires `supabase` (hosted, **read-only**): needs `SUPABASE_ACCESS_TOKEN` +
`SUPABASE_PROJECT_REF` in the env (Claude Code expands `${VAR}` in the url/header). Run `/mcp`.

## Gotchas
- **The blog must never use Supabase** for state (it must stay up unattended) — use D1/KV or
  external services. Supabase is per-tool, only when the bundled features are needed together.
- **Migrations gate.** A supabase tool that owns `supabase/migrations` must run `greenlight
  migrations scan` in the CI that applies them (before `supabase db push`) — `doctor` flags a
  migrations dir whose workflows don't.
- **Forgetting keepalive** is the #1 silent-death cause for a supabase tool — `doctor` does not yet
  assert it, so wire `targets_json` when you add the tool.
