# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Status: built, published, and live on two tools

The skeleton/seam, the deploy→verify→promote loop, the verify harness, and both planes are built,
pass `check-all`, and are **published**: `@rtrentjones/greenlight` on npm (OIDC trusted publishing)
+ source-ref-pinned Terraform modules, **lockstep** with the npm version via `MODULE_REF`
([cli/src/version.ts](cli/src/version.ts)). **Plane 1 (infra editor):** a provider-pack registry
([cli/src/providers.ts](cli/src/providers.ts)) makes `add`/`adopt` a one-stop declarative IaC editor
— one manifest entry → emitted Terraform + gathered/verified tokens + wired kit. **The CLI edits
IaC; CI/CD applies it.** **Plane 2 (validation gate):** verify modes `api | mcp | playwright | test
| agent-web | eval`, combinable via a `verify.config.ts` array. **Both tools run the full loop end to
end:** BAMCP (`mcp`/`oci`, free A1 container, auto-healed, direct-to-prod) and HeistMind
(`next`/`vercel`/`supabase`, prod ship-gate + authenticated Playwright deploy-gate). See
[docs/architecture.md](docs/architecture.md) for the as-built architecture,
[docs/development.md](docs/development.md) for how to work in the repo, and
[docs/archive/](docs/archive/) for the per-phase build records.

## Commands

- Toolchain pinned in `mise.toml` (Node 24, pnpm 10.12.1): `mise install` / `mise upgrade`. Engines floor `>=22`.
- `pnpm install` — install workspace deps.
- `pnpm build` — typecheck all packages via Turbo (dev consumes packages from source; `main`→`src`).
- `pnpm build:packages` — tsup-emit `dist/` + copy CLI assets (templates, skills, **plugin mirror**). **One published package: `@rtrentjones/greenlight` (the CLI)** — it bundles the framework libs (`shared/verify/adapters/loop`, tsup `noExternal`); those + `keepalive` are `private`. Publish is OIDC Trusted Publishing via `.github/workflows/release.yml` (no `NPM_TOKEN`). `pnpm --filter @rtrentjones/greenlight pack` to inspect the tarball.
- `pnpm test` — Vitest across the workspace. Single file: `pnpm test packages/shared/src/__tests__/schema.test.ts`. Watch: `pnpm test:watch`.
- `pnpm lint` / `pnpm lint:fix` — Biome (single quotes JS/TS, double JSX).
- `pnpm check-seam` / `pnpm check-boundaries` / `pnpm check-plugin-sync` — the guards: no personal data (domain/email) in a framework file (rule 15.2.1), consumer→framework import direction (15.2.2), and `plugin/skills` mirrors `.claude/skills`.
- `pnpm run check-all` — the full suite CI runs. **Use `run`** — `pnpm ci` hits a reserved pnpm builtin.
- `node scripts/release.mjs <version>` — the **lockstep bump**: writes `MODULE_REF` + every workspace `package.json` version, runs check-all. Does NOT tag/push (publish stays gated). In a consumer, `greenlight bump` re-pins infra `?ref=` + the npm dep to the installed version.

CLI surface (`pnpm greenlight …`, or `npx @rtrentjones/greenlight` in a consumer). Commands are idempotent; full list via `greenlight help`:
- `add <name> --lane --target [--data --auth --envs]` — the **IaC editor** (above). **Edits IaC; never applies** — push, and CI (`infra.yml`) runs `terraform apply`. `greenlight lanes` lists the valid lane × target × data matrix.
- `secrets gather <name> [--repo o/r] [--env e]` — guided, hidden-input token prompts straight to GitHub Actions secrets (no disk/argv/logs). `secrets check [<name>]` flags missing ones. **GitHub Actions is the single secret store** — no local secret file.
- `adopt <name> --repo <url|path> --lane --target [--standalone]` — poly-repo onboarding: wrapper-centric (`tools/<name>` submodule + infra in the wrapper) or `--standalone` (self-contained consumer). App code untouched. See [greenlight-v2.md](greenlight-v2.md) + [docs/architecture.md](docs/architecture.md).
- `agent sync [<name>]` — materialize the agentic dev loop kit (deploy-verify-promote skill + per-provider skills + `.mcp.json` + CLAUDE.md block) into a repo. Cross-repo via the Claude Code plugin: `/plugin marketplace add RTrentJones/greenlight`.
- `preview | verify | promote | status | deploy | migrations scan | doctor [--live] [--strict] | config` — the rest of the loop.

## Development loop (deploy → verify → promote)

Every change to **any** tool (web or MCP) ships through **one model** — the agent's execution
discipline. Same shape for all; only the lane×target matrix cells vary (the
[deploy-verify-promote skill](.claude/skills/deploy-verify-promote/SKILL.md) carries the matrix):
branch → change → **`preview` (local gate)** → **add it to the tool's verify.config** → push (CI
**gates on the tool's own tests**) → deploy → `verify --env prod`. Web tools also get beta +
`promote` (gated `develop→main` FF); **oci is direct-to-prod** (no beta on the free tier — the local
gate + ship-gate are the pre-prod safety). The `verify` gate (same code CI runs) is what lets
long-running, semi-autonomous changes ship with objective confidence.

Quick reference: `pnpm greenlight preview <name>` (spin up locally + verify — the local gate; oci
uses the manifest's `preview` descriptor / docker, others build+serve); `pnpm greenlight verify
<name> --env beta|prod` (or `--url <local>`); `pnpm greenlight promote <name>`; `pnpm greenlight
status <name>` (the ship/deploy/verify run chain across repos); `pnpm greenlight doctor [--strict]`
(flags any tool drifting from the model — missing verify spec, local-preview gate, version-ref
drift, or an unguarded migrations dir; `--strict` fails on warnings for CI). Cross-repo (adopted
BAMCP etc.), the skill ships as the Greenlight Claude Code **plugin**; mechanics ride the
`@rtrentjones/greenlight*` npm deps.

## Specs & background

- **[greenlight-v2.md](greenlight-v2.md) is the executable spec — build from this.** It reflects the as-built framework + the forward aims; V1 ([docs/archive/greenlight-v1.md](docs/archive/greenlight-v1.md)) is the historical record. Treat v2 as the source of truth; if reality forces a deviation, update v2 in the same change.
- **[docs/archive/greenlight-design-doc-v0.md](docs/archive/greenlight-design-doc-v0.md)** is the original full provider-agnostic vision (north star, not the V1 build target).
- **Provider specifics** (tokens, scopes, footguns, TF modules) live in the per-provider skills under [.claude/skills/](.claude/skills/) + [docs/tokens-reference.md](docs/tokens-reference.md) — pointers, not restated here.

**V1 was extracted from two real, already-built tools that kept timing out** — BAMCP (stateful MCP on OCI, idle-reclaimed) and HeistMind (Next.js + Supabase on Vercel, DB pauses after 7 days). Its whole reason for being is to make them stay alive on their own and make (re)wiring declarative. An extraction, not speculation. **Consumers install the CLI, not fork the repo:** `greenlight init` scaffolds a thin wrapper (manifest + content) depending on the published package, updated via `pnpm update` — they own the wrapper, never merge framework code ([docs/getting-started.md](docs/getting-started.md)).

## Architecture & scope (the load-bearing ideas — full detail in v2 §3–§14)

Read [greenlight-v2.md](greenlight-v2.md) §3–§14 (or design-doc-v0 §4–§13 for the full vision) +
[docs/architecture.md](docs/architecture.md) before non-trivial work. The ideas that drive most
decisions: the **manifest as single source of truth** (`greenlight.config.ts` drives both the CLI
and Terraform — keep manifest ↔ tool dir ↔ workflow consistent, a `doctor` check); the orthogonal
**`lane` × `target`** axes + matrix; the **deploy-target adapter contract** (`build`/`deploy`/
`url`/`teardown` — switching targets is config, not a rewrite); **MCP servers as a first-class
lane** (protocol-level verify, connect at `<name>.<domain>/mcp`); **verification wired to
promotion** (one `verify(baseUrl, spec)` harness, same code in CI and the agent loop); **three
git-mapped envs** standardized to `main`/`develop` (keep to `develop`, never `development`); and
**keepalive as a Cloudflare Worker Cron Trigger** (immune to repo-inactivity disable). A few
specifics worth pinning here:

- **Lanes** `astro | next | mcp | agent`; **targets** `workers | vercel | oci | docker`; **data** `none | d1 | kv | supabase | neon`. Source of truth + allowed combinations: the `packages/shared` schema (`greenlight lanes`). Defaults: `next`→vercel; `astro`/`mcp`/`agent`→workers. `mcp` may also target `oci` (free-tier container) or `docker` (a host you own — same image, no idle-reclaim).
- **Data defaults to Neon** (branch-per-env Postgres, scale-to-zero + auto-resume → **no keepalive**). Supabase only for bundled auth+storage+realtime together (schema-per-env + a keepalive heartbeat, since Supabase pauses after 7 days and branching is paid).
- **OCI idle-reclaim: stay on the free tier** — restart-policy ALWAYS + keepalive health-check + alert → re-apply/redeploy restores it. PAYG is an optional last resort ([docs/oci-payg-runbook.md](docs/oci-payg-runbook.md)), **not** the fix. Never imply the harness *prevents* reclaim.
- **The blog must never use Supabase / any pausing store** — D1/KV or external (giscus, Resend) only; it must stay up unattended.
- **Existing tools are adopted, not rewritten** — `adopt` adds manifest + verify spec + CI wiring and imports infra by reference (`adopted: true`); app code untouched.

## Secrets & security (non-negotiable)

Tokens are entered once, fail-fast validated, and stored **only** in provider stores — **GitHub
Actions secrets/environments are the single store** (Cloudflare/Vercel/Neon/Supabase creds ride
Terraform vars); **never committed or echoed**, no local secret file. Enumerable IDs
(zone/account/project) are repo **variables**, not secrets. Prefer GitHub OIDC → cloud over
long-lived Actions secrets. `private` tools + all `beta.*` sit behind Cloudflare Access;
mutating/private MCP servers default to `bearer`/`oauth`, never `none`. Migrations pass a
dangerous-SQL scan gate (`greenlight migrations scan`) in the applying CI. Full reference:
[docs/security.md](docs/security.md) + [docs/tokens-reference.md](docs/tokens-reference.md).

## Key locked decisions (design-doc §17)

Name **Greenlight**; blog default target **workers**; `next` lane defaults **vercel**; **Supabase**
for bundled auth+storage+realtime, **Neon** the default branch-per-env Postgres (both built);
Terraform state on **HCP Terraform** (free tier, local execution); MCP transport **streamable
HTTP**, `auth: none` only for public read-only; **MIT, public from day one**. Identity: GitHub
`RTrentJones/greenlight`, npm `@rtrentjones/greenlight` (bin `greenlight`), docs dogfooded at
`greenlight.rtrentjones.dev`.

**Deliberate trade-offs (personal-use scope, see [docs/architecture.md](docs/architecture.md)
"Trade-offs & deliberate constraints"):** GitHub Actions is the only CI + the single secret store
(no CI-provider abstraction); npm version and `MODULE_REF` move in **lockstep** (an infra-only
hotfix still cuts a CLI release). Both are intentional; each has a noted future-generalization path.
