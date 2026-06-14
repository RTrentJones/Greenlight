# Phase 5 — Terraform / infra as code (module + credless verification)

> **Parent:** [greenlight-v1.md](../greenlight-v1.md) §16 Phase 5. **Goal:** the reusable `module "tool"`, **fully verified with no creds and no cloud resources** (mock-provider tests), with real `apply` delegated to the wrapper.

## The testing strategy (answering "won't it break something?")

The clean test isn't a sandbox account — it's **not touching a cloud at all**:

- **`terraform test` + `mock_provider`** — instantiate the module, run `plan` with mocked Cloudflare/GitHub providers, assert outputs + per-env fan-out. No creds, no resources, runs in CI. Catches config/wiring/matrix bugs (the bulk of breakage).
- **`terraform fmt -check` + `validate`** — formatting + schema/reference correctness (`init -backend=false`, no creds).
- **`tfsec`** (advisory in CI) — dangerous-config scan.

Real `apply` against real accounts is the **wrapper's** job (§15.4): the framework publishes the module (source-ref pinned); the wrapper's `infra/` instantiates it with real backend/tokens and runs `plan`-on-PR / gated `apply`-on-merge. The framework repo never holds a real token. When you want a real integration test, do it **once, isolated**: a test Cloudflare account on free **`workers.dev`** (no domain, ~$0) + a separate R2 state bucket + a least-privilege scoped token; add a throwaway domain only for DNS/Access.

## What was built

- **`infra/modules/tool`** — `versions/variables/main/outputs.tf`. Provisions the cross-cutting pieces every tool needs: a **Cloudflare DNS record per env** (plug-and-play subdomain; CNAME-at-apex via flattening for the blog) and a **GitHub deployment environment per env**. Outputs `prod_url`/`beta_url` matching `resolveUrl`, plus `record_count`/`env_count`.
- **`infra/examples/single-tool`** — example root (the shape the wrapper's `infra/` follows — one module block per tool) + `tests/tool.tftest.hcl` (3 mock tests).
- **CI `infra` job** — `fmt -check` → `init -backend=false` + `validate` → `terraform test` → advisory `tfsec`.
- **`pnpm infra:test`** convenience script; `infra/README.md`.

## Scope note

The module is intentionally **minimal-but-real**: DNS + GitHub env now. Target/data-specific resources (Workers custom domain, Tunnel ingress for `oci`, D1/KV, Vercel/Supabase projects) are added incrementally as those lanes mature (Phase 8/9). This matches the extraction ethos — provision what the two real tools + blog need, expand when a real tool needs more.

## Verified (ran locally, no creds)

```
cd infra/examples/single-tool
terraform init -backend=false   # downloads cloudflare ~>5 + github ~>6
terraform validate              # Success! The configuration is valid.
terraform test                  # 3 passed, 0 failed (mock providers)
```
Tests assert: subdomain URLs (`https://ping-mcp.example.dev` / `beta.…`), apex/blog URLs, and one DNS record + one GitHub env per env in `envs`.

## Acceptance — met

- `module "tool"` exists; `terraform validate` + `terraform test` (mock) pass with no creds.
- CI `infra` job verifies fmt/validate/test + advisory scan.
- Adding a tool is one module block (the example shows the shape; `greenlight add` appends it in the wrapper's `infra/` later).

## Deferred

- Real `plan`/`apply`, R2 backend, DNS/Access, drift detection → **wrapper** (Phase 7+), with the safety rails in `infra/README.md`.
- Target/data-specific resources → Phase 8/9.
