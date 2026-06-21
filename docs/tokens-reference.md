# Tokens & auth — full reference

Every credential Greenlight uses, grouped by provider: **what to create, where, which permissions,
what it's for, and where it's stored.** For the step-by-step setup prose see
[provider-tokens.md](provider-tokens.md); for the trust model see [security.md](security.md). This
page is the at-a-glance matrix.

**Rules (non-negotiable):** one token → one env var; stored **only** in provider stores (GitHub
Actions secrets) + the gitignored `.greenlight/secrets.env` — never committed or echoed. Gather them
with `greenlight secrets gather <tool> --repo <owner>/<repo>` (link-first, hidden input, writes
straight to GitHub — no disk, no logs). Prefer GitHub OIDC over long-lived secrets where supported.

Legend: **Store** = where the value lives (`wrapper` = your site repo's Actions secrets, `tool` =
an adopted tool's repo, `local` = `.greenlight/secrets.env`). **When** = always, or the manifest
facet that triggers it.

---

## At a glance

| env var | provider | when | store | required |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare | always | wrapper + local | ✅ |
| `TF_VAR_cloudflare_zone_id` | Cloudflare | always | wrapper + local | ✅ |
| `TF_API_TOKEN` | HCP Terraform | always | wrapper + local | ✅ |
| `GITHUB_TOKEN` | GitHub | always (CI built-in) | — (auto) | ✅ (provided) |
| `VERCEL_API_TOKEN` | Vercel | `target: vercel` | wrapper + local | ✅ for vercel |
| `VERCEL_AUTOMATION_BYPASS_SECRET_<TOOL>` | Vercel | `target: vercel` | tool | optional |
| `SUPABASE_ACCESS_TOKEN` | Supabase | `data: supabase` | wrapper + local | ✅ for supabase |
| `TF_VAR_<tool>_supabase_database_password` | Supabase | `data: supabase` | wrapper + local | optional* |
| `TF_VAR_oci_tenancy_ocid` | OCI | `target: oci` | wrapper + local | ✅ for oci |
| `TF_VAR_oci_user_ocid` | OCI | `target: oci` | wrapper + local | ✅ for oci |
| `TF_VAR_oci_fingerprint` | OCI | `target: oci` | wrapper + local | ✅ for oci |
| `TF_VAR_oci_private_key` | OCI | `target: oci` | wrapper + local | ✅ for oci |
| `TF_VAR_oci_region` | OCI | `target: oci` | wrapper + local | ✅ for oci |
| `TF_VAR_oci_compartment_id` | OCI | `target: oci` | wrapper + local | optional |
| `GREENLIGHT_DISPATCH_TOKEN` | GitHub | adopted tool | **tool** | ✅ for adopted |
| `GREENLIGHT_STATUS_TOKEN_<TOOL>` | GitHub | adopted `oci` tool | wrapper | optional |
| `TF_VAR_keepalive_github_token` | GitHub | keepalive / auto-heal | wrapper + local | optional† |
| `<TOOL>_VERIFY_TOKEN` | (tool's own auth) | OAuth-gated tool | wrapper | optional |

\* Only used when a Supabase project is **created**; on import the module ignores it (any
non-empty placeholder works).
† Optional, but **required for github-issue alerts and OCI auto-remediation** to function.

---

## Cloudflare — DNS, Workers (keepalive), tunnels  ·  *always*

Create at **https://dash.cloudflare.com/profile/api-tokens** → Create Custom Token.

| token / var | permissions | for | required |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **Account · Workers Scripts · Edit**; **Zone · DNS · Edit**; **Account · Account Settings · Read**; **Account · Cloudflare Tunnel · Edit** *(only if any tool is `target: oci`)* | subdomain CNAMEs, the keepalive Worker + cron trigger, cloudflared tunnels for OCI | ✅ |
| `TF_VAR_cloudflare_zone_id` | *(an ID, not a token)* — zone **Overview → API → Zone ID** | tells Terraform which zone to manage DNS in | ✅ |

A DNS-only token is **not** enough once keepalive deploys (it's a Worker). Missing **Tunnel · Edit**
→ `cfd_tunnel` apply fails with **403** for `oci` tools. Verify: `curl -s
https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"`
→ `"status":"active"`. Also authenticates the Cloudflare MCP server.

## HCP Terraform — remote state  ·  *always*

Create at **https://app.terraform.io/app/settings/tokens** → user API token.

| token | permissions | for | required |
|---|---|---|---|
| `TF_API_TOKEN` | the token is account/user-scoped (no finer grain) | remote state backend auth — passed to Terraform as `TF_TOKEN_app_terraform_io` (state + locking in your HCP workspace) | ✅ |

Verify: `curl -s https://app.terraform.io/api/v2/organizations -H "Authorization: Bearer $TF_API_TOKEN"`.

## GitHub — secrets, repo infra, CI  ·  *always*

| auth | create at | permissions | for |
|---|---|---|---|
| `gh` CLI login | `gh auth login` | your account | running `greenlight secrets gather/sync` from your machine |
| `GITHUB_TOKEN` (Actions built-in) | *(auto in workflows)* | per-workflow `permissions:` block | GHCR push, same-repo issue creation (the self-heal escalation), the github provider |

You don't create `GITHUB_TOKEN`. The **fine-grained PATs** (`GREENLIGHT_DISPATCH_TOKEN`,
`GREENLIGHT_STATUS_TOKEN_<TOOL>`, the keepalive token) are GitHub credentials too — see
[Per-tool & keepalive tokens](#per-tool--keepalive-tokens-github-pats).

## Vercel — `target: vercel`

Create at **https://vercel.com/account/settings/tokens** (scope to the **team**, set an expiry).

| token | permissions | for | required |
|---|---|---|---|
| `VERCEL_API_TOKEN` | team-scoped | the vercel Terraform provider (custom domains + env vars on the existing project; deploys ride git integration) | ✅ for vercel |
| `VERCEL_AUTOMATION_BYPASS_SECRET_<TOOL>` | from project → **Settings → Deployment Protection → Protection Bypass for Automation** | lets `verify` send the bypass header and assert **200** (the real app) instead of **401** (protected-but-served) | optional |

> **Per-tool name.** The bypass value is per **Vercel project**, so the secret is suffixed with the
> tool (`…_HEISTMIND`) — two vercel tools never collide. The workflow maps it to the generic
> `VERCEL_AUTOMATION_BYPASS_SECRET` env the spec reads. Same convention as `GREENLIGHT_STATUS_TOKEN_<TOOL>`.

Verify: `curl -s https://api.vercel.com/v2/user -H "Authorization: Bearer $VERCEL_API_TOKEN"`.

## Supabase — `data: supabase`

Create at **https://supabase.com/dashboard/account/tokens** → Generate new token (shown once).

| token / var | permissions | for | required |
|---|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Management API PAT — **account-scoped** (manages every project in the account; keep it tight) | the supabase provider + the Supabase MCP (read-only) | ✅ for supabase |
| `TF_VAR_<tool>_supabase_database_password` | *(a value)* | only when a project is **created**; ignored on import (module sets `ignore_changes`). **Per-tool** (per Supabase project) — declared inline in each `infra/<tool>.tf`, so two supabase tools don't collide | optional |

Verify: `curl -s https://api.supabase.com/v1/projects -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"`.

## Oracle Cloud (OCI) — `target: oci`

The **only** manual OCI input is the API key — the VCN/subnet/availability-domain are IaC, and the
container-instance OCID is auto-resolved by display-name (never a stored secret). Create the key at
**OCI Console → Profile → User settings → API keys → Add API key**; OCI shows a **config preview** +
a `.pem` — `greenlight secrets gather <tool> --repo <wrapper> --oci-config <path>` ingests both.

| var | from the config preview / key | for | required |
|---|---|---|---|
| `TF_VAR_oci_tenancy_ocid` | `tenancy=` | OCI provider API-key request signing | ✅ for oci |
| `TF_VAR_oci_user_ocid` | `user=` | ↑ | ✅ for oci |
| `TF_VAR_oci_fingerprint` | `fingerprint=` | ↑ | ✅ for oci |
| `TF_VAR_oci_private_key` | the `.pem` **contents** | ↑ | ✅ for oci |
| `TF_VAR_oci_region` | `region=` (e.g. `us-phoenix-1`) | ↑ | ✅ for oci |
| `TF_VAR_oci_compartment_id` | `compartment=` (optional) | placement — blank → the tenancy/root compartment | optional |

> Not a token: `OCI_CONTAINER_INSTANCE_OCID` is resolved at deploy time by the instance's
> display-name (= the tool name). Nothing to create or store.

---

## Per-tool & keepalive tokens (GitHub PATs)

Provider credentials live **only in the wrapper**. For an **adopted** (poly-repo) tool the tool's
sub-repo holds exactly one token. All are **fine-grained** PATs at
**https://github.com/settings/personal-access-tokens/new** → *Resource owner* = your org → *Only
select repositories* → the repo named below → set the one permission → Generate.

| token | lives on | repo it's scoped to | permission | for |
|---|---|---|---|---|
| `GREENLIGHT_DISPATCH_TOKEN` | **tool** repo | the **wrapper** | **Contents: Read and write** | the tool's `greenlight-build` fires `repository_dispatch` → the wrapper deploys |
| `GREENLIGHT_STATUS_TOKEN_<TOOL>` | **wrapper** | the **tool** | **Commit statuses: Read and write** | the wrapper posts deploy/verify status back to the tool's commit |
| `TF_VAR_keepalive_github_token` | **wrapper** | the **wrapper** | **Issues: Read and write** + **Contents: Read and write** | keepalive `github-issue` alerts (Issues) **and** OCI auto-remediation `repository_dispatch` (Contents) |
| `<TOOL>_VERIFY_TOKEN` (e.g. `BAMCP_VERIFY_TOKEN`) | **wrapper** | the tool itself (M2M service token) | a strong random value | an *authenticated* functional/eval `verify` (initialize → tools/list / a tool call) beyond the public 401 smoke check |

Notes:
- The **status token is per-tool** (`…_<TOOL>`, uppercase, hyphens→underscores: `demo-mcp` →
  `GREENLIGHT_STATUS_TOKEN_DEMO_MCP`) because it lives on the **shared** wrapper scoped to one tool's
  repo — a plain name would collide across tools. The dispatch token lives on the per-tool repo, so
  no suffix.
- The keepalive token is stored as the wrapper Actions secret **`TF_VAR_KEEPALIVE_GITHUB_TOKEN`** and
  passed to Terraform by `.github/workflows/infra.yml`; the module binds it to the Worker. Empty/unset
  → pings still run, but alerts **and** self-heal silently no-op.
- After onboarding, an adopted tool's repo should hold **only `GREENLIGHT_DISPATCH_TOKEN`** (its build
  pushes to GHCR with the built-in `GITHUB_TOKEN`).
- **`<TOOL>_VERIFY_TOKEN` is a stateless M2M service token** (the per-tool prefix means no collision).
  For an OAuth-gated MCP server whose tokens are in-memory (wiped on restart), a pre-minted OAuth
  token can't survive a deploy — so the tool accepts one configured bearer statelessly (read scope).
  Set the **same** value in two places: the tool's runtime env (e.g. via `TF_VAR_<tool>_verify_token`
  → container env) **and** the wrapper secret the verify step presents. Empty → functional verify
  stays dormant; the 401 smoke still gates.

---

## Where they live

```sh
# .greenlight/secrets.env  (gitignored, mode 600) — for LOCAL terraform/CLI runs
CLOUDFLARE_API_TOKEN=...
TF_VAR_cloudflare_zone_id=...
TF_API_TOKEN=...
VERCEL_API_TOKEN=...                       # target: vercel
SUPABASE_ACCESS_TOKEN=...                  # data: supabase
TF_VAR_<tool>_supabase_database_password=import-placeholder   # per-tool (per Supabase project)
TF_VAR_oci_tenancy_ocid=...                # target: oci (×5 + optional compartment)
TF_VAR_keepalive_github_token=...          # optional (alerts + auto-heal)
```

Load before a local apply: `set -a; source .greenlight/secrets.env; set +a`. In CI the same names
are **GitHub Actions secrets** on the wrapper (uppercased for the `TF_VAR_*` ones, e.g.
`TF_VAR_CLOUDFLARE_ZONE_ID`); `.github/workflows/infra.yml` maps them to the lowercase `TF_VAR_*`
Terraform variables at apply time.

The same `CLOUDFLARE_API_TOKEN` / `SUPABASE_ACCESS_TOKEN` also authenticate their MCP servers, and
`gh` handles GitHub — so the agent loop introspects providers with tokens you already created.
