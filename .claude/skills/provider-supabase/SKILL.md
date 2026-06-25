---
name: provider-supabase
description: How Supabase works in a Greenlight setup — the `data: supabase` store (Postgres + auth + storage + realtime), single-project-schema-per-env model, the pause trap solved by keepalive, Management API token, and the read-only Supabase MCP. Use when wiring a tool's database, debugging a paused project, or a Supabase apply.
---

# provider-supabase

`data: supabase` is for tools that need bundled **auth + storage + realtime** together
(HeistMind). One Supabase **project**, **schema-per-env** (beta/prod share the project —
NOT project-per-env; branching is paid). The project is **imported** (not recreated):
name/region are replace-forcing, so the module sets `ignore_changes` to protect the live DB.

## Token — `SUPABASE_ACCESS_TOKEN`

Dashboard → Account → Access Tokens (Management API). Push it straight to GitHub Actions with
`greenlight secrets gather` (or `gh secret set`) — Greenlight keeps no local secret file.
`greenlight add` verifies it against `/v1/projects` (HTTP 200). The DB password
(`TF_VAR_supabase_database_password`) is only used if the project is recreated — ignored on
import, so `import-placeholder` is fine for an existing project.

## Terraform module — `infra/modules/supabase`

Single project, import-safe. Outputs `url`, `anon_key`, `service_role_key`, `project_ref` —
feed these straight into the consumer (e.g. the Vercel env block). To re-apply from fresh
state, import first: `terraform import module.<name>_supabase.supabase_project.this <ref>`.

## Keepalive — non-negotiable

Supabase **pauses a free project after ~7 days idle** — this is what takes tools down. The
**keepalive** Worker (cloudflare) pings the project on a cron. Add the tool to the aggregated
`module.keepalive.targets_json`: `{ name, env, url = module.<name>_supabase.url, anonKey = … }`.
The ping counts any HTTP response (even 401 on `/rest/v1/`) as alive.

## MCP

`.mcp.json` wires `supabase` (hosted, **read-only**): needs `SUPABASE_ACCESS_TOKEN` +
`SUPABASE_PROJECT_REF` in the env (Claude Code expands `${VAR}` in the url/header). Run `/mcp`.

## Rule
The **blog must never use Supabase** for state (it must stay up unattended) — use D1/KV or
external services. Supabase is per-tool, only when the bundled features are needed together.
