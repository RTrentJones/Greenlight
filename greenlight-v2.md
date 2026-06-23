# Greenlight — V2 Spec & Aims

> **This is the live executable spec — build from this.** It reflects the **as-built, published**
> framework and the aims going forward. V1 ([docs/archive/greenlight-v1.md](docs/archive/greenlight-v1.md))
> was the buildable slice and is now the historical record; the original provider-agnostic north star
> is [docs/archive/greenlight-design-doc-v0.md](docs/archive/greenlight-design-doc-v0.md). If reality
> forces a deviation from this doc, **update it in the same change** — it is the source of truth.

## 1. What Greenlight is

A reproducible **deploy + verification harness for AI-built tools.** It turns a domain plus API
tokens into a live personal site and a **self-verifying agentic deploy loop**, with plug-and-play
subdomain tools that are **either web apps or MCP servers**. Provider-agnostic and **free-tier-first**.

It is explicitly **not a hosted PaaS / control plane.** The CLI **edits declarative
infrastructure-as-code (Terraform you can read); your CI/CD applies it.** Nothing is welded to one
cloud, and there is no service in the middle holding your state.

**You install the CLI; you don't fork the framework.** `greenlight init` scaffolds a thin **wrapper
repo you own** (manifest + content) that depends on the published `@rtrentjones/greenlight` package
and updates via `pnpm update` — you never merge framework code. The live example is
[`RTrentJones.dev`](https://github.com/RTrentJones/RTrentJones.dev).

## 2. Status (as-built)

**Built, published, and live.** `@rtrentjones/greenlight` ships on npm via OIDC trusted publishing,
with Terraform modules tagged in **lockstep** (the npm version == the git tag == `MODULE_REF` in
[cli/src/version.ts](cli/src/version.ts)) and skills as a Claude Code plugin. `check-all` is green
(typecheck + lint + tests + seam + boundaries).

**Two real tools run on it end to end**, each adopted as a wrapper-centric subrepo with a green
verify gate:

- **BAMCP** — `mcp`/`oci`, a stateful MCP server on a free-tier Ampere A1 Container Instance, kept
  alive + auto-healed; direct-to-prod.
- **HeistMind** — `next`/`vercel`/`supabase`, with a prod ship-gate (branch protection), an
  authenticated Playwright deploy-gate, and Discord OAuth (a *tool-level* Supabase capability).

Both planes, the uniform loop, the lane templates, the provider-pack registry, CI/CD, the OCI
free-tier path (network-as-IaC), per-tool secret onboarding, and token scoping are all in place.

## 3. Two planes over one spine

The **manifest** (`greenlight.config.ts`) + the **CLI** + the **agent kit** drive two related planes:

- **Plane 1 — the infra editor.** `greenlight add` / `adopt`: one manifest entry → emitted Terraform
  (`infra/<name>.tf`) + gathered & fail-fast-verified tokens (straight to GitHub secrets, never to
  disk or logs) + a wired agent kit (MCP servers + per-provider skills). **It edits IaC; CI/CD
  applies it.** Nothing here deploys.
- **Plane 2 — the validation gate.** One `verify(baseUrl, spec) -> { pass, report }` harness, six
  modes, combinable via an array — wired to **promotion**, not just test-writing. CI **and** the
  agent loop call the same code.

## 4. Architecture (the load-bearing ideas)

- **The manifest is the single source of truth.** `defineConfig` lists the domain, alerts sink,
  optional blog, and every tool. The CLI and Terraform are both driven by it; adding a tool is one
  manifest entry + a scoped `terraform apply`. `doctor` keeps manifest ↔ tool dir ↔ workflow
  consistent.
- **The provider-pack registry is the extension point.** [cli/src/providers.ts](cli/src/providers.ts)
  declares, per provider, everything onboarding needs: tokens (+ least-privilege scopes + a fail-fast
  `verify()`), the deep guide, MCP server(s), the agent skill, and the Terraform module(s) its block
  references. Adding a new free-tier backend = write one `ProviderPack` (see §10).
- **Two orthogonal axes: `lane` × `target`.** `lane` = what the tool *is*; `target` = where it
  *runs*. Plus `data` for its store. The allowed combinations are a matrix (§7).
- **The deploy-target adapter contract is the product; frameworks are swappable.** Every target
  implements the same hooks — `build`, `deploy(toolDir, env) -> { url }`, `url(name, env) -> string`
  (deterministic — verification targets it without scraping logs), `teardown`. Switching a tool
  between Workers/Vercel/OCI is config, not a rewrite.
- **MCP servers are a first-class hostable category** — their own lane and a protocol-level verify
  mode (initialize → `tools/list` → call a tool & assert shape → assert auth rejection), not UI
  testing. Connect URL is `<name>.<domain>/mcp`.

## 5. The manifest (`greenlight.config.ts`)

The schema ([packages/shared/src/schema.ts](packages/shared/src/schema.ts)) is the runtime validator
**and** the source of exported types; it enforces the lane × target × data matrix at load time.

```ts
import { defineConfig } from '@rtrentjones/greenlight';

export default defineConfig({
  domain: 'you.dev',
  alerts: { sink: 'github-issue' },                 // or 'email' (Resend)
  blog: { lane: 'astro', target: 'workers', data: 'none' },   // optional; NEVER supabase
  tools: [
    { name: 'notes', lane: 'mcp', target: 'oci', data: 'none', auth: 'bearer',
      access: 'public', envs: ['prod'] },
  ],
});
```

A tool entry's fields (all but the first seven are optional):

| field | meaning |
|---|---|
| `name` `lane` `target` `data` `auth` `access` `envs` | the core shape (lane × target × data is matrix-validated) |
| `adopted` | onboarded existing tool — app code untouched |
| `external` | code/CI live in another repo; this entry is a registry pointer |
| `dir` | build/deploy dir (default `tools/<name>`; standalone uses `.`) |
| `port` | container listen port (`target: oci`) + default local-preview port |
| `preview` | how `greenlight preview` spins it up locally (`{ command, teardown?, port?, path? }`) |
| `tokens` | the project-scoped **secret names** this tool needs (doctor conformance — §9) |
| `tokenOverrides` | opt-in per-tool provider-token overrides for a **second account** (§9) |

## 6. The uniform "deliver a feature" loop

Every change to **any** tool (web or MCP) ships through **one model** — the agent's execution
discipline. The shape is identical for all; only the lane × target matrix cells vary. The
[deploy-verify-promote skill](.claude/skills/deploy-verify-promote/SKILL.md) carries the matrix.

```
branch → change → LOCAL GATE (preview) → ADD TO VERIFY LOOP → SHIP (gated on the tool's tests)
       → DEPLOY → VERIFY PROD
```

- **Local gate** = `greenlight preview <name>` (spin up locally + verify). The vercel cell uses
  Vercel's per-PR preview instead; `doctor` accepts it.
- **Add to verify loop** = put the change in the tool's `verify.config.ts` so the gate covers it.
- **Ship gate** = the tool's **own tests** must pass (oci: build `needs: [test]`; vercel: branch
  protection requiring the CI check; workers: deploy → verify).
- **Web tools** also get beta + `promote` (a gated `develop → main` fast-forward after beta verify).
  **OCI is direct-to-prod** (no beta on the free tier — the local gate + ship-gate are the safety).

`doctor` flags any tool drifting from the model (missing verify spec, no local-preview gate, a
non-scoped secret name). The `verify` gate — the same code CI runs — is what lets long-running,
semi-autonomous changes ship with **objective confidence, not vibes**.

## 7. Lanes × targets × data

| axis | values | notes |
|---|---|---|
| **lane** | `astro` · `next` · `mcp` | what the tool is. `hono` / `docker` are V0/V2 aims. |
| **target** | `workers` · `vercel` · `oci` | where it runs. `mcp` defaults `workers` (dev/throwaway) but BAMCP runs `oci`. |
| **data** | `none` · `d1` · `kv` · `supabase` | the store. `neon` is the next aim (§11). |

Defaults: `next` → `vercel`; `astro` → `workers`; `mcp` → `workers`. The blog is special: `astro` /
`workers`, and **never `supabase`** (Supabase pauses after 7 days idle; the blog must stay up
unattended — use D1/KV or external services).

## 8. The verify harness

[packages/verify](packages/verify) exposes one `verify(baseUrl, spec) -> { pass, report }`. A
`verify.config.ts` exports one spec, or an **array** to combine modes (`verifyAll` / `allPass`):

| mode | what it asserts |
|---|---|
| `api` | URL smoke — status codes, headers, no broken internal links |
| `mcp` | MCP protocol — initialize → `tools/list` → call a tool & assert shape → assert auth rejection; `exactTools` drift-guard |
| `playwright` | a11y-tree render **and** a real suite (`suite.command`) against the deploy URL (`PLAYWRIGHT_BASE_URL`) |
| `test` | the tool's own test command |
| `agent-web` | LLM-driven UI scenarios (lazy-loads `playwright`, degrades to a failing check without the dep / `ANTHROPIC_API_KEY`) |
| `eval` | LLM-judged MCP quality (lazy-loads `@anthropic-ai/sdk`; same graceful degrade) |

`logsOnFailure` runs a command only on failure with `$GREENLIGHT_VERIFY_URL` injected (telemetry
into the report — no hard-coded URLs). The same harness runs in CI **and** the agent loop.

## 9. Secrets & token scoping

Tokens are entered once, **fail-fast-verified**, and stored **only** in provider stores (GitHub
Actions secrets/environments, Cloudflare/Vercel/Supabase/etc. via Terraform vars) plus a local
gitignored `.greenlight/secrets.env` — **never committed or echoed.** Prefer GitHub OIDC → cloud
over long-lived Actions secrets. `private` tools and all `beta.*` sit behind Cloudflare Access;
mutating/private MCP servers default to `bearer`/`oauth`, never `none`. Migrations get a
dangerous-SQL scan gate.

**Naming convention** (so two tools never collide on the shared wrapper) — the single source is
`secretKeyFor()` in [cli/src/providers.ts](cli/src/providers.ts):

- **Account/provider** secrets stay plain (`CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, …).
- **Project-scoped** secrets carry the uppercased tool name — workflow secrets get a `_<TOOL>` suffix
  (`GREENLIGHT_STATUS_TOKEN_BAMCP`); Terraform-var secrets use `TF_VAR_<TOOL>_<NAME>`.
- A tool declares them in the manifest `tokens` list; `doctor` warns on a name lacking the tool name.

**Provider token overrides (multi-account).** A tool may set `tokenOverrides` to point one provider
at a **second account** (e.g. a different Supabase account) — `secretKeyFor` resolves the override
for `secrets gather`, and `add` emits an aliased provider + scoped var so the apply authenticates
that tool with the alternate account. Absent ⇒ byte-identical to the default.

Full matrix: [docs/tokens-reference.md](docs/tokens-reference.md) · setup prose:
[docs/provider-tokens.md](docs/provider-tokens.md) · trust model: [docs/security.md](docs/security.md).

## 10. Adding a provider type

The provider-pack registry is the seam for new free-tier backends (a new **data** store like Neon, a
new **target**, a new agentic-tool lane). The full guide is
**[docs/adding-a-provider.md](docs/adding-a-provider.md)** — at a glance: write one `ProviderPack`
(tokens + scopes + `verify()`, MCP, skill, `tfModules`), add a Terraform module under
`infra/modules/<provider>`, extend the schema matrix, and (if the surface is new) add a verify mode.
Default-off everywhere so existing consumers are unchanged.

## 11. Liveness & keepalive

Liveness is a feature. [packages/keepalive](packages/keepalive) is a **Cloudflare Worker Cron
Trigger** (not GitHub Actions — immune to repo-inactivity auto-disable): it runs cheap queries
against `data: supabase` projects (the 7-day pause), health-checks `target: oci` services, and on an
outage **auto-heals** `oci` targets by firing `repository_dispatch(remediate-<tool>)` so the wrapper
re-applies + redeploys + verifies. Alerts go to `alerts.sink` (`github-issue` or Resend `email`).

> OCI Always-Free **idle-reclaim** is solved out-of-band by converting the tenancy to PAYG — Greenlight
> only health-checks and nags via `doctor`; it never claims to prevent reclaim automatically. The
> personal aim here is to **stay on the free tier** and recover-on-alert, not run PAYG.

## 12. CI/CD environments

Three git-mapped environments, branches standardized to **`main` / `develop`**: PR → ephemeral
preview; `develop` → beta (`beta.<name>.<domain>`, behind Cloudflare Access); `main` → prod.
`promote` is an explicit, gated `develop → main` fast-forward after beta verify passes (CI-safe —
resolves remote-tracking refs). Terraform state lives in **HCP Terraform** (free tier, no credit
card; local execution). Per-provider mechanics: the `provider-*` skills + [docs/](docs/).

## 13. Distribution & the wrapper model

- **One published npm package** — `@rtrentjones/greenlight` (the CLI), with the framework libraries
  (`shared`/`verify`/`adapters`/`loop`) bundled in (tsup `noExternal`). `keepalive` is a Terraform-only
  Worker. The repo root is private orchestration (`name: greenlight`, `0.0.0`).
- **Terraform modules** ship as **git tags**, pinned in lockstep with the npm version (`?ref=vX.Y.Z`).
- **Skills** (deploy-verify-promote + per-provider) ship as a **Claude Code plugin**
  (`/plugin marketplace add RTrentJones/greenlight`) or via `greenlight agent sync`.
- **The wrapper is a thin consumer.** It depends on the package, owns only its manifest + content, and
  updates the mechanics with `pnpm update` — never merging framework code. Two hard rules keep the
  seam honest, both CI-enforced: **(1)** no personal value (domain/email/token/tool name) in any
  framework file (`check-seam`); **(2)** no load-bearing logic outside `packages/*` and `cli/`
  (`check-boundaries`).

## 14. Aims (the roadmap)

The framework is built and proven; the forward work is **breadth of provider types** and depth on the
two live tools.

- **New data backend — Neon** (the design-doc default): one Postgres project, **git-style branches
  per env**, scale-to-zero (no keepalive needed). A worked target for §10 / `docs/adding-a-provider.md`.
- **New tool category — agents**: first-class agentic tools (an `agents` lane/target) beyond MCP
  servers — the same loop, a fitting verify mode (`eval` is the seed).
- **More lanes/targets**: `hono` lane, `docker` lane, provider-agnostic **target-switching**
  (Workers↔Vercel↔OCI as config), standalone **eject**. (V0 north-star items, design-doc archive.)
- **Loop depth**: the `agent-web` **subscription driver** (run agent-web on a Claude Code
  subscription via `claude -p` + Playwright MCP) — researched, deferred.

The V0 design doc ([docs/archive/greenlight-design-doc-v0.md](docs/archive/greenlight-design-doc-v0.md))
remains the full provider-agnostic north star; anything deferred lives there.

## 15. Identity (unchanged)

Name **Greenlight**; GitHub `RTrentJones/greenlight`; npm `@rtrentjones/greenlight` (bin `greenlight`);
**MIT**, public from day one; docs dogfooded at `greenlight.rtrentjones.dev`. Blog default target
**workers**; Terraform state on **HCP Terraform**; MCP transport **streamable HTTP**; `auth: none`
only for public read-only.
