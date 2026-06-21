---
name: provider-github
description: How GitHub works in a Greenlight setup — secrets sync target (Actions secrets/environments), the repo/branch/protection Terraform module, the develop→main flow, and OIDC-over-PAT preference. Use when syncing tokens, wiring branch protection/environments, or debugging gh/secrets/CI auth.
---

# provider-github

GitHub is the **always-on** control plane: it holds the Actions **secrets** (provider tokens),
the **environments** (beta/prod), branch protection, and runs the deploy/promote/infra
workflows. The `develop → main` flow is standardized (PR → preview, `develop` → beta, `main`
→ prod; promote is a gated fast-forward).

## Token — `GITHUB_TOKEN` (usually you don't set one)

- In **CI**, Actions provides `github.token` automatically — the infra.yml maps it to the
  `github` provider. No PAT needed for single-repo infra.
- For **cross-repo** ops (managing another repo's settings, syncing secrets to a tool repo),
  use a fine-grained **PAT** with the minimal scopes (e.g. `Secrets: write`, `Administration`
  for protection). Prefer **GitHub OIDC → cloud** over long-lived cloud tokens where supported.

### Poly-repo deploy loop — the two option-B PATs

An adopted tool (submodule) and its wrapper hand off via two fine-grained PATs (`secrets gather`
pushes each to the right repo; see docs/provider-tokens.md):

- **`GREENLIGHT_DISPATCH_TOKEN`** — on the **tool** repo, scoped **Contents: write** on the
  **wrapper** → the tool's build fires `repository_dispatch` so the wrapper deploys.
- **`GREENLIGHT_STATUS_TOKEN`** — on the **wrapper** repo, scoped **Commit statuses: write** on the
  **tool** → the wrapper posts deploy/verify status back to the tool's commit.

Provider creds (OCI/Cloudflare/…) live **only in the wrapper**; the tool repo holds just the
dispatch PAT (its build pushes to GHCR with the built-in `github.token`).

## Secrets sync

`greenlight secrets sync [--repo o/r] [--env <env>]` pushes `.greenlight/secrets.env` to the
repo's Actions secrets via `gh` (values piped on stdin — never in argv or logs). Run
`gh auth login` first. This is the "init writes to provider stores" piece.

## Terraform module — `infra/modules/repo`

Branches + protection + required checks (+ optional environments via the `tool` module's
`manage_github_environments`). For an **external** tool (code in its own repo), set
`manage_github_environments = false` so the wrapper's CI stays single-repo (no PAT needed).

## Gotcha
Direct pushes/merges to a protected `main` are blocked — use `gh pr create` + merge, or the
gated `greenlight promote` fast-forward. Keep to `develop` (not `development`) for the branch.
