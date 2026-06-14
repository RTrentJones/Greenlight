# infra/ — config as code

The **framework** ships the reusable Terraform `module "tool"` and verifies its *logic*
with no creds and no cloud resources. The **real `apply`** against real accounts is the
**wrapper repo's** job (greenlight-v1.md §15.4/§15.7), with scoped tokens, the R2 state
backend, and `plan`-on-PR / gated `apply`-on-merge.

```
infra/
  modules/tool/            # the reusable module (one block per tool)
  examples/single-tool/    # an example root + mock-provider tests
    tests/tool.tftest.hcl  # terraform test, providers mocked → plan-only, no creds
```

## Verify locally (no creds, no resources)

```
cd infra/examples/single-tool
terraform init -backend=false
terraform validate
terraform test          # mock_provider — runs plan, asserts URL scheme + per-env fan-out
```

CI runs `terraform fmt -check`, `validate`, `test`, and an advisory `tfsec` scan (the `infra` job).

## Scope (V1)

The module currently provisions the cross-cutting pieces every tool needs: a **Cloudflare
DNS record per env** (the plug-and-play subdomain; CNAME-at-apex via flattening for the blog)
and a **GitHub deployment environment per env**. Target/data-specific resources (Workers
custom domains, Tunnel ingress for `oci`, D1/KV, Vercel projects, Supabase projects) are
added incrementally as their lanes mature (Phase 8/9). Outputs (`prod_url`/`beta_url`) match
`resolveUrl` in `@rtrentjones/greenlight-shared`.

## Real apply (wrapper) — safety rails

- **Separate state** per env (R2 bucket/key); enable R2 object versioning for state backups.
- **Least-privilege scoped tokens** (Cloudflare account/zone, GitHub repo, …).
- **`plan` before every `apply`**, reviewed.
- **`prevent_destroy`** on the state bucket, prod zone, and prod DB.
- One-time real integration test on an isolated **`workers.dev`** (free) / throwaway domain + test GitHub repo before pointing the module at your real domain.
