# Terraform remote state on Cloudflare R2

> **Parent:** [greenlight-v1.md](../greenlight-v1.md) §11 (config as code) + §17 (locked: state on R2 with lockfile locking). **Goal:** make a wrapper repo's Terraform state shared, durable, and CI-applyable — so `push → terraform apply` works and the state isn't trapped on one machine.

## Why remote state

Terraform's **state file** maps your `.tf` config to the real cloud resources (their IDs + attributes). By default it's **local** (`infra/terraform.tfstate`) — fine for applying by hand, but it breaks two things:

- **CI can't apply.** A GitHub Actions runner is ephemeral (empty state every run). With no state, Terraform thinks *nothing exists* and tries to **create everything** → `already exists` / conflict errors, or duplicate resources. It has no memory that (e.g.) the Supabase project was imported or the env vars are set.
- **Durability.** Local state lives on one machine. Lose it and you must re-import every resource.

A remote backend fixes both, and adds **locking** (no two applies corrupt state at once). Greenlight uses **Cloudflare R2**: it's S3-compatible (Terraform's built-in `s3` backend works), already in the stack, cheap, zero-egress. Terraform **≥ 1.10** (or OpenTofu ≥ 1.8) does native lock files **in the bucket**, so unlike classic AWS S3 you do **not** need a DynamoDB table.

> The **app** still deploys on push via its host's git integration (Vercel/Workers). Remote state is specifically about **applying *infra* changes via CI** and not losing state. Infra changes are infrequent, so this is "durability + hands-off infra", not a blocker for a live site.

## Prerequisites

- Terraform **≥ 1.10** (`use_lockfile`) or OpenTofu ≥ 1.8.
- R2 enabled on the Cloudflare account.
- Your Cloudflare **account id** (R2 dashboard, or any zone's overview).

## Step 1 — Create the state bucket

Dashboard: **R2 → Create bucket** → name e.g. `greenlight-tfstate` (location: automatic). One bucket holds all your wrappers' states (separated by `key`).

Or via API (token needs **Account → Workers R2 Storage → Edit**):
```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<account-id>/r2/buckets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"greenlight-tfstate"}'
```

## Step 2 — Create R2 S3-API credentials

R2's S3 backend uses **its own** Access Key ID + Secret (NOT your Cloudflare API token).

Dashboard: **R2 → Manage R2 API Tokens → Create API Token** → permission **Object Read & Write** (scope to the bucket) → copy the **Access Key ID** and **Secret Access Key** (shown once).

Terraform's `s3` backend reads them from the standard env vars:
```
AWS_ACCESS_KEY_ID=<r2 access key id>
AWS_SECRET_ACCESS_KEY=<r2 secret access key>
```
Store them only in the gitignored `.greenlight/secrets.env` + the CI secret store — never commit.

## Step 3 — Configure the backend (wrapper `infra/main.tf`)

```hcl
terraform {
  backend "s3" {
    bucket = "greenlight-tfstate"
    key    = "<repo-name>/terraform.tfstate"   # unique per wrapper repo
    region = "auto"
    endpoints = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }

    use_lockfile = true   # native lock object in the bucket (TF >= 1.10) — no DynamoDB

    # R2 is S3-compatible but not real AWS — skip the AWS-only preflight checks:
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
  }
}
```
Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the environment (don't hardcode them in the block).

## Step 4 — Migrate existing local state up (one-time)

From a checkout that has the current local `terraform.tfstate`:
```sh
set -a; source .greenlight/secrets.env; set +a   # provider tokens + AWS_* R2 keys
terraform -chdir=infra init -migrate-state        # uploads local state -> R2; answer "yes"
terraform -chdir=infra plan                       # should show "No changes" (state intact)
```
After this the bucket holds the state; the local `terraform.tfstate` can be deleted.

## Step 5 — CI workflow: apply infra on push

Push the provider tokens + R2 keys to the wrapper repo's **GitHub Actions secrets** (`gh secret set …`, or `greenlight secrets sync`). Then add `.github/workflows/infra.yml`:

```yaml
name: infra
on:
  push:
    branches: [main]
    paths: ['infra/**']
  workflow_dispatch:
permissions:
  contents: read
concurrency: { group: infra, cancel-in-progress: false }  # serialize applies
jobs:
  apply:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      VERCEL_API_TOKEN: ${{ secrets.VERCEL_API_TOKEN }}
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      TF_VAR_cloudflare_zone_id: ${{ secrets.TF_VAR_CLOUDFLARE_ZONE_ID }}
      TF_VAR_supabase_database_password: ${{ secrets.TF_VAR_SUPABASE_DATABASE_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: '~1.10' }
      - run: terraform -chdir=infra init
      - run: terraform -chdir=infra plan -input=false -out=tf.plan
      - run: terraform -chdir=infra apply -input=false tf.plan
```
The bucket holds the state, so CI plans only the real diff and applies safely. `concurrency` serializes runs; `use_lockfile` guards against a concurrent local apply.

## Step 6 — The cross-repo GitHub-provider wrinkle

If your infra's `github` provider manages resources in **another** repo (e.g. a tool's GitHub deployment environments on a separate app repo), the Actions built-in `GITHUB_TOKEN` won't reach it — it's scoped to the current repo only. Two options:

1. **Drop the cross-repo resources** (simplest) — e.g. omit the per-env `github_repository_environment` for `external` tools; they aren't used by host-git-integration deploys.
2. **Use a PAT** — add a fine-grained PAT (Contents/Administration on both repos) as a secret and set `GITHUB_TOKEN: ${{ secrets.GH_PAT }}` in the job env.

## Security

- R2 keys + provider tokens live only in `.greenlight/secrets.env` (gitignored) + the CI secret store. Never committed.
- The state file itself contains secrets (DB passwords, API keys) — that's exactly why it belongs in a private bucket, not git. The bucket is private by default; keep it that way.
- Scope the R2 token to the single state bucket (Object Read & Write), not the whole account.
