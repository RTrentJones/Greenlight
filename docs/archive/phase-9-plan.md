# Phase 9 — The two planes: infra editor + validation gate (implementation record)

> **Parent:** [greenlight-v1.md](greenlight-v1.md) §15 (distribution) / §8 (CLI) / §11 (verify). **Goal of this doc:** what Phase 9 built and why, the deferred outward steps, and how it's verified. Written as a record (the code landed) rather than a forward plan.

## Objective

Greenlight matured into **two related planes over one shared spine** (the manifest + the CLI + the agent kit):

- **Plane 1 — the infra editor.** A provider-pack registry makes `greenlight add`/`adopt` a one-stop, declarative IaC editor: one manifest entry → emitted Terraform + gathered/verified tokens + wired agent kit. **The CLI edits declarative IaC; CI/CD applies it.** Nothing here runs `terraform apply`/deploy.
- **Plane 2 — the validation gate.** The verify harness gains `test`, `agent-web`, and (stretch) `eval` modes, and a `verify.config.ts` can combine modes as an array — so the promote gate is real beyond URL smoke checks.

Plus **Plane 1b — poly-repo packaging:** `adopt` now wraps an external tool repo as a `tools/<name>` git submodule (infra edited in the wrapper; the loop kit pushed back into the tool repo), with the prior self-contained behavior preserved behind `--standalone`.

## What landed

### Plane 1 — provider-pack registry ([`cli/src/providers.ts`](../cli/src/providers.ts))

One `ProviderPack` per provider declares everything onboarding needs in one place: tokens (+ scopes + a fail-fast `verify()`), the deep-guide pointer, MCP server(s), the agent skill, and the Terraform module(s) it references. Six live packs: **cloudflare, vercel, supabase, hcp, github, oci**. Adding a new free-tier backend = write one pack.

- `agent-kit.ts` now sources MCP from the packs (`recommendedMcp` → `mcpForTool`), behavior-preserving. `McpServer` moved to `providers.ts` to keep the dependency acyclic.
- **`greenlight add`** is the IaC editor ([`cli/src/commands/add.ts`](../cli/src/commands/add.ts)): manifest entry → emit `infra/<name>.tf` module blocks ([`cli/src/tf-emit.ts`](../cli/src/tf-emit.ts), generalizing the live `heistmind.tf` + `adopt`'s `infraTf`) + scaffold `infra/main.tf` when absent → gather + fail-fast-verify tokens ([`cli/src/tokens.ts`](../cli/src/tokens.ts)) → materialize the kit (MCP + per-provider skills + loop block). **No apply.**
- **`greenlight init`** gains registry-driven interactive base-token gathering (TTY only; CI keeps the `--*-token` flags).
- Six per-provider skills in `.claude/skills/provider-*` (+ mirrored to `plugin/skills/`, bundled into the CLI). `copy-assets` + `skillAssetDir` generalized to ship all skills; `MODULE_REF` centralized in [`cli/src/version.ts`](../cli/src/version.ts) (fixing `adopt`'s stale `v0.1.0` pin).

### Plane 1b — `adopt` reconciled into two modes ([`cli/src/commands/adopt.ts`](../cli/src/commands/adopt.ts))

- **Default (wrapper-centric, the proven HeistMind model):** `git submodule add <repo> tools/<name>`; the wrapper manifest gets an external pointer with `dir: "tools/<name>"`; infra + verify spec are emitted in the **wrapper**; the Greenlight loop kit (loop skill + provider skills + tailored `.mcp.json` + CLAUDE block + a `greenlight` npx script) is pushed **into the tool repo** so it travels with the submodule. The tool keeps its own history + deploy.
- **`--standalone`:** the prior behavior — scaffold the full self-contained consumer (config + merged package.json + vendored tarballs + infra + namespaced workflows + verify + kit) into the tool repo.

| lane/target | wrapper infra | deploy owner | tool-repo kit | verify modes |
|---|---|---|---|---|
| next/vercel (HeistMind) | vercel + supabase + dns + keepalive | Vercel git-integration | loop + vercel + supabase | test + agent-web |
| mcp/oci (BAMCP) | oci/tunnel + keepalive | OCI (tool CI) | loop + oci | mcp (+ eval) |
| astro/workers (blog) | tool(workers) | wrangler | local (in wrapper) | api |

### Plane 2 — extensible validation ([`packages/verify/src/`](../packages/verify/src/))

`verify(baseUrl, spec)` still dispatches on `spec.mode`; three modes added (all additive, lazy-imported):

- **`test`** — run the tool's own unit/integ command in its dir, gate on the exit code (same harness CI + the agent call).
- **`agent-web`** — an LLM drives the live UI via Playwright to accomplish a task, then assertions (`urlContains`/`textContains`/`selector`) confirm the outcome. Optional deps (`playwright` + `@anthropic-ai/sdk`) are lazy; a missing dep or `ANTHROPIC_API_KEY` yields a failing check, not a throw.
- **`eval`** (stretch) — call an MCP tool and an injectable judge scores the result against a rubric (1–5 + pass). Default `llmJudge` (lazy SDK + key); deterministic judge for tests.
- **Array-of-specs:** a `verify.config.ts` can export `[test, api, agent-web]`; `verifyAll`/`allPass` aggregate and the verify + preview commands gate on all-pass.

## Distribution

`@rtrentjones/greenlight*` is publish-ready: `pnpm build:packages` is green and the `publishConfig` dist-swap + bundled assets (templates + all skills) are verified in the tarball. Distribution is **npm** (JS packages) · **git tags** (Terraform modules, pinned by `MODULE_REF`) · **plugin marketplace** (skills).

## Deferred (outward-facing — need a credential or a live push)

| Item | Why deferred | Unblock |
|---|---|---|
| `npm publish` the 6 packages + swap wrapper `file:vendor` → npm | Needs npm auth; irreversible/public | `npm login`, then `pnpm -r publish --access public` |
| Live HeistMind submodule wrap + push the kit to the HeistMind repo | Outward (mutates another repo) | run `greenlight adopt heistmind --repo <url> --lane next --target vercel --data supabase` in the wrapper |
| Live `agent-web` proof against HeistMind | Needs `@anthropic-ai/sdk` installed + `ANTHROPIC_API_KEY` (LLM cost, hits the live site) | install the SDK + set the key, add the scenario to the heistmind verify config |

## Verification

- **Plane 1:** `greenlight add demo --lane next --target vercel --data supabase` in a temp wrapper emits the manifest entry + `infra/demo.tf` (supabase/vercel/dns module blocks, creds flowing from module outputs) + scaffolded `main.tf` + merged `.mcp.json` + the right provider skills — **without applying**. Unit tests: registry, tf-emit, tokens.
- **Plane 1b:** `adopt` tests cover both modes (the wrapper-centric test pre-creates `tools/<name>` to exercise the infra-in-wrapper + kit-in-tool split without real git; `--standalone` scaffolds into the tool).
- **Plane 2:** unit tests per handler — `test` (exit-code + summary), `agent-web` (honest degradation without dep/key), `eval` (end-to-end against an in-process stub MCP server with a deterministic judge).
- `pnpm run check-all` green throughout (97 tests; seam + boundaries clean).
