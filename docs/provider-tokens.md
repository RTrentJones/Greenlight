# Provider API tokens (Cloudflare · Supabase · Vercel)

> For the complete by-provider matrix (every token, its permissions, what it's for, where it's
> stored) see **[tokens-reference.md](tokens-reference.md)**. This page is the step-by-step setup prose.

When you apply a tool that uses **`target: vercel`** and/or **`data: supabase`** — or deploy
the **keepalive** Worker — Terraform's providers need their own API tokens. Greenlight reads
each from a standard environment variable, so it's **one token → one env var**. Store them
only in the gitignored `.greenlight/secrets.env` (+ the provider stores) — never commit or
echo them (docs/archive/greenlight-v1.md §14).

| env var | used by | needed when |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | cloudflare provider (DNS + Workers) | always (DNS); keepalive Worker |
| `SUPABASE_ACCESS_TOKEN` | supabase provider | `data: supabase` tools |
| `VERCEL_API_TOKEN` | vercel provider | `target: vercel` tools |

Replace every `<placeholder>` below with your own values.

---

## `CLOUDFLARE_API_TOKEN` — DNS **and** Workers

A DNS-only token is **not** enough once you deploy keepalive (a Worker with a cron trigger).
Create one custom token with both scopes:

1. **https://dash.cloudflare.com/profile/api-tokens** → **Create Token** → **Create Custom Token**.
2. **Permissions:**
   - **Account → Workers Scripts → Edit**   (the keepalive worker + cron trigger)
   - **Zone → DNS → Edit**                  (the tool's subdomain CNAMEs)
   - **Account → Account Settings → Read**  (lets tooling resolve the account)
   - **Account → Cloudflare Tunnel → Edit** (only if a tool uses `target: oci`; without it the
     cloudflared tunnel fails with **403 Forbidden** on `cfd_tunnel` at apply)
3. **Account Resources:** Include → your account.
4. **Zone Resources:** Include → Specific zone → `<your-domain>`.
5. Create → copy. This is a superset of a DNS-only token, so it can replace an existing one.

Verify: `curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"` → `"status":"active"`.

## `SUPABASE_ACCESS_TOKEN` — Management API

1. **https://supabase.com/dashboard/account/tokens** → **Generate new token** → copy (shown once).

Personal access tokens are account-scoped (Supabase has no finer grain) — they can manage
every project in your account, so keep this in the gitignored file only.

Verify: `curl -s https://api.supabase.com/v1/projects -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"` → your project list.

## `VERCEL_API_TOKEN`

1. **https://vercel.com/account/settings/tokens** → **Create Token**.
2. **Scope:** the **team** that owns the project (not "personal"), set an expiration, create, copy.

Verify: `curl -s "https://api.vercel.com/v2/user" -H "Authorization: Bearer $VERCEL_API_TOKEN"` → your user.

---

## Terraform variables

- **`TF_VAR_cloudflare_zone_id`** — the zone's id. Dashboard: the zone's **Overview → API →
  Zone ID**. Or:
  ```
  curl -s "https://api.cloudflare.com/client/v4/zones?name=<your-domain>" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep -o '"id":"[^"]*"' | head -1
  ```
- **`TF_VAR_<tool>_supabase_database_password`** — **per-tool** (the password is per Supabase
  project; it's declared inline in each `infra/<tool>.tf` so two `data: supabase` tools never
  collide). Only used if a Supabase project is **created**; when importing an existing project the
  module sets `ignore_changes` on the password, so any non-empty placeholder works.
- **`TF_VAR_keepalive_github_token`** *(optional)* — the keepalive Worker's GitHub token. A
  fine-grained PAT on the wrapper repo with **Issues: Read and write** (the `github-issue` alert
  sink) **and — for auto-remediation — Contents: Read and write** (the `repository_dispatch` that
  fires `remediate-<tool>` on an oci outage). Empty = the pings still run, but alerts **and**
  self-heal no-op. Stored as the wrapper Actions secret `TF_VAR_KEEPALIVE_GITHUB_TOKEN` (passed to
  Terraform by `.github/workflows/infra.yml`).

---

## Poly-repo (adopted tool) tokens — wrapper ↔ sub-repo

When you `greenlight adopt <tool>` an existing repo (the default **wrapper-centric** model), the
tool lives as a `tools/<tool>` git submodule and the two repos split responsibilities — so the
**tokens split too**. The rule: **provider credentials live ONLY in the wrapper; the tool sub-repo
holds exactly one token.** Never put OCI/Cloudflare/cloud creds on the tool repo (it doesn't deploy —
it only builds a container + pings the wrapper).

| token | lives on | fine-grained scope | purpose |
|---|---|---|---|
| `GREENLIGHT_DISPATCH_TOKEN` | **tool sub-repo** | **Contents: write** on the **wrapper** repo | the tool's `greenlight-build` fires `repository_dispatch` → the wrapper deploys |
| `GREENLIGHT_STATUS_TOKEN_<TOOL>` | **wrapper** repo | **Commit statuses: write** on the **tool** repo | the wrapper posts deploy/verify status back to the tool's commit |
| `TF_VAR_OCI_*`, `CLOUDFLARE_API_TOKEN` (+ Tunnel:Edit), `TF_API_TOKEN`, … | **wrapper** repo | (see above) | the wrapper owns all infra + apply + deploy |

The status token is **per-tool** (`GREENLIGHT_STATUS_TOKEN_<TOOL>`, e.g. `…_BAMCP`) because it lives
on the **shared** wrapper, scoped to *one* tool's repo — a second tool's token would collide on a
plain name. The dispatch token lives on the per-tool repo, so it needs no suffix. (Uppercase the
tool name; hyphens → underscores: `demo-mcp` → `…_DEMO_MCP`.)

The tool sub-repo's build pushes to GHCR with the **built-in `GITHUB_TOKEN`** (no PAT needed for
that), so after onboarding it should hold **only `GREENLIGHT_DISPATCH_TOKEN`**. The container
instance OCID is **not** a token — the deploy workflow resolves it from OCI by display-name.

**Optional — `<TOOL>_VERIFY_TOKEN` (functional/eval verify):** for an OAuth-gated MCP tool, a
bearer token on the **wrapper** lets the post-deploy `verify` run an *authenticated* check
(initialize → tools/list / a tool call) — the functional signal beyond the 401 smoke check. The
`verify.config.ts` reads it from the env and omits the authed spec when it's unset (so the gate
stays green on the 401 alone). Provision it from the tool's own auth (e.g. OAuth client-credentials
→ a short-lived/long-lived token) and add it as a wrapper secret; the deploy workflow passes it to
the verify step.

### Create the two PATs

Both are **fine-grained** PATs at **https://github.com/settings/personal-access-tokens/new** →
*Resource owner* = your org → *Only select repositories* → the one repo named below → *Repository
permissions* set the one permission below → Generate.

- **`GREENLIGHT_DISPATCH_TOKEN`** — repo: the **wrapper**; permission: **Contents → Read and write**.
- **`GREENLIGHT_STATUS_TOKEN_<TOOL>`** — repo: the **tool**; permission: **Commit statuses → Read and write**.

### Push them with the guided CLI

`greenlight secrets gather` is link-first, hidden-input, and writes straight to GitHub (no disk, no
logs). Run it once per repo — it prompts only for the tokens that repo needs:

```sh
# the wrapper: OCI auth + GREENLIGHT_STATUS_TOKEN (also add Cloudflare Tunnel:Edit to the existing
# CLOUDFLARE_API_TOKEN for oci tools). --oci-config ingests the OCI API-key config preview + .pem.
greenlight secrets gather <tool> --repo <owner>/<wrapper> [--oci-config ~/path/config]

# the tool sub-repo: GREENLIGHT_DISPATCH_TOKEN only (skip the rest at the prompts)
greenlight secrets gather <tool> --repo <owner>/<tool>
```

`gather` flags each prompt `[already set]` / `[not set]` so you know when a paste would override.

---

## Where they go: `.greenlight/secrets.env` (gitignored)

```sh
# provider auth (terraform reads these from the environment)
CLOUDFLARE_API_TOKEN=...
SUPABASE_ACCESS_TOKEN=...
VERCEL_API_TOKEN=...
# terraform variables
TF_VAR_cloudflare_zone_id=...
TF_VAR_<tool>_supabase_database_password=import-placeholder   # per-tool (per Supabase project)
TF_VAR_keepalive_github_token=        # optional
```

Load before running Terraform: `set -a; source .greenlight/secrets.env; set +a`.

> The same `CLOUDFLARE_API_TOKEN` / `SUPABASE_ACCESS_TOKEN` also authenticate the Cloudflare
> and Supabase MCP servers, and `gh` handles GitHub — so the agent loop can introspect these
> providers with the tokens you already created.
