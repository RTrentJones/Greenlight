# `module "supabase"` — one declarative, recreatable project (schema-per-env)

Owns a **single** Supabase project, its settings, and its API keys — declared in full so
the database is **reproducible from code** rather than a hand-made project nobody can
rebuild. This exists because the original breakdown was a Supabase project that **silently
paused after 7 days idle** and was managed ad-hoc.

**Env model:** one project, **isolation by schema** (a `beta` schema + the prod schema) —
Supabase branching is paid and the free tier is one project, so project-per-env isn't the
model. Schemas live in the app repo's `supabase/migrations`; this module owns the project
and which schemas the API exposes (`api_db_schema`). The fix has three legs: declarative
ownership here, keys flowing straight into Vercel env (no manual copy), and keepalive
(`packages/keepalive`) so it can't pause again.

## Inputs

| var | notes |
|-----|-------|
| `name` | label / keepalive target name |
| `project_name` | **exact** existing name on import (e.g. `heistmind-db`) — name is replace-forcing |
| `organization_id` | Supabase org slug |
| `database_password` | sensitive; set on create, `ignore_changes` on update |
| `region` | default `us-east-1`; replace-forcing — match the existing project |
| `instance_size` | default `micro` |
| `legacy_api_keys_enabled` | default `true` (app uses anon/service_role) |
| `api_db_schema` | schemas PostgREST exposes; add a `beta` schema here for schema-per-env |

## Outputs

`project_ref`, `url`, `anon_key`, `service_role_key` (keys sensitive). The wrapper feeds
these into `module "vercel"`'s `environment_values` for both targets.

## Schema is NOT in Terraform — it's in the app repo

Terraform owns the **project**; the **schemas/tables** are the app repo's
`supabase/migrations` (+ `seed.sql`). Recreate provisions the empty project; migrations
rebuild the schema. Never hand-edit in the dashboard — add a migration.

## Import (onboarding — don't recreate live data)

`name`/`region`/`instance_size` are replace-forcing and the resource sets
`ignore_changes` on them, so import an existing project and `apply` reconciles **settings
only** — it will never destroy the database:

```
terraform import 'module.<m>.supabase_project.this' <live-project-ref>
```

Match `project_name` + `region` to the live project before importing.

## Recreate runbook (proves "easy to recreate if it dies again")

1. **Project** — `terraform apply` (creates it; `project_ref`/keys populate).
2. **Schema** — from the app repo: `supabase link --project-ref <new-ref>` → `supabase db
   push` (replays migrations) → seed if needed.
3. **Wiring** — keys already flow to Vercel via `module "vercel"`; `apply` updates them.
4. **Liveness** — `packages/keepalive` targets it immediately.
5. **Verify** — `greenlight verify <name> --env prod`.
