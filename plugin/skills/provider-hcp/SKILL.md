---
name: provider-hcp
description: HCP Terraform in a Greenlight setup — the remote-state backend (free tier, no card) in Local execution mode (HCP stores state + locks; runs use CI creds). Use when setting up remote state, debugging a backend/init/locking issue, or CI apply-on-push.
---

# provider-hcp

HCP Terraform (app.terraform.io) is the **remote-state backend** for the wrapper's infra — free
tier, **no credit card**. It replaces local state so CI can `terraform apply` on push with state
locking (no two applies racing).

## Execution mode — **Local**, deliberately

The workspace is set to **Local execution mode**: HCP **stores state + does locking only**;
`terraform` runs here / in CI with **our own provider creds** (from GitHub Actions secrets). This
avoids uploading every provider token to HCP.

## Token — `TF_API_TOKEN`

A **user** API token (HCP → Account Settings → Tokens). Verify command + table:
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).
In CI it maps to the backend-auth env var **`TF_TOKEN_app_terraform_io`** (`infra.yml` does this).

## The `cloud{}` block

```hcl
terraform {
  cloud {
    organization = "YOUR_ORG"
    workspaces { name = "your-domain-with-dashes" }
  }
}
```

## CI apply-on-push

`infra.yml` (on push to `main`, paths `infra/**`): map GH secrets → `TF_TOKEN_app_terraform_io` + the
provider tokens + `TF_VAR_*`, then setup-terraform (`terraform_wrapper: false`) → init → plan -out →
apply. The CLI only edits the `.tf`; CI applies.

## Gotchas
- **Migrate local → HCP** with a plain `terraform init` (answer `yes` to copy state). The
  `-migrate-state` / `-force-copy` flags are **rejected** for the cloud backend — don't pass them.
- **Alternatives:** `docs/terraform-state.md` has the full backend chooser (HCP no-CC · OCI
  S3-compat · R2 card-required · AWS · local).
