# Phase 3 — CI/CD + the promote gate (implementation plan)

> **Parent:** [greenlight-v1.md](../greenlight-v1.md) §16 Phase 3. **Goal:** wire the loop into GitHub Actions (deploy + promote + alert) with the `canPromote` fast-forward guard performing the actual gated `develop → main` promotion.

## Reality check (what's validatable now)

We develop on **main** until Phase 7; there is no `develop` branch and no Cloudflare creds yet. So:

- **Validatable now:** the `promote` *mechanics* — `canPromote` (done) + the actual fast-forward — tested against a temp git repo; the `greenlight deploy` CLI command's build step; workflow YAML correctness.
- **Authored but dormant until Phase 5/6/7:** the live `develop → beta → prod` cloud flow. Deploy steps are **creds-guarded** — they skip cleanly (not red-fail) until `CLOUDFLARE_API_TOKEN` exists. The `develop`-triggered jobs simply don't fire until the branch exists (Phase 7).
- **Deferred:** Cloudflare Access on `beta.*` — that's Terraform (Phase 5), not a workflow.

This keeps Phase 3 honest: build the machinery, validate its core locally, and let the live end-to-end run light up in Phase 7.

## Deliverables

1. **`promote()` (loop package)** — given an eligible repo (`canPromote` true), fast-forward `to` (`main`) to `from` (`develop`) and (optionally) push. Refuses otherwise. Tested in a temp repo.
2. **CLI**
   - `greenlight deploy <name> --env <beta|prod|preview>` — resolve entry → adapter → `build` + `deploy`, print the URL. (Real deploy needs creds; build runs regardless.)
   - `greenlight promote <name>` — default = eligibility check (Phase 1 behavior); `--perform` = run the fast-forward; `--push` = also push `main`.
   - `manifest.resolveEntry` now also returns `target` + `dir` (`apps/blog` for the blog, `tools/<name>` for tools).
3. **Workflows**
   - `deploy.yml` — `push` to `develop` (→ beta) / `main` (→ prod) and `pull_request` (→ preview). Creds-guarded `greenlight deploy` + `greenlight verify`; skips with a notice when no `CLOUDFLARE_API_TOKEN`.
   - `promote.yml` — `workflow_dispatch(name)`: verify beta (guarded) → `greenlight promote <name> --perform --push` → verify prod (guarded). `contents: write`.
   - `alert.yml` — reusable (`workflow_call`) that opens a GitHub issue; `deploy`/`promote` call it on failure (the `github-issue` sink, zero new vendor).

## Ordered tasks

1. This plan.
2. `promote()` + tests (loop).
3. `resolveEntry` (+ `target`/`dir`) and `greenlight deploy`; wire `promote --perform/--push`.
4. `deploy.yml`, `promote.yml`, `alert.yml` (creds-guarded; `alert` reusable).
5. `pnpm run check-all` green + commit to main.

## Acceptance

- `promote()` performs a fast-forward when eligible and refuses a diverged `main` (tested in a temp repo).
- `greenlight deploy blog --env prod` builds the blog (deploy step errors clearly without creds — expected).
- `greenlight promote blog --perform` fast-forwards locally when `develop` is ahead; the default (no `--perform`) only reports eligibility.
- Workflows are syntactically valid and creds-guarded (no red-fail without secrets); `promote.yml` runs the guard before promoting and verifies prod after.
- `pnpm run check-all` green.

## Explicitly out (until later)

- Live `develop → beta → prod` validation and Cloudflare Access → **Phase 5/6/7** (creds + DNS + the personal repo / branch flip).
