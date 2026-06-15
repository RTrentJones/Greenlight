# `module "supabase"` — declarative, recreatable Supabase, project-per-env

One `supabase_project` per env (`<name>-beta`, `<name>-prod`), its settings, and its API
keys — declared in full so the database is **reproducible from code**, not a hand-made
project nobody can rebuild. This exists because the original breakdown was a Supabase
project that **silently paused after 7 days idle** and was managed ad-hoc; the fix is
(1) declarative ownership here, (2) keys flowing straight into Vercel env (no manual
copy step), and (3) keepalive (`packages/keepalive`) so it can't pause again.

## Inputs

| var | notes |
|-----|-------|
| `name` | project named `<name>-<env>` |
| `organization_id` | Supabase org slug |
| `database_password` | sensitive; `ignore_changes` so a rotation never replaces the DB |
| `region` | default `us-east-1` |
| `envs` | default `["beta","prod"]` — one project each |
| `instance_size` | default `micro` |
| `legacy_api_keys_enabled` | default `true` (app uses anon/service_role) |

## Outputs

`project_refs`, `urls`, `anon_keys`, `service_role_keys` (all `env => value` maps; keys
are sensitive). The wrapper feeds these into `module "vercel"`'s `environment`.

## Schema is NOT in Terraform — it's in the app repo

Terraform owns the **project**; the **schema** is the app repo's `supabase/migrations`
(+ `seed.sql`). That split is deliberate: Terraform recreates the empty project, the
migrations rebuild the schema. Never hand-edit tables in the dashboard — add a migration.

## Recreate runbook (proves "easy to recreate if it dies again")

If a project is lost/corrupt, rebuild it end to end:

1. **Project** — `terraform apply` (creates `<name>-<env>`; `project_refs`/keys populate).
2. **Schema** — from the app repo, point the Supabase CLI at the new ref and push:
   ```
   supabase link --project-ref "$(terraform output -json supabase_project_refs | jq -r .prod)"
   supabase db push          # replays supabase/migrations
   psql "$DATABASE_URL" -f supabase/seed.sql   # if seeding
   ```
3. **Wiring** — the new keys are already flowing to Vercel via `module "vercel"`
   (`environment` reads these outputs); `terraform apply` updates them. No manual copy.
4. **Liveness** — `packages/keepalive` already targets every `data: supabase` registry
   entry, so the fresh project starts getting pinged immediately.
5. **Verify** — `greenlight verify <name> --env prod` against the live URL.

## Import (first onboarding — don't recreate live data)

To adopt an existing live project instead of creating one, import it into state first:

```
terraform import 'module.<m>.supabase_project.this["prod"]' <live-project-ref>
```

Then `apply` reconciles settings only (the `database_password` change is ignored). Create
the **beta** project fresh (it has no prior data).
