# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: the loop + the two planes are built (Phase 9 landed)

The skeleton/seam (Phase 0), the deploy→verify→promote loop, the verify harness, and the two planes are built and pass `check-all`. **Plane 1 (infra editor):** a provider-pack registry ([cli/src/providers.ts](cli/src/providers.ts)) makes `greenlight add`/`adopt` a one-stop declarative IaC editor — one manifest entry → emitted Terraform + gathered/verified tokens + wired kit. **The CLI edits IaC; CI/CD applies it.** **Plane 2 (validation gate):** verify modes `api | mcp | playwright | test | agent-web | eval`, and a `verify.config.ts` may export an array to combine them. See [docs/phase-9-plan.md](docs/phase-9-plan.md) for the record and [docs/development.md](docs/development.md) for how to work in the repo. Deferred (need a credential/live push): `npm publish` + the live HeistMind submodule wrap (phase-9-plan §Deferred).

## Commands

- Toolchain pinned in `mise.toml` (Node 24, pnpm 10.12.1): `mise install` to set up, `mise upgrade` to bump. Engines floor `>=22`.
- `pnpm install` — install workspace deps.
- `pnpm build` — typecheck all packages via Turbo (dev consumes packages from source; `main`→`src`).
- `pnpm build:packages` — tsup-emit `dist/` for the 6 publishable packages (adapters, keepalive, loop, shared, verify + the `greenlight` CLI; publishing path — `publishConfig` swaps the published pointers to `dist`). `pnpm pack` per package to inspect a tarball.
- `pnpm greenlight add <name> --lane --target [--data --auth --envs]` — the **IaC editor**: add a manifest entry, emit `infra/<name>.tf` module blocks (scaffold `infra/main.tf` if absent), gather + fail-fast-verify the providers' tokens, and materialize the kit (MCP + per-provider skills). **Edits IaC; never applies** — commit + push and CI (`infra.yml`) runs `terraform apply`.
- `pnpm greenlight secrets sync [--repo o/r] [--env <env>]` — push `.greenlight/secrets.env` to GitHub Actions secrets via `gh` (the "init writes to provider stores" piece). Branches/protection/environments are Terraform (`infra/modules/repo`).
- `pnpm greenlight agent sync` — materialize the agentic dev loop kit (deploy-verify-promote skill + per-provider skills + `.mcp.json` + CLAUDE.md block) into a repo. The kit (skills + MCP servers + best practices) is [docs/agentic-loop.md](docs/agentic-loop.md); cross-repo via the Claude Code plugin: `/plugin marketplace add RTrentJones/greenlight`.
- `pnpm greenlight adopt <name> --repo <url|path> --lane <l> --target <t> [--data --auth --envs] [--standalone]` — poly-repo onboarding, two modes. **Default (wrapper-centric):** wrap the tool repo as a `tools/<name>` git submodule, edit its infra in the wrapper (`infra/<name>.tf` + `verify/<name>.config.ts`), and push the loop kit back into the tool repo; register an `external` pointer with `dir: "tools/<name>"`. **`--standalone`:** scaffold the full self-contained consumer (merged `package.json` + vendored tarballs + infra + namespaced workflows + verify + kit) into the tool repo, app code untouched. Run from your site repo. See greenlight-v1.md §8 and [docs/phase-9-plan.md](docs/phase-9-plan.md).
- `pnpm test` — Vitest across the workspace. Single file: `pnpm test packages/shared/src/__tests__/schema.test.ts`. Watch: `pnpm test:watch`.
- `pnpm lint` / `pnpm lint:fix` — Biome (single quotes for JS/TS, double for JSX).
- `pnpm check-seam` — fail if personal data (domain/email) leaks into a framework file (rule 15.2.1).
- `pnpm check-boundaries` — dependency-cruiser: enforce consumer→framework import direction (rule 15.2.2).
- `pnpm run check-all` — the full suite CI runs. **Use `run`** — `pnpm ci` hits a reserved pnpm builtin.
- `pnpm greenlight config` — load + validate + print the manifest (CLI via tsx).

## Development loop (deploy → verify → promote)

Changes to a tool or the blog are shipped through the loop — it's the agent's execution
discipline, run as part of the dev cycle (in Claude Code CLI/IDE/web). The full procedure
is the [deploy-verify-promote skill](.claude/skills/deploy-verify-promote/SKILL.md):
branch → make change → deploy preview → `verify` → beta → `verify` → `promote` (gated
`develop→main` fast-forward) → prod → `verify`. The `verify` gate (same code CI runs) is
what lets long-running, semi-autonomous changes ship with objective confidence.

Quick reference: `pnpm greenlight preview <name>` (build + serve locally + verify in one
command, no readiness race); `pnpm greenlight verify <name> --env beta|prod` (or `--url
<local>`); `pnpm greenlight promote <name>`. URL scheme + modes-by-lane are in
the skill. Cross-repo (standalone BAMCP etc.), this skill ships as the Greenlight Claude
Code **plugin** (Phase 7); mechanics ride the `@rtrentjones/greenlight*` npm deps.

## Specs & background

- **[greenlight-v1.md](greenlight-v1.md) is the executable spec — build from this.** It is the narrowed, buildable slice and includes a phased implementation plan (§15) ordered stop-the-bleeding-first. Treat it as the source of truth; if reality forces a deviation, update it in the same change.
- **[docs/archive/greenlight-design-doc-v0.md](docs/archive/greenlight-design-doc-v0.md)** is the original full provider-agnostic vision (north star, not the V1 build target). Anything V1 defers (Neon, `hono` lane, provider-agnostic target-switching, standalone eject) lives there.

**V1 was extracted from two real, already-built tools that keep timing out** — BAMCP (stateful MCP on OCI, idle-reclaimed) and HeistMind (Next.js + Supabase on Vercel, DB pauses after 7 days). V1's whole reason for being is to make them stay alive on their own and make (re)wiring declarative. This is an extraction, not speculation.

There are no build/lint/test commands yet because nothing is built. As tooling lands (pnpm + Turborepo per the plan), update this section with the real commands (including how to run a single test).

## What Greenlight is

A clone-and-own baseline that turns a domain + API tokens into a live personal site plus a self-verifying AI deploy loop, with plug-and-play subdomain tools that are **either web apps or MCP servers**. It is provider-agnostic and explicitly *not* a hosted PaaS/control plane — it orchestrates existing providers via files the user owns.

## V1 build scope (what to actually build first)

The load-bearing ideas below describe the *full* design. **V1 builds a deliberate subset** — see [greenlight-v1.md](greenlight-v1.md) §2/§4/§15:

- **Lanes:** `next`, `mcp`, `astro` only. **Targets:** `vercel`, `oci`, `workers` (incl. `mcp`→`workers` as a dev/throwaway target so the MCP loop can be developed without a live OCI box). **Data:** `supabase` (HeistMind only) + `none`/`d1`/`kv` (blog). Everything else (Neon, `hono`, `docker`, target-switching) is V0/V2.
- **Build order is framework-and-loop-first** (§16): the deploy→validate→iterate loop comes first; **blog is the first loop subject, the MCP loop is second.** Both real tools (BAMCP, HeistMind) are currently down and are *migration targets in later phases* — keepalive and adoption are deferred, not first.
- **Distribution = published packages** (chosen, §15): the framework ships as `@rtrentjones/greenlight*` npm packages + a source-ref-pinned Terraform module. The **personal repo is a thin consumer** that depends on those packages and updates via `pnpm update` — no merging framework code. Two hard rules keep the seam honest: (1) no personal value (domain/token/tool name) in any framework file — CI enforces this; (2) no load-bearing logic outside `packages/*` and `cli/`. `greenlight init` is the transform from "the baseline" to "someone's setup."
- **The OCI idle-reclaim fix is manual, not code** — convert the tenancy to Pay-As-You-Go (+ a billing alarm); the harness only health-checks and nags via `doctor`. Never imply the harness prevents OCI reclaim automatically.
- **The blog must never use Supabase** for state (Supabase pauses; the blog must stay up unattended) — use D1/KV or external services (giscus, Resend).
- **Existing tools are adopted, not rewritten** — `greenlight adopt` adds manifest + verify spec + CI wiring and imports infra by reference; app code is untouched (`adopted: true`).

## Core architecture (the load-bearing ideas)

These concepts span many files and drive most decisions. Read greenlight-v1.md §3–§14 (or V0 §4–§13 for the full vision) before non-trivial work.

- **The manifest is the single source of truth.** `greenlight.config.ts` (`defineConfig`) lists the domain, blog, and every tool with its `{ lane, target, data, auth, access, envs }`. The CLI and Terraform are both driven by it; adding a tool is one manifest entry + scoped `terraform apply`. Keep manifest ↔ tool dir ↔ workflow consistency (this is one of `doctor`'s checks).

- **Two orthogonal axes: `lane` × `target`.**
  - `lane` = what the tool *is*: `astro | hono | next | mcp | docker`.
  - `target` = where it *runs*: `workers | vercel | oci`.
  - See the lane×target×data matrix in design-doc §7 for allowed combinations and defaults (e.g. `next` defaults to `vercel`; `mcp` defaults to `workers`).

- **The deploy-target adapter contract is the product; frameworks are swappable.** Every target implements the same four hooks: `build`, `deploy(toolDir, env)->{url}`, `url(toolName, env)->string` (deterministic — verification targets it without scraping logs), `teardown`. Switching a tool between Workers/Vercel/OCI must be config, not a rewrite.

- **MCP servers are a first-class hostable category**, not an afterthought. They get their own lane and a protocol-level verify mode (initialize → `tools/list` → call a tool & assert shape → assert auth rejection) instead of UI testing. Connect URL is `<name>.<domain>/mcp`.

- **Verification is wired to promotion, not just test-writing.** `packages/verify` exposes one `verify(baseUrl, spec) -> {pass, report}` harness; `spec.mode ∈ api | mcp | playwright | test | agent-web | eval` (URL smoke; MCP protocol; a11y-tree render; the tool's own test command; LLM-driven UI scenarios; LLM-judged MCP quality). A `verify.config.ts` may export an **array** to combine modes (`verifyAll`/`allPass`). `agent-web`/`eval` lazy-load `playwright` + `@anthropic-ai/sdk` (optional) and degrade to a failing check (not a throw) without the dep/`ANTHROPIC_API_KEY`. CI *and* the agent loop call the same harness. The loop: change → preview → `verify` → develop/beta → `verify` → `promote` (gated fast-forward develop→main) → prod → `verify`.

- **Three git-mapped environments, branches standardized to `main` / `develop`.** PR → ephemeral preview; `develop` → beta (`beta.<name>.<domain>`, behind Cloudflare Access); `main` → prod. `promote` is an explicit `workflow_dispatch` fast-forward after beta verify passes. (The doc calls out the `develop` vs `development` naming bug class — keep to `develop`.)

- **Data model defaults to Neon, branch-per-env.** `data ∈ none | d1 | neon | supabase`. Neon is the default Postgres (one project, git-style branches per env, scale-to-zero, no keepalive needed). Supabase only when bundled auth+storage+realtime are needed together (project-per-env + a keepalive heartbeat, since Supabase branching is paid).

- **Liveness is a feature.** `packages/keepalive` is a **Cloudflare Worker Cron Trigger (not GitHub Actions)** — immune to repo-inactivity auto-disable. It runs cheap queries against `data: supabase` DBs, health-checks `target: oci` services, and alerts via `alerts.sink` (`github-issue` or Resend `email`) on failure. OCI Always Free idle-reclaim is solved by converting the account to PAYG, not by pings. See design-doc §13 for the full silent-pause trap table.

## Secrets & security (non-negotiable)

Tokens are entered once, validated (fail fast), and stored **only** in provider stores (GitHub Actions secrets/environments, Cloudflare/Vercel/Neon/Supabase via Terraform vars) plus a local gitignored `.greenlight/secrets.env` — **never committed or echoed to the repo**. Prefer GitHub OIDC → cloud over long-lived Actions secrets. `private` tools and all `beta.*` sit behind Cloudflare Access; mutating/private MCP servers default to `bearer`/`oauth`, never `none`. Migrations get a dangerous-SQL scan gate.

## Planned repo topology

See design-doc §7 for the full tree. Key dirs once built: `cli/`, `infra/` (Terraform root + reusable `tool` module), `apps/blog/`, `tools/` (one dir per subdomain + `_template-{astro,hono,next,mcp,docker}`), `packages/{ui,shared,verify,keepalive}`, `.agent/` (CLAUDE.md, subagents, skills), `greenlight.config.ts`, `.github/workflows/`.

## CLI surface (planned)

`greenlight init | add <name> --lane --target --data [--auth] | verify <name> --env <env> | promote <name> | doctor`. Commands must be idempotent. See design-doc §8 and the worked walkthrough in §15.

## Key locked decisions (design-doc §17)

Name **Greenlight**; blog default target **workers**; `next` lane supports both, defaults **vercel**; **Neon by default everywhere**, Supabase per-tool only when bundled features needed; Terraform state on **R2** with lockfile locking; MCP transport **streamable HTTP**, `auth: none` only for public read-only; **MIT, public from day one**. Identity: GitHub `RTrentJones/greenlight`, npm `@rtrentjones/greenlight` (bin `greenlight`), docs dogfooded at `greenlight.rtrentjones.dev`.
