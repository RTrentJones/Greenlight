# Phase 6 — CLI completion: init / add / doctor (+ adopt stub)

> **Parent:** [greenlight-v1.md](greenlight-v1.md) §16 Phase 6. **Goal:** complete the CLI surface. Most of this is local logic and is fully validated; the cred-dependent bits (live token validation, terraform apply, first deploy, DNS/drift/cap checks) are gated/deferred.

## What was built

- **`config-io.ts`** — `serializeConfig` (rewrite the whole `greenlight.config.ts` from the data model — robust, no fragile text-splicing) and `addTool` (validates the new entry against the schema's lane × target × data matrix). `scaffoldConfig` emits a minimal starter (blog only).
- **`greenlight init --domain <d> [--*-token ..] [--force]`** — writes `greenlight.config.ts` (gitignored; personal) + `.greenlight/secrets.env` (gitignored, `0600`) from token flags. Idempotent (`--force` to overwrite). Live token validation + terraform + first deploy are printed as deferred next-steps (need creds).
- **`greenlight add <name> --lane --target [--data --auth --envs]`** — validates the combo via `addTool`, copies the lane template (`tools/_template-<lane>[/<target>]`) into `tools/<name>`, appends the manifest entry.
- **`greenlight doctor`** — loads/validates the manifest, then checks tool-dir existence and mcp `verify.config.ts` presence; lists cred/infra-dependent checks (DNS, terraform drift, Vercel caps, keepalive, OCI PAYG, framework-version drift) as **skipped** until their phases.
- **`greenlight adopt`** — stub pointing at Phase 9.

## Validatable now vs deferred

- **Validated locally:** `serializeConfig` round-trips through `loadConfig`; `addTool` accepts in-matrix / rejects out-of-matrix / rejects dupes; `runDoctor` flags missing dirs + missing mcp verify specs (unit tests). End-to-end smoke in the repo: `init` → `add demo-mcp --lane mcp --target oci` (copies template + serializes entry) → `doctor` (green except the expected `verify.config` warn) — then cleaned up.
- **Deferred (needs creds):** live token validation against providers, `terraform apply`, first deploy, and doctor's DNS/drift/cap/keepalive/PAYG checks → Phase 5/7/8.

## Notes

- Templates are read from `tools/_template-*` (repo-relative) for now; once the CLI is a published package (Phase 7) it materializes templates from inside the package.
- `greenlight.config.ts` is gitignored (a real manifest is personal — the framework ships only `.example`).

## Acceptance — met (within no-creds reality)

- `init` scaffolds a valid manifest + secrets store; `add` scaffolds a tool and a valid manifest entry (matrix-enforced); `doctor` is green on a healthy repo and flags inconsistencies.
- `pnpm run check-all` green.
- The "cold clone → init → first deploy from docs alone" acceptance is met *up to* the deploy step, which is gated on Cloudflare creds (Phase 6 init captures the token; the deploy executes once creds + DNS exist — Phase 5/7).
