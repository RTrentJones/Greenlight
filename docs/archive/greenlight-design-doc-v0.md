# Greenlight — Design Doc

> **Name:** **Greenlight** (confirmed).
> **Identity:** GitHub `RTrentJones/greenlight`; npm scoped `@rtrentjones/greenlight` (CLI bin `greenlight`), unscoped fallback `greenlight-dev`; docs dogfooded at `greenlight.rtrentjones.dev` (the harness's own docs site is itself a Greenlight tool). **License: MIT, public from day one.**
> **Status:** Design. Not yet built.
> **Purpose of this doc:** A complete, opinionated spec Claude Code can execute. Read top to bottom, confirm the Open Decisions, then build in Build Sequence order.

---

## 1. One-liner

A clonable baseline that turns a domain plus a few API tokens into a live personal site **and** a self-verifying AI deploy loop, with plug-and-play subdomain tools — web apps **and MCP servers**. Provider-agnostic: the blog and each tool can target **Cloudflare Workers** or **Vercel**, with OCI as the origin lane for stateful services. You own the files; nothing is welded to one cloud.

## 2. Goals / Non-goals

**Goals**
- One-command setup: `greenlight init` accepts tokens, provisions infra as code, wires CI/CD, ships the first deploy.
- Clone-and-own. Everything is files in a repo the user controls — no managed control plane that can be sunset out from under them.
- Plug-and-play subdomains. Adding `tool.example.dev` is one manifest entry plus `terraform apply`.
- First-class tool categories: **web apps** and **MCP servers** — both hosted, verified, promoted by the same loop.
- Deploy-target abstraction: blog and tools run on **Workers or Vercel**, switchable by config.
- AI feedback loop as a first-class feature: change → deploy to beta → **verify** → **promote to prod** → iterate.
- **Stays alive on its own.** Nothing silently pauses/reclaims from low traffic (see §13).
- Free-tier-first. Default stack costs $0; paid is opt-in.

**Non-goals**
- Not a hosted PaaS/SaaS. No dashboard, control plane, or accounts.
- Not a Coolify/Heroku replacement. We orchestrate existing providers; we don't run a scheduler.
- Not locked to one framework. Lanes are pluggable.

## 3. Prior art & positioning (why this doesn't already exist)

The pieces exist; the assembled, provider-agnostic, clone-and-own harness does not. Hyperscalers converge on (managed host + branch previews + IaC starter + agentic coding) but weld it to their own cloud.

- **AWS Amplify Gen 2** — Git-branch environments, ephemeral PR previews, TypeScript backend. Amazon Q is an IDE assistant, not a verify-and-promote loop. AWS-locked.
- **Azure** — Static Web Apps (free PR/branch previews) + `azd` (Copilot-assisted IaC scaffolding) + a GitHub-Copilot-coding-agent→Azure extension. Closest to the whole loop, but Azure-locked, "bring an app, our agent deploys to our cloud."
- **Google / Firebase** — App Hosting + PR preview channels; Firebase Studio is agentic — **but being sunset** (new workspaces off June 2026, shutdown March 2027). That churn is the argument for clone-and-own.
- **OCI** — generous Always Free compute (right home for stateful services) but no managed git-preview platform or agent loop.
- **OSS pieces** — Turborepo/Vercel templates (structure only); Coolify (self-hosted PaaS, paid VPS, no agent loop); `claude-code-action`, Playwright MCP/Agents (QA-focused). None treats **MCP servers** as first-class hostable, protocol-verified tools.

**The unoccupied niche:** provider-agnostic + clone-and-own + plug-and-play subdomains (web *and* MCP) + an agent that self-verifies-and-promotes. Hyperscalers structurally won't build it — it cuts against lock-in.

## 4. Architecture overview

Two planes plus a data layer, behind a provider abstraction.

- **Edge plane** — Cloudflare Workers (Static Assets) default; Vercel alternate target. Home for blog, most web tools, stateless/session-stateful MCP servers.
- **Origin plane** — OCI Always Free + Cloudflare Tunnel. Stateful/long-running services needing a filesystem or local binaries (BAMCP: samtools over BAM/CRAM). Docker + Traefik behind a Tunnel; HTTPS, no open ports.
- **Data layer** — Neon (serverless Postgres, branch-per-env) as the default DB; Supabase when bundled auth+storage+realtime are needed; Cloudflare D1/KV/R2 for edge-native needs (§12).

**Placement rule:** managed state (Neon/Supabase/D1) → compute is edge-deployable (edge plane). Local state/binaries → origin plane. (HeistMind's state is in Supabase → edge plane. BAMCP needs local compute → origin plane.)

## 5. Deploy-target abstraction (Workers ↔ Vercel)

Blog and tools declare a `target`; the repo ships an adapter per target so switching is config, not a rewrite.

- `target: workers` → Cloudflare adapter; `wrangler deploy` / Workers Builds. Next.js via OpenNext.
- `target: vercel` → Vercel git integration / CLI; native Vercel adapter.
- `target: oci` → Docker image to the OCI host; Cloudflare Tunnel ingress.

**Adapter contract** (every target implements the same four hooks):
`build(toolDir)->artifactDir`, `deploy(toolDir,env)->{url}` (env ∈ preview|beta|prod), `url(toolName,env)->string` (deterministic — `verify` targets it without scraping logs), `teardown(toolName,env)`.

The **contract is the product**; frameworks are swappable.

## 6. MCP hosting as a first-class category

Greenlight's most distinctive surface: almost no personal-site harness treats an MCP server as a hostable, protocol-verified, promotable tool. This is BAMCP's hosting generalized.

**Why its own lane:** an MCP server is a protocol endpoint, not a web page — verification is protocol-level; auth + transport are the primary concerns.

**Targets:**
- `lane: mcp, target: workers` — stateless/session-stateful remote MCP (the `agents` SDK `McpAgent` + Durable Objects, `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`). Free-tier friendly.
- `lane: mcp, target: oci` — stateful MCP needing local binaries/filesystem (BAMCP). Docker behind a Tunnel. Manifest/verify/promote identical to the Workers shape.

**Transport:** streamable HTTP default; SSE legacy fallback (per-tool).
**Auth (`auth`):** `none` (public read-only only), `bearer`, or `oauth`. Default `none` only for public read-only; mutating/private servers default to `bearer`/`oauth`.
**Connect URL:** `<name>.<domain>/mcp` (or `mcp.<domain>` catalog). CLI prints it after deploy. Optional `.well-known`/catalog + registry registration.
**MCP verify mode** (replaces Playwright — no UI): initialize handshake → `tools/list` returns expected schemas → call one tool, assert result shape → if `auth!=none`, assert unauthorized is rejected. In the loop, the agent runs `mcp` verify against beta (via Inspector / a tiny client), optionally registers the beta URL as its own connector to dogfood, then promotes.

## 7. Repo topology & the subdomain manifest

```
greenlight/
  cli/                      # setup + lifecycle CLI (§8)
  infra/                    # Terraform (§9)
  apps/blog/                # main site (apex); target = workers | vercel
  tools/                    # one dir per subdomain tool
    _template-{astro,hono,next,mcp,docker}/
  packages/
    ui/ shared/             # shared design system + utils/types
    verify/                 # verify harness: api | playwright | mcp (§11)
    keepalive/              # Cloudflare Worker cron heartbeat (§13)
  .agent/
    CLAUDE.md subagents/ skills/
  greenlight.config.ts      # the manifest (below)
  .github/workflows/        # ci, deploy, promote, supabase-migrate, alert
  turbo.json pnpm-workspace.yaml
```

**The manifest** (`greenlight.config.ts`) is the single source of truth.

```ts
export default defineConfig({
  domain: "rtrentjones.dev",
  blog: { target: "workers", lane: "astro", data: "none" },  // none while static; switch to "neon" when it needs persistence (comments, view counts, newsletter signups)
  alerts: { sink: "github-issue" },                  // or "email" (Resend) — §13
  tools: [
    { name: "bamcp",      lane: "mcp",  target: "oci",     data: "none",     auth: "none",  access: "public", envs: ["beta","prod"] },
    { name: "weather-mcp",lane: "mcp",  target: "workers", data: "none",     auth: "none",  access: "public", envs: ["beta","prod"] },
    { name: "notes",      lane: "next", target: "vercel",  data: "neon",     auth: "oauth", access: "public", envs: ["beta","prod"] },
    { name: "events",     lane: "next", target: "workers", data: "supabase", auth: "oauth", access: "public", envs: ["beta","prod"] },
    { name: "shorten",    lane: "hono", target: "workers", data: "d1",       auth: "none",  access: "public", envs: ["beta","prod"] },
  ],
});
```

**Lane × target × data matrix:**

| Lane | Default target | Allowed targets | Typical data | Verify mode |
|------|----------------|-----------------|--------------|-------------|
| astro | workers | workers, vercel | none, d1, neon, supabase | api + playwright |
| hono | workers | workers, vercel | d1, neon, supabase | api |
| next | **vercel** | vercel, workers | neon, supabase | api + playwright |
| mcp | workers | workers, oci | none, d1, neon, supabase | mcp |
| docker | oci | oci | supabase, neon, self | api |

(`data ∈ none | d1 | neon | supabase`. Neon is the default Postgres; Supabase only when bundled features are needed — §12.)

## 8. The setup CLI

Node CLI (`greenlight`) in `cli/`. Commands:

- `greenlight init` — prompts for domain; Cloudflare token; GitHub token (or `gh auth`); Vercel token (if any target=vercel); Neon and/or Supabase tokens (if any tool uses them). Then: (1) validate each token, fail fast; (2) write secrets only to provider stores — GitHub repo/Actions secrets + environments, Cloudflare/Vercel/Neon/Supabase via Terraform vars, plus a local gitignored `.greenlight/secrets.env` — **never the repo**; (3) `terraform init && apply`; (4) first deploy of blog + prod tools; (5) print live URLs (and MCP connect URLs).
- `greenlight add <name> --lane --target --data [--auth]` — copy lane template, append manifest entry, scoped `terraform apply`. Prompts for any provider token a new lane/data first needs. Idempotent.
- `greenlight verify <name> --env <env>` — run the harness against the deterministic URL; auto-selects mode from lane.
- `greenlight promote <name>` — trigger the `promote` workflow (fast-forward develop→main) via `gh workflow run`.
- `greenlight doctor` — token validity, DNS propagation, `terraform plan` drift, manifest↔dir↔workflow consistency, and keepalive health (§13).

**Token/secret principles:** entered once, validated, stored only in provider stores + a local gitignored file; never committed/echoed. Prefer GitHub OIDC → cloud over long-lived Actions secrets where supported.

## 9. Config as code (Terraform)

`infra/` = root module + reusable `tool` module. Adding a tool = one module block (CLI appends from manifest).

- **Providers:** Cloudflare (DNS, Worker routes/custom domains, Tunnel ingress, Access, D1/KV/R2, **Worker Cron for keepalive**), GitHub (repo settings, branch protection, environments, secrets), Vercel (when target=vercel), Neon (project/branches, when data=neon), Supabase (project per env, when data=supabase).
- **`module "tool"`** inputs `{ name, subdomain, lane, target, data, auth, access, envs }`; outputs URLs + resource IDs.
- **State:** **default Cloudflare R2** (S3-compatible backend; state-locking via Terraform's S3-native lockfile, which works on R2's conditional writes). Alternative: Terraform Cloud free tier (managed locking + run history + remote runs; one more vendor). Either is reversible.
- **Drift:** `greenlight doctor` + scheduled `terraform plan` surfaced as a PR comment.

## 10. CI/CD environments & the verify→promote contract

Three environments, git-mapped. **Standardize branch names to `main` / `develop`** (avoids the `develop` vs `development` class of bug — which HeistMind currently has, where `ci.yml` watches `develop` but the branch is `development`).

| Trigger | Env | URL |
|---|---|---|
| PR / feature branch | ephemeral preview | per-target preview alias |
| `develop` | beta | `beta.<name>.<domain>` |
| `main` | prod | `<name>.<domain>` |

- Preview/prod builds run on the target's native git integration where possible (conserves Actions minutes).
- GitHub Actions owns: unit tests, the **verify** gates, the migration pipeline (§12), Terraform plan/apply on `infra/**`. (Keepalive does **not** live in GH Actions — §13.)
- **`promote`** = `workflow_dispatch` fast-forwarding develop→main after beta verify passes. Explicit, gated.
- `beta.*` behind Cloudflare Access.

## 11. The AI feedback loop

Verification wired to **promotion**, not just test-writing. In `.agent/` + `packages/verify/`, copied into every tool by `greenlight add`.

- **`packages/verify`** — `verify(baseUrl, spec) -> {pass, report}` with modes by lane: `api`, `playwright` (accessibility-tree), `mcp` (§6). CI and the agent call the same harness.
- **`.agent/CLAUDE.md`** — runbook: branch → push → `verify $PREVIEW_URL` → merge `develop` → `verify $BETA_URL` → `promote` → `verify $PROD_URL`. Records the deterministic URL scheme.
- **`.agent/subagents/`** — planner / generator / healer as editable markdown subagents.
- **MCP wiring (documented):** Playwright MCP (`@playwright/mcp` or Cloudflare's hosted fork); an MCP client/Inspector for `mcp` verify; `gh` for PR/check status; Cloudflare observability MCP / `wrangler tail`; the user's own MCPs (BAMCP).
- **Skill:** a `deploy-verify-promote` SKILL.md + scripts.

## 12. Data & environment model

The default minimizes accounts/projects to manage while keeping true per-env isolation.

- **Default: Neon (`data: neon`).** One Neon project; **git-style branches per env** (prod/beta + ephemeral per-PR), free tier (10 branches/project, 100 projects, 0.5 GB each), copy-on-write (real-shaped data), and **scale-to-zero with ~1s resume** — so **no inactivity pause and no DB keepalive needed**. One account, branches not projects → exactly the "don't manage a pile of projects" requirement, and it's *better* practice (isolated per-env branches). Pairs naturally with the Vercel-default `next` lane (Neon is Vercel's recommended DB). Add Neon Auth if auth is needed.
- **Supabase (`data: supabase`) only when bundled auth + storage + realtime are needed together.** Note: Supabase **branching is a paid Pro feature billed per branch-hour**, so it isn't the free path to env separation. For free Supabase use either project-per-env (the 2-project free cap = beta+prod, fine for a single such tool) or schema-per-env for one solo tool. Supabase-backed tools require the §13 heartbeat (7-day pause) and the migration pipeline below.
- **Migration pipeline:** lift HeistMind's Supabase migration CI/CD (name/syntax validation, local-Supabase spin-up, schema-deploy verification, dangerous-SQL scan, pre-deploy backups, rollback job, type-gen-and-commit) for `data: supabase` tools. For `data: neon`, use branch-based migration testing (branch off prod → apply migration → verify → merge), which is cleaner and free.
- **Edge-native:** KV/blob/relational-lite → D1/KV/R2.

## 13. Liveness & keep-alive

Low-traffic personal tools hit several silent-pause traps. The harness handles each so a tool you haven't touched in months is still up.

| Resource | Low-traffic risk | Handling |
|---|---|---|
| Cloudflare Workers / D1 / KV / R2 | none (no idle pause) | nothing |
| Vercel (Hobby) | no idle pause; risk is monthly caps | monitor caps; no keepalive |
| **Neon Postgres** | scale-to-zero ~5 min, auto-resumes ~1s | nothing — automatic |
| **Supabase (free)** | project pauses after 7 days no DB activity | scheduled cheap query (below) |
| **OCI Always Free compute** (BAMCP) | reclaimed/stopped if idle 7 days (p95 CPU/net/mem < ~10–20%) | **convert account to PAYG** (stays $0 within Always Free limits, exempt from idle reclaim) — the robust fix; health pings help network but won't reliably clear the CPU threshold |
| **GitHub Actions scheduled workflows** (public repo) | auto-disabled after 60 days no repo activity; GitHub emails on *disable* but **not** on run *failure* | don't use GH cron for keepalive (below); for any other scheduled GH workflow, trigger via `workflow_dispatch` from the CF cron, and add an explicit failure-alert step |

**Heartbeat architecture — `packages/keepalive`, a Cloudflare Worker Cron Trigger (not GitHub Actions).** CF's scheduler is immune to repo inactivity and free. Each run:
1. Runs a cheap query against every `data: supabase` tool's DB (resets the 7-day pause). (`data: neon` tools need nothing.)
2. Hits each `target: oci` service's health endpoint.
3. On any failure (DB error, non-200, unreachable), fires an alert via the configured `alerts.sink`: `github-issue` (POST to the GitHub API → GitHub emails you; zero new vendor) or `email` (Resend free tier). Configurable `ALERT_EMAIL`/`ALERT_WEBHOOK`.

**On the GitHub 60-day question specifically:** yes — GitHub emails the repo owner when it auto-disables a scheduled workflow after 60 days of inactivity. But (a) that's only the *disable* notice, not run failures, and (b) we avoid the trap entirely by putting keepalive on Cloudflare's cron, so it can't be disabled by repo inactivity. Provided as a backstop: a tiny `keepalive-commit` workflow can bump a dated marker monthly to keep any remaining scheduled GH workflows under the 60-day line.

## 14. Security model

- Tokens validated, stored only in provider stores + a local gitignored file; never committed/echoed.
- Prefer GitHub OIDC → cloud over long-lived Actions secrets.
- `private` tools (and all `beta.*`) behind Cloudflare Access.
- MCP tools that mutate/expose private data default to `bearer`/`oauth`, never `none`.
- Dangerous-SQL scan gate on migrations; dependency audit step in CI (warn).

## 15. Worked walkthrough: zero → four tools

Prereqs: cloned baseline; Cloudflare + GitHub tokens; Claude Code in the repo.

**Step 0 — `greenlight init`.** Enter domain, CF token, GitHub token. CLI validates, writes secrets, `terraform apply` (DNS, R2 state bucket, repo secrets/environments, the keepalive Worker cron), deploys the starter blog. → Blog at `rtrentjones.dev`, beta at `beta.rtrentjones.dev`.

**Step 1 — the blog** (`apps/blog`, astro/workers). Write an MDX post; run the loop once:
```
git checkout -b post/hello && git push           # → preview URL
greenlight verify blog --env preview             # api: routes 200; playwright: renders
# merge to develop → beta; verify beta
greenlight promote blog                          # develop→main → prod
```
Switch the blog to Vercel: set `blog.target:"vercel"`, add a Vercel token, `terraform apply` + redeploy. Same content, different host.

**Step 2 — add an MCP server.**
```
greenlight add weather-mcp --lane mcp --target workers --data none --auth none
```
Implement `get_forecast`. Verify mode `mcp`: initialize → tools/list → call → schema. Loop to beta (optionally add the beta `/mcp` URL as a connector to dogfood) → promote. → `https://weather-mcp.rtrentjones.dev/mcp`. (BAMCP-style stateful MCP: `--lane mcp --target oci`; everything else identical.)

**Step 3 — add a Postgres-backed site (Neon).**
```
greenlight add notes --lane next --target vercel --data neon --auth oauth
```
First Neon tool → CLI prompts for the Neon token; Terraform creates one Neon project with prod + beta branches (no extra projects, no pause). Migrations via branch-based testing. Loop: preview (its own ephemeral branch) → verify (api: auth + CRUD; playwright: sign-in + create a note) → beta → promote. *Use `--data supabase` instead only if you need Supabase auth+storage+realtime together (project-per-env, plus the keepalive heartbeat).*

**Step 4 — add "something else" (Hono + D1 edge API).**
```
greenlight add shorten --lane hono --target workers --data d1
```
A URL shortener on D1 (edge-native, no Neon/Supabase slot). Pure API → `verify` runs `api` mode only. Same loop.

**Generalization:** the flow never changes — only the flags do (`--target vercel`, `--lane docker --target oci`, another `--lane mcp`, …). Finish with `greenlight doctor` (DNS, drift, keepalive health, all wired).

## 16. Build sequence (for Claude Code, in order)

1. **Monorepo skeleton** — pnpm + Turborepo; `packages/{ui,shared,verify,keepalive}`; lane templates `_template-{astro,hono,next,mcp,docker}`; lift HeistMind's lint/test/husky.
2. **Manifest + types** — `greenlight.config.ts` (`defineConfig`) + typed loader for CLI and Terraform-codegen.
3. **Terraform** — root + `module "tool"` (Cloudflare + GitHub first; Vercel/Neon/Supabase behind conditionals; Worker-cron keepalive). R2 remote state with lockfile locking.
4. **CLI** — `init` (tokens → validate → secrets → apply → first deploy), then `add`, `verify`, `promote`, `doctor`.
5. **Deploy-target adapters** — four-hook contract for `workers`, `vercel`, `oci`; Next-on-Workers via OpenNext (default Next → vercel).
6. **MCP lane** — `_template-mcp` (Workers `McpAgent` + OCI/Docker shapes), `mcp` verify mode, connect-URL printing.
7. **Keepalive** — `packages/keepalive` Worker cron (Supabase query + OCI health + alert sink); doctor integration.
8. **CI/CD workflows** — `ci`, `deploy`, `promote`, `supabase-migrate` (generalized from HeistMind), `alert`.
9. **AI loop** — `packages/verify` (api/playwright/mcp), `.agent/CLAUDE.md`, subagents, `deploy-verify-promote` skill.
10. **The blog** — Astro content-collections; deployable to both workers and vercel; prove the target switch.
11. **Smoke the loop** — run §15 end to end on throwaway tools.
12. **Docs** — README quickstart; per-lane READMEs; host at `greenlight.rtrentjones.dev` (dogfood).

## 17. Open decisions — RESOLVED

1. **Name** → **Greenlight** (identity pinned in header).
2. **Blog default target** → **`workers`**.
3. **Next lane** → support **both**; default `next` → **`vercel`** (Next 15/React 19 edge quirks).
4. **DB env model** → **Neon by default everywhere, blog included** (the blog is `data: none` while static and switches to `data: neon` the moment it needs persistence; branch-per-env, one account, no pause). **Supabase supported per-tool, only for tools needing bundled auth+storage+realtime together** (project-per-env + heartbeat). Supabase branching is paid, so not the free path.
5. **Repo model** → **monorepo-of-tools by default**, with a `greenlight add --standalone` escape hatch that ejects a tool into its own template repo (consuming the published `@rtrentjones/*` packages) when it needs isolation or independent open-sourcing. Per-tool choice, not global.
6. **State backend** → **R2 (chosen)** — own it, one ecosystem, free, lockfile locking. (Terraform Cloud free tier remains a drop-in alternative if managed locking/run-history is ever wanted; state migrates cleanly.)
7. **MCP defaults** → transport **streamable HTTP**; `mcp` lane **`auth: none` only for public read-only** servers.
8. **License** → **MIT, public from day one.**

## 18. Appendix — identity

- Brand/repo: **Greenlight** — `RTrentJones/greenlight`.
- npm: `@rtrentjones/greenlight` (bin `greenlight`); unscoped fallback `greenlight-dev`.
- Docs: `greenlight.rtrentjones.dev`, itself a Greenlight `astro`/`workers` tool.
- License: MIT.
