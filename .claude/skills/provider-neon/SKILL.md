---
name: provider-neon
description: How Neon works in a Greenlight setup — the `data: neon` store (serverless Postgres), git-style branch-per-env, scale-to-zero + auto-resume (so NO keepalive, unlike Supabase), pooled vs direct connection strings, the NEON_API_KEY, and migrations on a branch. Use when wiring a tool's database, choosing Neon vs Supabase, or a Neon apply.
---

# provider-neon

`data: neon` is the **default Postgres** — for tools that need a SQL database and nothing else
bundled. One Neon **project** per tool, **a branch per env** (git-style copy-on-write): `prod` is
the project's default branch; `beta` is a child branch (separate data, instant to create). Compute
**autosuspends and auto-resumes on the next connection**, so a Neon tool needs **no keepalive** —
that's the whole reason Neon is preferred over Supabase, which pauses for 7 days and needs a manual
unpause. Choose `supabase` only when you need bundled auth + storage + realtime together.

## Token — `NEON_API_KEY`

Console → Account settings → API keys. Account-level (configures the `neon` provider for every Neon
tool, like `CLOUDFLARE_API_TOKEN`) — **not** per-tool. `greenlight add` verifies it against
`/api/v2/projects` (HTTP 200). There is **no per-tool secret**: the role/password/connection strings
are module OUTPUTS, not inputs.

## Terraform module — `infra/modules/neon`

Creates the project (default branch = prod) + a `neon_branch` per non-prod env (except `preview`,
which is ephemeral/per-PR — created by CI, not Terraform). Outputs two per-env maps:
- **`database_url[env]`** — the **pooled** (pgbouncer) string → `DATABASE_URL` for the serverless app.
- **`direct_url[env]`** — the **direct** string → `DIRECT_URL` for migrations.

The emitted `<name>.tf` wires `database_url["prod"]`/`["beta"]` into the Vercel env per target, so
prod and beta hit **different branches**. Pin the provider `kislerdm/neon ~> 0.13`.

## No keepalive

Do **not** add a Neon tool to `module.keepalive.targets_json`. Neon resumes on connect — a request
just wakes it. (`doctor` does not flag `data: neon` for keepalive; that exemption is intentional.)

## Migrations

Run migrations against the env's **branch** (`DIRECT_URL`). A PR's ephemeral branch is the safe place
to test a migration before it touches prod. Gate them with `greenlight migrations scan` (the
dangerous-SQL pre-apply check) in the tool's CI.

## MCP

`.mcp.json` wires `neon` (hosted) with `Authorization: Bearer ${NEON_API_KEY}`. Run `/mcp` to auth.

## Rule
The **blog must never use a database** that can pause — but Neon's auto-resume makes it safe for
*tools*; still, the apex blog stays `data: none` (D1/KV/external only). Neon is per-tool Postgres.
