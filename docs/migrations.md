# Migrations & schema-as-code

Greenlight provides a **dangerous-SQL gate** and wires the connection strings — it does **not execute
migrations**. That's deliberate: migration execution belongs to the tool's own build (its ORM /
runner), and ephemeral branching belongs to the native platform integration. Greenlight orchestrates
the loop; your stack owns the schema.

## The model

| concern | who owns it |
|---|---|
| **Schema definition** | the tool — an ORM (Drizzle/Prisma) or plain `.sql` migrations in the repo |
| **Stable branches** (prod, beta) | the Terraform module (`data: neon` → one project, a branch per env) |
| **Ephemeral preview branches** (per-PR) | the native **Neon↔Vercel** integration (not Terraform) |
| **Connection strings** | Greenlight wires `DATABASE_URL` (pooled) + `DIRECT_URL` (direct) per env |
| **Migration execution** | the **app's own build** — `drizzle-kit migrate` / `prisma migrate deploy` / `psql`, against `DIRECT_URL` |
| **The safety gate** | Greenlight — `greenlight migrations scan` in CI before the migrate |

## How a deploy creates / edits tables

1. Define the schema as code in the tool (Drizzle/Prisma schema + generated SQL, or `*.sql`).
2. The app's build runs its migrate using the wired `DIRECT_URL`. Per env the URL points at that env's
   branch — prod build → prod branch, preview build → that PR's branch — so each env migrates its own
   data. A failed migrate fails the build, so a broken migration never reaches users.
3. Gate it: run `greenlight migrations scan` (no `<dir>` → it auto-detects `supabase/migrations`,
   `migrations`, `drizzle/migrations`, `drizzle`, `db/migrations`) **before** the migrate. It
   fails on data-destroying ops (DROP/TRUNCATE/DELETE- or UPDATE-without-WHERE) and warns on lock-heavy
   ones; acknowledge an intentional op with an inline `-- greenlight:allow`.

### Where to wire the scan (and where `doctor` looks for it)

The scan must run **immediately before the apply**, which lives in a different place per deploy style:

- **The tool applies in its own build** (a Vercel-git tool whose `build` runs the migrate) → put the
  scan first in the tool's `package.json` build/migrate script, so a bad migration fails the build
  before it touches the DB:
  ```jsonc
  // tools/<name>/package.json
  "migrate": "greenlight migrations scan && node scripts/migrate.mjs",
  "build":   "pnpm run migrate && next build"
  ```
- **A workflow applies** (`supabase db push` / a `psql` deploy job) → add the scan as a step (or a
  gating job the apply `needs:`) in that workflow, before the apply step.

`greenlight doctor` recognizes **either** placement — it treats a `data: supabase|neon` tool's
migrations gate as wired if `greenlight migrations scan` appears in the tool's (or wrapper's)
`.github/workflows/*` **or** in the tool's `package.json` scripts. A migrations dir with neither is
flagged `warn` (`<tool>: migrations gate`).

## Manual approval before prod migrations (`requireMigrationApproval`)

The scan is an automated tripwire, not a human sign-off. For a destructive-but-intentional change you
may want a person to **approve** before prod migrates. Set `requireMigrationApproval: true` on the
tool (or pass `--require-migration-approval` to `adopt`); Greenlight then emits a dedicated, gated
migrate workflow `greenlight-migrate-<name>.yml` that:

1. runs under the **`<name>-prod` GitHub Environment** — so GitHub **pauses the job for a required
   reviewer to approve** before anything runs;
2. runs `greenlight migrations scan --strict` (scan still gates, now `warn`s block too);
3. applies the migration against the prod `DIRECT_URL` (you fill in the migrate command).

Two wiring steps make the gate real:

- **Required reviewers on `<name>-prod`.** If the tool's infra manages its GitHub environments, set
  `prod_reviewers = ["your-github-username"]` on its `tool` module (it adds an approval rule to the
  prod environment only). For an **external** tool (the wrapper doesn't manage that repo's
  environments), add the reviewers in the tool repo's **Settings → Environments → `<name>-prod`**.
- **Move migrate out of the app build.** A Vercel-git tool that migrates *inside* its build can't be
  paused by a GitHub Environment (the build runs on Vercel). Move the migrate into this gated Actions
  job (against `DIRECT_URL`) and drop it from the build, so the only path to prod schema changes is
  the approved job. `greenlight doctor` warns (`<tool>: migration approval`) if the flag is set but
  the migrate workflow is missing.

## Why not a Greenlight migrations runner?

Mature tools (Drizzle/Prisma/Atlas) and the native integrations already do branching + execution well;
a runner would reinvent them and pull a DB-client dependency into the CLI. Greenlight stays the infra +
verification orchestrator. (Same story for `data: supabase` — its migrations run via the Supabase CLI /
the app, scan-gated the same way.)
