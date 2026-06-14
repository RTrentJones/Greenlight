# Phase 1 — Verify harness + deploy adapters + the loop (implementation plan)

> **Parent:** [greenlight-v1.md](../greenlight-v1.md) §16 Phase 1. **Goal:** the deploy → validate → iterate loop, runnable end-to-end against a stub, with a verify harness whose reports are identical whether CI or the agent calls them. This is the centerpiece of V1.

## Objective

Implement the three pieces that make "change → deploy → verify → promote" real:

1. **`@rtrentjones/greenlight-verify`** — `verify(baseUrl, spec) → VerifyReport` with `api` and `mcp` modes fully implemented, `playwright` mode light (dynamic, optional). Machine-readable report.
2. **`@rtrentjones/greenlight-adapters`** — the four-hook contract with a **deterministic `url()`** (delegating to a shared resolver) and target skeletons; real cloud `deploy()` lands per-target in Phases 2/4/9.
3. **The loop** — orchestration (`deploy → verify → [promote]`) callable from the CLI (`greenlight verify`, `greenlight promote`) and exercised end-to-end against a **stub tool** with no cloud creds.

**Out of scope:** real Workers/Vercel/OCI deploys (Phase 2/4/9), the GH promote *workflow* (Phase 3 wires the guard implemented here into CI), keepalive, Terraform.

## Deterministic URL scheme (shared)

`@rtrentjones/greenlight-shared` gains a pure resolver — the single source of the URL scheme so `verify` never scrapes deploy logs:

| Subject | prod | beta |
|---|---|---|
| blog (apex) | `https://<domain>` | `https://beta.<domain>` |
| tool | `https://<name>.<domain>` | `https://beta.<name>.<domain>` |
| mcp connect | *(tool url)* `+ /mcp` | same `+ /mcp` |

`preview` is per-target (not derivable from name alone) — the adapter supplies it via `deploy()`/`url(name, "preview")`. The resolver throws for `preview` so callers must go through the adapter.

## Verify modes

- **`api`** — `fetch`-based (Node 24 native fetch). Spec: ordered checks `{ path, status?, contains?, header? }`, plus `rssValid?`, `sitemapValid?`, `noBrokenInternalLinks?`. Each becomes a `VerifyCheck` in the report.
- **`mcp`** — uses `@modelcontextprotocol/sdk` client over Streamable HTTP. Spec: `expectTools: string[]`, optional `call: { name, args, expectShape }`, `requireAuthRejection?: boolean`. Steps: `initialize` → `tools/list` (assert expected names present) → optional `tools/call` (assert result shape) → if `requireAuthRejection`, assert an unauthenticated request is rejected.
- **`playwright`** — *light*. Dynamic-imported so it's optional; spec: `renders: string[]` (paths that must load with a non-empty accessibility tree). Skipped with a clear report note if browsers aren't installed.

`verify(baseUrl, spec)` dispatches on `spec.mode`; the report shape (`{ pass, mode, url, checks[] }`) is stable across all modes — the contract CI and the agent share.

## Adapters

- `Adapter` contract (already defined Phase 0): `build`, `deploy`, `url`, `teardown`.
- **`url()` is real now** for every target — delegates to the shared resolver (beta/prod) and adds per-target preview aliasing.
- `workers` / `vercel` / `oci` skeletons: `url()` implemented; `build`/`deploy`/`teardown` throw a clear "not configured for this target yet (Phase N)" until their phase. A registry maps `Target → Adapter`.
- The loop is **target-agnostic** (takes an `Adapter`), so tests drive it with an in-memory fake adapter + a local stub server — no cloud creds, runs in CI.

## The loop + promote

- `runLoop({ adapter, toolDir, env, spec })` → `{ deploy, report }`: `build → deploy → verify`. Returns non-zero/`pass:false` to gate.
- **Promote guard** (`canPromote(repoDir)`): fast-forward `develop → main` only if `main` is an ancestor of `develop`; otherwise refuse with a reconcile message (the divergence policy from §12). Implemented as a git helper here; Phase 3 calls it from the `promote` workflow.
- CLI: `greenlight verify <name> --env <env>` (resolve URL from manifest + lane→mode, run verify, print report, exit code = pass) and `greenlight promote <name>` (run the guard; in Phase 1 it reports eligibility, Phase 3 triggers the workflow).

## `.agent/` (the runbook)

- `.agent/CLAUDE.md` — the loop runbook: branch → push → `verify $PREVIEW` → merge `develop` → `verify $BETA` → `promote` → `verify $PROD`; records the deterministic URL scheme so an agent never scrapes logs.
- `.agent/skills/deploy-verify-promote/SKILL.md` — the skill wrapping the loop.

## Ordered tasks

1. Shared URL resolver + tests.
2. `verify` `api` mode + report + dispatcher + tests (local http stub).
3. `verify` `mcp` mode + tests (in-process SDK MCP server over HTTP).
4. `verify` `playwright` mode (light, dynamic, skip-if-unavailable).
5. Adapter registry + real `url()` per target + skeleton `deploy`/`build`/`teardown`.
6. `runLoop` + `canPromote` guard + tests.
7. CLI `verify` + `promote` wiring.
8. `.agent/CLAUDE.md` + `deploy-verify-promote` skill.
9. `pnpm run check-all` green + commit.

## Acceptance (Phase 1 is done when…)

- `verify` runs `api` and `mcp` against stub servers and returns a correct machine-readable report (covered by tests); reports are identical whether invoked by CLI or programmatically.
- The mcp check performs the full protocol sequence (initialize → tools/list → call → auth assertion) and passes against the stub.
- `runLoop` drives `deploy → verify` end-to-end against the in-memory adapter + stub (no cloud creds) in CI.
- `canPromote` allows a fast-forward and refuses a diverged `main` (tested).
- `greenlight verify <name> --env beta` resolves the deterministic URL from the manifest and runs the lane-appropriate mode.
- `.agent/CLAUDE.md` + the skill exist and record the URL scheme + loop.
- `pnpm run check-all` is green; the seam + boundary checks still pass.
