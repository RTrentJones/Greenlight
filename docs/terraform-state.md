# Terraform remote state (HCP Terraform — no credit card)

> **Parent:** [greenlight-v2.md](../greenlight-v2.md) §12 (CI/CD environments). **Goal:** make a
> wrapper repo's Terraform state shared, durable, and CI-applyable — so `push → terraform apply`
> works and the state isn't trapped on one machine.

Greenlight uses **HCP Terraform** (Terraform Cloud) free tier as the state backend: **no credit
card**, and it gives state + locking + history + a UI free to ~500 resources under management. It
runs in **Local execution** mode — HCP stores the state and the lock; the actual `plan`/`apply`
runs in your CI (or your machine) with the provider creds it already has. If you'd rather stay in
one cloud, S3-compatible backends (R2 / OCI / AWS) are at the bottom.

## Why remote state

Terraform's **state file** maps your `.tf` config to the real cloud resources (their IDs +
attributes). By default it's **local** (`infra/terraform.tfstate`) — fine for applying by hand, but
it breaks two things:

- **CI can't apply.** A GitHub Actions runner is ephemeral (empty state every run). With no state,
  Terraform thinks *nothing exists* and tries to **create everything** → `already exists` / conflict
  errors, or duplicates. It has no memory that (e.g.) the Supabase project was imported.
- **Durability.** Local state lives on one machine. Lose it and you must re-import every resource.

A remote backend fixes both and adds **locking** (no two applies corrupt state at once).

> The **app** still deploys on push via its host's git integration (Vercel/Workers). Remote state is
> specifically about **applying *infra* changes via CI** and not losing state. Infra changes are
> infrequent, so this is "durability + hands-off infra", not a blocker for a live site.

## Setup — HCP Terraform

### 1. Account + workspace
Sign up at **[app.terraform.io](https://app.terraform.io)** (free, no card) and create an org. Create
a workspace named after the wrapper repo (e.g. `<repo-name>`), **Execution Mode: Local** — HCP holds
state + locks, runs happen in your CI with your own provider tokens.

### 2. API token
app.terraform.io → **Account settings → Tokens** → create a user API token. Store it as the GitHub
Actions secret **`TF_API_TOKEN`** (`greenlight secrets gather` / `gh secret set` — Greenlight keeps
no local secret file). CI reads it from the env var `TF_TOKEN_app_terraform_io`.

### 3. Backend block (wrapper `infra/main.tf`)
```hcl
terraform {
  cloud {
    organization = "<your-org>"
    workspaces { name = "<repo-name>" }
  }
}
```
`greenlight init` scaffolds this block (commented) in `infra/main.tf` — fill in the org/workspace
before the first apply.

### 4. Migrate local state up (one-time)
From a checkout with the current local `terraform.tfstate`, export the provider tokens into your
shell for this one-time migration (paste them directly — Greenlight keeps no local secret file):
```sh
export CLOUDFLARE_API_TOKEN=... TF_API_TOKEN=...     # provider tokens (+ any others this state needs)
export TF_TOKEN_app_terraform_io="$TF_API_TOKEN"
terraform -chdir=infra init     # prompts to migrate local state → HCP; answer "yes"
terraform -chdir=infra plan     # should show "No changes" (state intact)
```
After this HCP holds the state; the local `terraform.tfstate` can be deleted. From here on every
apply runs in CI — there is no local-secrets apply path.

### 5. CI workflow — apply infra on push
Set the provider tokens + `TF_API_TOKEN` on the wrapper's **GitHub Actions secrets**
(`greenlight secrets gather`, or `gh secret set …`), then add `.github/workflows/infra.yml`:

```yaml
name: infra
on:
  push:
    branches: [main]
    paths: ['infra/**']
  workflow_dispatch:
permissions:
  contents: read
concurrency: { group: infra, cancel-in-progress: false }  # never interrupt an in-flight apply
jobs:
  apply:
    runs-on: ubuntu-latest
    env:
      TF_TOKEN_app_terraform_io: ${{ secrets.TF_API_TOKEN }}   # HCP state backend auth
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      VERCEL_API_TOKEN: ${{ secrets.VERCEL_API_TOKEN }}
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      TF_VAR_cloudflare_zone_id: ${{ secrets.TF_VAR_CLOUDFLARE_ZONE_ID }}
      # per-tool (per Supabase project) — one line per data:supabase tool, names never collide
      TF_VAR_blog_supabase_database_password: ${{ secrets.TF_VAR_BLOG_SUPABASE_DATABASE_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: '~1.10', terraform_wrapper: false }
      - run: terraform -chdir=infra init -input=false
      - run: terraform -chdir=infra plan -input=false -out=tf.plan
      - run: terraform -chdir=infra apply -input=false tf.plan
```
HCP holds the state, so CI plans only the real diff and applies safely; the `concurrency` group
serializes runs and HCP's native lock guards against a concurrent local apply.

## The cross-repo GitHub-provider wrinkle

If your infra's `github` provider manages resources in **another** repo (e.g. a tool's GitHub
deployment environments on a separate app repo), the Actions built-in `GITHUB_TOKEN` won't reach it
— it's scoped to the current repo. Two options:

1. **Drop the cross-repo resources** (simplest) — e.g. omit per-env `github_repository_environment`
   for `external` tools (`manage_github_environments = false`); they aren't used by host-git deploys.
2. **Use a PAT** — a fine-grained PAT (scoped to both repos) as a secret, set on the aliased provider.

## Alternative backends (S3-compatible: R2 / OCI / AWS)

Prefer to stay in one cloud? Terraform's built-in `s3` backend works with several stores. The migrate
+ CI steps are identical — only the backend block + locking story differ.

| Backend | New credit card | Locking | Notes |
|---|---|---|---|
| **HCP Terraform** ⟵ *Greenlight's default* | **No** | ✅ native | state + lock + history + UI; separate HashiCorp account |
| **OCI Object Storage** (S3-compat) | **No** if you already have OCI | ⚠️ serialize (may not lock) | reuses your stack; Always-Free ~20 GB |
| **Cloudflare R2** | **Yes** (to enable R2; free tier won't charge) | ✅ native (`use_lockfile`, TF ≥ 1.10 — no DynamoDB) | all-Cloudflare |
| **AWS S3** | **Yes** (new account) | ✅ native | canonical backend |

The `s3` backend block (for R2 or OCI) — credentials come from `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` in the env (R2's own S3 API keys, or OCI Customer Secret Keys):

```hcl
terraform {
  backend "s3" {
    bucket    = "greenlight-tfstate"
    key       = "<repo-name>/terraform.tfstate"
    region    = "auto"                               # OCI: the real region, e.g. us-ashburn-1
    endpoints = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }  # OCI: <ns>.compat.objectstorage.<region>.oraclecloud.com
    use_lockfile = true   # R2 only (TF ≥ 1.10); OMIT for OCI (its S3-compat may not honor it — serialize instead)
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
  }
}
```

- **R2 keys** — Cloudflare → R2 → *Manage R2 API Tokens* → **Object Read & Write** (scope to the bucket).
- **OCI keys** — Console → profile → **Customer Secret Keys** → Generate.
- R2 free tier is effectively free for state (10 GB · 1M Class-A ops/mo; state is ~KB, a few ops/apply,
  $0 egress). Set a Cloudflare billing notification, keep the bucket private, scope the token.

## Security

- All tokens + state keys live only in **GitHub Actions secrets** (set via `greenlight secrets
  gather` / `gh secret set`) — Greenlight keeps no local secret file, and nothing is committed.
- The state file itself contains secrets (DB passwords, API keys) — which is exactly why it belongs
  in HCP / a private bucket, not git.
