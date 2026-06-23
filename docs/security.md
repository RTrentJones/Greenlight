# Security model

How Greenlight handles secrets, trust boundaries, and supply chain. The full by-provider token
matrix (permissions + purpose + storage) is [tokens-reference.md](tokens-reference.md); the
step-by-step setup is [provider-tokens.md](provider-tokens.md); this is the consolidated picture.

## Secrets never touch the repo

- **Gathered straight to the provider store.** `greenlight secrets gather <tool>` prints the
  create-link + least-privilege scopes per token, **hidden-prompts** for the value, runs a fail-fast
  `verify()`, and pushes via `gh` with the value on **stdin** — never argv, never a file, never echoed.
  It flags `[already set]` so you know when a paste would override.
- **One local copy at most.** `init` may write base tokens to a gitignored `.greenlight/secrets.env`
  (mode 600) to push them once; `add`/`gather` write nothing to disk. `.greenlight/` is gitignored by
  the scaffolded `.gitignore`.
- **Prefer OIDC over long-lived secrets** where the provider supports it.

## The clone seam — no personal data in framework files

Two rules, both CI-enforced ([development.md](development.md)):
1. **No personal data** (domain/email/token/tool-name) in framework files — only in
   `greenlight.config.ts` + `.greenlight/secrets.env`. `pnpm check-seam` scans every framework file.
2. **No load-bearing logic outside `packages/*` and `cli/`** — `pnpm check-boundaries`
   (dependency-cruiser) enforces consumer → framework import direction.

This is what lets the framework ship as a package while your wrapper stays yours.

## Trust boundaries

- **`private` tools + sensitive `beta.*` envs** sit behind **Cloudflare Access**. (A purely public
  content site — e.g. the blog — may keep its `beta.*` open by design; gate anything with data/auth.)
- **MCP auth:** a mutating or `private` MCP server MUST use `bearer`/`oauth`, never `none`; `auth:
  none` is allowed ONLY for a fully public, **read-only** server. The schema enforces the `private`
  ⇒ not-`none` rule (`packages/shared`); keeping a public `none` server read-only is the author's
  contract — there is no `mutating` flag yet, so don't expose writes from a `none` server.
- **OCI**: the only manual input is the API key — the VCN/subnet/AD are IaC; the container instance
  OCID is auto-resolved (never a stored secret). Provider auth is API-key request signing.
- **Migrations** pass a dangerous-SQL scan gate before apply.

## Token topology (who holds what)

Provider creds live in the **wrapper**, not tool repos. For a poly-repo (adopted) tool the split is:

| token | lives on | scope | purpose |
|---|---|---|---|
| provider creds (`TF_VAR_OCI_*`, `CLOUDFLARE_API_TOKEN`, `VERCEL_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `TF_API_TOKEN`) | wrapper | per provider | the wrapper owns infra + apply |
| `CLOUDFLARE_API_TOKEN` scopes | wrapper | Workers Scripts:Edit + Zone DNS:Edit (+ **Cloudflare Tunnel:Edit** for `oci` tools) | DNS, keepalive Worker, tunnels |
| `GREENLIGHT_DISPATCH_TOKEN` | **tool repo** | Contents:write on the **wrapper** | tool build → `repository_dispatch` → wrapper deploys |
| `GREENLIGHT_STATUS_TOKEN_<TOOL>` | wrapper | Commit statuses:write on the **tool** | wrapper posts deploy/verify status back (per-tool name) |
| `<TOOL>_VERIFY_TOKEN` / `VERCEL_AUTOMATION_BYPASS_SECRET_<TOOL>` | wrapper / tool | per tool (suffixed) | optional: authenticated functional verify / bypass Vercel Deployment Protection |
| `keepalive` PAT (`TF_VAR_keepalive_github_token`) | wrapper | Issues:write **+ Contents:write** | github-issue alerts + `repository_dispatch` self-heal (auto-remediation) |

The optimal end state: a tool repo holds **only** `GREENLIGHT_DISPATCH_TOKEN`.

## Supply chain

- **npm publish via OIDC Trusted Publishing** (`.github/workflows/release.yml`) — no `NPM_TOKEN`;
  publish is gated on a `v*` tag and carries provenance.
- **Lockstep versioning:** the npm version, the `MODULE_REF` git tag (`cli/src/version.ts`), and the
  wrapper's Terraform module `?ref=` move together.
- **State:** Terraform remote state + locking in HCP Terraform (free tier); state never in the repo.
