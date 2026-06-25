---
name: provider-neon
description: Neon in a Greenlight setup — the `data: neon` store (serverless Postgres, branch-per-env, auto-resume → no keepalive). Use when wiring a tool's database, choosing Neon vs Supabase, or debugging a Neon apply or connection string.
---

# provider-neon

`data: neon` is the **default Postgres** — for tools that need a SQL database and nothing else
bundled. One Neon **project** per tool, **a branch per env** (git-style copy-on-write): `prod` is
the project's default branch; `beta` is a child branch (separate data, instant to create). Compute
**autosuspends and auto-resumes on the next connection**, so a Neon tool needs **no keepalive** —
that's the whole reason Neon is preferred over Supabase (which pauses for 7 days and needs a manual
unpause). Choose `supabase` only when you need bundled auth + storage + realtime together.

## Token — `NEON_API_KEY`

Creation + verify live in
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).
Account-level (configures the `neon` provider for every Neon tool, like `CLOUDFLARE_API_TOKEN`) —
**not** per-tool, and there is **no per-tool secret**: the role/password/connection strings are
module OUTPUTS, not inputs.

## Terraform module — `infra/modules/neon`

Creates the project (default branch = prod) + a `neon_branch` per non-prod env (except `preview`,
which is ephemeral/per-PR — created by CI, not Terraform). Outputs two per-env maps:
- **`database_url[env]`** — the **pooled** (pgbouncer) string → `DATABASE_URL` for the serverless app.
- **`direct_url[env]`** — the **direct** string → `DIRECT_URL` for migrations.

The emitted `<name>.tf` wires `database_url["prod"]`/`["beta"]` into the Vercel env per target, so
prod and beta hit **different branches**. Pin the provider `kislerdm/neon ~> 0.13`.

## Schema as code / migrations

**Greenlight does NOT run migrations — by design.** Schema lives in the tool (Drizzle/Prisma or
plain `.sql`); the app's own build runs its migrate against the wired **`DIRECT_URL`** (prod build →
prod branch, preview build → preview branch; a failed migrate fails the build = a natural gate). The
**native Neon↔Vercel integration** owns ephemeral per-PR preview branches (don't put those in
Terraform). Greenlight's only role is the **dangerous-SQL gate**: run `greenlight migrations scan`
(auto-detects `supabase/migrations | migrations | drizzle/migrations | …`) in CI before the migrate.
See [migrations.md](https://github.com/RTrentJones/greenlight/blob/main/docs/migrations.md).

## Sharing one DB + multi-account
- **One DB, many services:** a second tool sets `dataShareWith: '<owner>'` (or `add … --share <owner>`)
  — it creates no project and wires the owner's connection strings.
- **A second Neon account:** `tokenOverrides: { NEON_API_KEY: 'NEON_API_KEY_X' }` → an aliased `neon`
  provider authenticates that account. (A sharer can't also override.)

## MCP
`.mcp.json` wires `neon` (hosted) with `Authorization: Bearer ${NEON_API_KEY}`. Run `/mcp` to auth.

## Gotchas
- **Free-tier `history_retention_seconds` cap (21600).** Neon's free plan caps history retention at
  **21600s (6h)** — the module must not request more or the apply 400s. Point-in-time restore is
  bounded to that window on free.
- **`pooler_enabled` is a non-issue.** Both connection strings are module outputs regardless — wire
  `database_url` (pooled) to the app and `direct_url` to migrations; there's no pooler flag to toggle.
- **No keepalive.** Don't add a Neon tool to `module.keepalive.targets_json` — it resumes on connect,
  and `doctor` intentionally does not flag `data: neon` for keepalive.
- **The blog stays `data: none`.** Neon's auto-resume makes it safe for *tools*, but the apex blog
  uses D1/KV/external only (it must never depend on a store that can pause or error).
