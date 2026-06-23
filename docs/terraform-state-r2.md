# Terraform remote state (R2, or HCP Terraform — no credit card)

> **Parent:** [greenlight-v1.md](archive/greenlight-v1.md) §11 (config as code) + §17 (state on R2). **Goal:** make a wrapper repo's Terraform state shared, durable, and CI-applyable — so `push → terraform apply` works and the state isn't trapped on one machine.

## Choosing a backend

Several backends give free remote state; pick mainly by whether you want a **new** credit
card on file. The migrate + CI steps are identical across all of them — only the backend
block (and locking story) differ.

| Backend | New credit card | Locking | Notes |
|---|---|---|---|
| **HCP Terraform free** | **No** | ✅ native | Purpose-built (state + lock + history + UI), free to ~500 resources under management. Separate HashiCorp account. **Best no-card option.** |
| **OCI Object Storage** (S3-compat) | **No** if you already have OCI | ⚠️ may not lock — serialize instead | Reuses your stack; Always-Free ~20 GB. Same `backend "s3"` shape as R2. |
| **Cloudflare R2** | **Yes** — required to enable R2 (free tier won't charge, see Cost & limits) | ✅ native | All-Cloudflare. |
| **AWS S3** | **Yes** (new account) | ✅ native | Canonical backend; S3 free tier is 12 months then ~pennies. |
| Local state (default) | No | n/a | No CI apply, no durability. Fine until infra changes often. |

The `backend "s3"` setup below covers **R2 and OCI** (both S3-compatible — just different
endpoint + keys). For the no-card paths see **[HCP Terraform](#hcp-terraform-free-tier--no-credit-card)**
or the **[OCI](#oci-object-storage-s3-compatible)** notes.

## R2 setup

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
      # per-tool (per Supabase project) — one line per data:supabase tool, names never collide
      TF_VAR_blog_supabase_database_password: ${{ secrets.TF_VAR_BLOG_SUPABASE_DATABASE_PASSWORD }}
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

## Cost & limits

For Terraform state, R2 is effectively **free** — state is tiny and applies are infrequent.

R2 **free tier** (per month, no charge under these): **10 GB** stored · **1,000,000** Class A
ops (writes/lists) · **10,000,000** Class B ops (reads) · **$0 egress, always**. A state
file is tens-to-hundreds of KB, and each `plan`/`apply` is ~2–3 writes + 1–2 reads (read
state, write state, lock/unlock). Even ~10,000 applies/month is ~30k ops vs the 1,000,000
free — and storage rounds to ~0 of 10 GB. Unlike Supabase's idle-pause, R2 has no idle cost.

Guardrails (R2 has no hard auto-cutoff, so use notifications):
- **Billing notification** — Cloudflare → *Notifications → Create → Billing* → set a low
  threshold; you'll be emailed long before any real charge.
- **Scope the R2 token** to the single state bucket (Object Read & Write) — limits blast radius.
- Keep the bucket **private** (it holds state secrets) — the default.

## HCP Terraform free tier — no credit card

The cleanest path if you'd rather not put a card anywhere: HCP Terraform (Terraform Cloud)
free tier needs **no credit card**, and gives state + locking + history + a UI, free to ~500
resources under management. Swap the backend block (instead of `backend "s3"`):
```hcl
terraform {
  cloud {
    organization = "<your-org>"
    workspaces { name = "<repo-name>" }
  }
}
```
`terraform init` prompts to migrate the local state up. The CI workflow is the same minus the
`AWS_*` R2 env — add `TF_TOKEN_app_terraform_io: ${{ secrets.TF_API_TOKEN }}` (a free HCP API
token) for auth. Trade-off: a separate HashiCorp account rather than staying in your stack.

## OCI Object Storage (S3-compatible)

If you already have OCI (e.g. an `oci` tool), its Object Storage is S3-compatible — **no new
credit card**, Always-Free ~20 GB. Same `backend "s3"` shape as R2, different endpoint + keys:

1. **Bucket** — OCI Console → Object Storage → Create Bucket (e.g. `greenlight-tfstate`). Note
   your **namespace** (Object Storage → namespace) and **region** (e.g. `us-ashburn-1`).
2. **S3-compat keys** — Console → your profile → **Customer Secret Keys** → Generate. This is
   the S3 Access Key + Secret (set as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).
3. **Backend block:**
   ```hcl
   terraform {
     backend "s3" {
       bucket   = "greenlight-tfstate"
       key      = "<repo-name>/terraform.tfstate"
       region   = "<oci-region>"            # e.g. us-ashburn-1
       endpoints = { s3 = "https://<namespace>.compat.objectstorage.<oci-region>.oraclecloud.com" }
       skip_credentials_validation = true
       skip_region_validation      = true
       skip_requesting_account_id  = true
       skip_metadata_api_check     = true
       # NOTE: omit `use_lockfile` — OCI's S3-compat may not honor the conditional writes it
       # needs. Serialize applies instead (CI `concurrency` group + don't apply from two
       # places at once). For a solo operator this is safe.
     }
   }
   ```
4. Migrate + CI are otherwise identical to R2.

## Security

- R2 keys + provider tokens live only in `.greenlight/secrets.env` (gitignored) + the CI secret store. Never committed.
- The state file itself contains secrets (DB passwords, API keys) — that's exactly why it belongs in a private bucket, not git. The bucket is private by default; keep it that way.
- Scope the R2 token to the single state bucket (Object Read & Write), not the whole account.
