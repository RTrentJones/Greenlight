---
name: provider-vercel
description: Vercel in a Greenlight setup — the default target for the `next` lane (configure-existing-project: domains + env vars by project_id; deploys ride git integration). Use when wiring a next/vercel tool, env vars, domains, or debugging a Vercel deploy or verify.
---

# provider-vercel

Vercel is the default `target` for the `next` lane. Greenlight does **not** create or deploy the
project — it **configures an existing** Vercel project (domains + environment variables) by
`project_id`, and the app's own repo deploys via Vercel's **git integration** (push → build). The
wrapper owns infra; the tool repo owns deploys.

## Token — `VERCEL_API_TOKEN`

Creation + verify live in
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).
**Scope it to the team** that owns the project (the Terraform `vercel` provider also takes the
`team_…` id). Single store: GitHub Actions secrets.

## Terraform module — `infra/modules/vercel`

Manages the **existing** project (nothing to import — it configures by id):
- `domain` → adds `<name>.<domain>` (production) + `beta.<name>.<domain>` (preview/`beta_branch`).
- `environment` + `environment_values` → env vars per target (`production` / `preview`). Wire
  Supabase/Neon creds straight from those modules' outputs — no manual copy (that copy was the old
  fragility).

The DNS CNAME is the **cloudflare** `tool` module, unproxied (`proxied = false`) → `cname.vercel-dns.com`.

## The verify loop — tool-CI on `deployment_status`

Because Vercel deploys (not the wrapper), the verify gate runs in the **tool repo's own CI**.
`greenlight adopt … --target vercel` emits, into the tool repo:
- **`.github/workflows/greenlight-verify.yml`** — triggers on GitHub's **`deployment_status`** event
  (Vercel posts a deployment + `target_url`); on `state == success` it runs
  `npx @rtrentjones/greenlight verify --url <target_url> --spec verify/<name>.config.ts`. The result
  is a check on the commit — no wrapper round-trip, no dispatch/status PATs.
- **`verify/<name>.config.ts`** — a verifyAll array: `api` + `test` (the tool's suite) + `agent-web`
  (LLM drives the live UI), where agent-web is **config-gated on `ANTHROPIC_API_KEY`** (omitted when
  unset → the gate stays green on api + test alone).

`greenlight verify --url <url> --spec <path>` is the **manifest-free** mode that makes this work
without carrying the wrapper's `greenlight.config.ts` into the tool repo.

## MCP
`.mcp.json` wires `vercel` (hosted, OAuth, read-only). Run `/mcp` and authenticate in the browser —
read deployments, build logs, runtime logs, projects.

## Gotchas
- **`ENV_CONFLICT` on apply** = a var with that key/target already exists on the project. **Terraform
  owns env vars and does not upsert** — delete the pre-existing ones (dashboard or API) and re-apply,
  or `terraform import` them first. Adopting an existing project means importing its env vars.
- **pnpm workspace membership** (a local `next`/`vercel` monorepo tool) — add `tools/<name>` to
  `pnpm-workspace.yaml`, else Vercel's root install skips its deps (`Cannot find package 'pg'`).
  `doctor` flags this.
- **`vercel.json` framework preset** — without `{ "framework": "nextjs" }` Vercel treats the Next
  build as a static site (`No Output Directory named "public"`). `doctor` flags a missing one.
- **Deployment Protection (401 on the `*.vercel.app` URL).** `deployment_status.target_url` is the
  *deployment* URL, which Deployment Protection gates to **401** even when the public custom domain is
  200. Create a **Protection Bypass for Automation** secret and set it as
  `VERCEL_AUTOMATION_BYPASS_SECRET_<TOOL>` (per-tool — the value is per Vercel project) on the tool
  repo; the api check sends it as `x-vercel-protection-bypass` and asserts 200. Without it the spec
  asserts **401** so the gate still stays green.
- **`beta_branch` must match the repo's real pre-prod branch** (HeistMind uses `development`; new
  tools use `develop`).
- `next` can also target `workers` (V0/V2) — default is vercel.
