# Greenlight — V1 Design & Implementation Plan

> **Status:** V1 scope, ready to build.
> **Supersedes:** [docs/archive/greenlight-design-doc-v0.md](docs/archive/greenlight-design-doc-v0.md) (the full, provider-agnostic vision). V0 remains the north star; V1 is the buildable slice that solves the problems we actually have today.
> **Purpose:** A complete, opinionated spec Claude Code can execute top-to-bottom, plus a phased implementation plan with acceptance criteria. Read §1–§15 for the design, build in §16 order.

---

## 1. Why V1 exists (the actual problem)

Two tools already exist and both **keep timing out**, and **re-wiring them is painful**:

- **BAMCP** — a stateful MCP server (samtools over BAM/CRAM) on OCI. Gets **idle-reclaimed** by OCI Always Free after ~7 days of low CPU.
- **HeistMind** — a Next.js + Supabase web app on Vercel. Its Supabase project **pauses after 7 days** of no DB activity. (It also has a `develop` vs `development` branch-name bug.)

V1's job: **build the framework and the deploy → validate → iterate loop, and make wiring a tool a declarative, repeatable act instead of a bespoke afternoon.** Both BAMCP and HeistMind are **currently down**, so there is nothing to keep alive yet — rather than resuscitate-then-wrap, we build the loop first and prove it on artifacts we control (the **blog** for the web loop, a **throwaway MCP server** for the protocol loop), then **migrate** the two real tools onto the harness. Keepalive and adoption are later phases, not the starting point.

This is still an **extraction** in spirit — the patterns come from BAMCP + HeistMind — but the build order is **framework-first** because there's no live system to keep alive.

## 2. Scope

**In:**
- **Build subjects (greenfield, prove the loop):** the **blog** (web loop, built first) and a **throwaway MCP server** (protocol loop, built second).
- **Migration targets (later phases):** BAMCP (adopt), HeistMind (adopt) — brought back to life *on* the harness once the loop is proven.
- **Lanes:** `next`, `mcp`, `astro`.
- **Targets:** `vercel`, `oci`, **`workers`** — the latter hosts the blog, the keepalive cron, and **`mcp`→`workers` as a dev/throwaway target** so the MCP loop can be iterated on the edge without standing up a live OCI box. (`mcp`→`oci` remains BAMCP's production target.)
- **Data:** `supabase` (HeistMind only), `none` / `d1` / `kv` (blog).
- **Providers:** Vercel, Supabase, OCI, GitHub, **Cloudflare** (DNS + Tunnel + Worker Cron — infrastructure, not a primary deploy target except the blog and keepalive).
- The **deploy → validate → iterate loop** (the centerpiece), declarative wiring, a thin CLI, and a **packages-based distribution model** (§15). **Keepalive** and the **adopt path** are in scope but sequenced as later phases.

**Out (deferred to a later version, kept in V0):**
- Neon, the `hono` lane, `d1` as a primary app store beyond the blog, the standalone repo eject, full provider-agnostic switching, marketplace/registry niceties.
- **Blog target-switching (Workers↔Vercel) as a deliverable.** The adapter contract makes it *possible*; we don't build or test it in V1.

**Non-goals (unchanged from V0):** not a hosted PaaS/control plane; not locked to one framework forever; no managed accounts/dashboard.

## 3. Architecture

Two planes plus a data layer, with Cloudflare as the connective tissue.

- **Edge plane — Cloudflare Workers.** Home for the **blog** (Astro, Static Assets + room for a dynamic KV endpoint) and the **keepalive cron**. No idle pause.
- **Vercel plane.** Home for **HeistMind** (`next`). Hobby tier: no idle pause, watch monthly caps.
- **Origin plane — OCI Always Free + Cloudflare Tunnel.** Home for **BAMCP** (`mcp`, stateful, needs local binaries/filesystem). Docker behind a Tunnel; HTTPS, no open ports. **Must be PAYG-converted (see §6).**
- **Data layer — Supabase** (HeistMind only), project-per-env. **D1/KV** for the blog if it ever needs state. **Supabase never backs the blog** (§9).

**Placement rule:** managed state + edge-deployable compute → edge/Vercel plane. Local state/binaries → origin plane. (HeistMind → Vercel; BAMCP → OCI; blog → Workers.)

## 4. The manifest (`greenlight.config.ts`)

Single source of truth. V1 shape:

```ts
export default defineConfig({
  domain: "rtrentjones.dev",
  alerts: { sink: "github-issue" },           // or "email" (Resend)
  blog: { target: "workers", lane: "astro", data: "none" },  // → "d1"|"kv" when it needs state; NEVER "supabase"
  tools: [
    { name: "bamcp",     lane: "mcp",  target: "oci",    data: "none",     auth: "none",  access: "public",  envs: ["beta","prod"], adopted: true },
    { name: "heistmind", lane: "next", target: "vercel", data: "supabase", auth: "oauth", access: "public",  envs: ["beta","prod"], adopted: true },
  ],
});
```

`doctor` enforces manifest ↔ tool-dir ↔ workflow consistency. `adopted: true` marks tools whose app code is owned upstream and must not be templated over (§8).

**V1 lane × target × data matrix:**

| Lane  | Target  | Data                | Verify mode      | Reference tool |
|-------|---------|---------------------|------------------|----------------|
| astro | workers | none, d1, kv        | api (+ light playwright) | blog       |
| next  | vercel  | supabase            | api + playwright | HeistMind (migrate later) |
| mcp   | workers | none                | mcp              | throwaway dev/test server |
| mcp   | oci     | none                | mcp              | BAMCP (migrate later) |

(Anything outside this matrix is V2. `mcp`→`workers` exists so the protocol loop can be developed cheaply before BAMCP is migrated to `mcp`→`oci`.)

## 5. Repo topology

```
greenlight/
  cli/                          # init / add / adopt / verify / promote / doctor (§10)
  infra/                        # Terraform: root + module "tool" (§11)
  apps/blog/                    # Astro, target=workers (§9)
  tools/                        # adopted tools live here (or reference upstream)
    bamcp/  heistmind/
    _template-{astro,next,mcp}/ # only the three V1 lanes
  packages/
    keepalive/                  # CF Worker Cron heartbeat (§6) — BUILT FIRST
    verify/                     # api | playwright | mcp harness (§7)
    shared/                     # manifest loader + types
  CLAUDE.md                     # always-on loop awareness (Claude Code auto-loads this)
  .claude/skills/
    deploy-verify-promote/SKILL.md  # the loop skill (§7); cross-repo via plugin (Phase 7)
  greenlight.config.ts
  .github/workflows/            # ci, deploy, promote, supabase-migrate, alert
  turbo.json  pnpm-workspace.yaml
```

## 6. Liveness & keepalive — *deferred to a later phase (§16 Phase 8)*

> **Re-sequenced.** Both tools are currently down, so there is nothing to keep alive yet. Keepalive lands *after* the loop works and the two tools are migrated onto the harness. The design below is unchanged — only its position in the build order moved.

The eventual pain. Each idle-pause trap and its handling:

| Resource | Risk | Handling |
|---|---|---|
| Cloudflare Workers / D1 / KV | none | nothing |
| Vercel (Hobby) | no idle pause; monthly caps | monitor caps in `doctor`; no keepalive |
| **Supabase (free)** | pauses after 7 days no DB activity | scheduled cheap query from the keepalive Worker |
| **OCI Always Free (BAMCP)** | reclaimed/stopped if idle ~7 days (p95 CPU/net/mem < ~10–20%) | **convert account to PAYG** (stays $0 within Always Free, exempt from idle reclaim) — *manual, see below*; Worker health-pings + alerts but cannot itself prevent reclaim |
| **GitHub Actions scheduled workflows** | auto-disabled after 60 days repo inactivity | don't use GH cron for keepalive (we use CF cron); backstop: monthly dated-marker commit |

**Heartbeat — `packages/keepalive`, a Cloudflare Worker Cron Trigger.** Immune to repo inactivity, free. Each run:
1. Cheap query against every `data: supabase` tool's DB (resets the 7-day pause).
2. Health check on each `target: oci` service.
3. On any failure → alert via `alerts.sink`: `github-issue` (POST to GitHub API → GitHub emails you; **zero new vendor — start here**) or `email` (Resend free tier).

**The OCI fix is mostly NOT code.** The robust cure for BAMCP's reclaim is converting the OCI tenancy to **Pay-As-You-Go** (still $0 within Always Free limits, but exempt from idle reclaim). Health pings won't reliably clear the CPU threshold. Therefore:
- Document PAYG conversion as a **manual prerequisite** in the BAMCP onboarding.
- `doctor` **checks for and nags about** PAYG status; the harness never claims to prevent OCI reclaim automatically.
- Add a **billing budget alarm** on the OCI account (PAYG opens a billing relationship that *can* charge past Always Free).

## 7. The MCP loop & verify→promote contract

Verification wired to **promotion**, not just test-writing. CI and the agent call the **same** harness.

- **`packages/verify`** — `verify(baseUrl, spec) -> {pass, report}`, modes by lane:
  - `api` — routes return expected status; for the blog: RSS/sitemap valid, no broken internal links; for HeistMind: auth + CRUD.
  - `playwright` — accessibility-tree render check. *Light* for the blog (a post renders); fuller for HeistMind (sign-in + create).
  - `mcp` — protocol-level (no UI): `initialize` handshake → `tools/list` returns expected schemas → call one tool, assert result shape → if `auth != none`, assert unauthorized is rejected.
- **Deterministic URLs.** `url(toolName, env)` is computed, not scraped from deploy logs, so `verify` always knows where to point. Scheme: `beta.<name>.<domain>` (beta), `<name>.<domain>` (prod), per-target alias (preview). MCP connect URL: `<name>.<domain>/mcp`.
- **The loop:** branch → push → `verify $PREVIEW` → merge to `develop` → `verify $BETA` → `promote` → `verify $PROD`.
- **Agent context** — the loop is **agent-driven during the dev cycle**: ask for a change and the agent runs deploy-preview → `verify` → (beta → `verify` → `promote` → prod) as part of the work. For **Claude Code** this lives in `.claude/skills/deploy-verify-promote/SKILL.md` (the procedure, auto-discovered) + always-on awareness in root `CLAUDE.md`. *(Note: Claude Code does not read `.agent/` or scan `node_modules` for skills — agent context can't ride the npm channel; its cross-repo distribution is its own channel, see §15.7 / Phase 7.)* Keep agent autonomy modest in V1 — the value is the shared verify contract + gated promotion, not autonomous self-healing.

## 8. Adopting existing tools

BAMCP and HeistMind already exist and **must not be rewritten.** `greenlight adopt <path|name>`:
1. Adds the manifest entry with `adopted: true`.
2. Drops in a **verify spec** (`verify.config.ts`) and the CI wiring — leaves app code untouched.
3. Wires secrets into provider stores + GitHub environments; registers DNS/Tunnel/Vercel/Supabase resources in Terraform **by reference** (import existing where possible, don't recreate).
4. Standardizes branches to `main` / `develop` (fixing HeistMind's `develop`/`development` bug as part of onboarding).

The adopt path is the real test of "re-wiring = edit manifest + apply." It is a first-class command, not an afterthought.

## 9. The blog (greenfield validator)

The blog's job in V1 is to **prove the `greenlight add` → loop works on a new, template-generated tool** — low stakes (a bug ships a typo, not data loss).

- **Lane/target:** `astro` / `workers`. Astro content collections + MDX. Workers (not pure static) so a dynamic KV endpoint can be added later without replatforming.
- **Data rule:** stay `data: none` as long as possible. When state is needed, use **D1/KV** (same plane as Workers — no idle pause, no keepalive, free) **or external services**. **Never Supabase** — the blog is the artifact we most want always-up; it must not depend on the thing that pauses.
  - Comments → giscus (GitHub Discussions). Newsletter → Resend/Buttondown. View counts → KV counter. None of these need our DB.
- **Verify:** light — `api` (200s, valid RSS/sitemap, no broken internal links) + minimal `playwright` (a post renders). Don't over-verify static content.
- **Not in scope:** moving the blog to Vercel. Workers only.

## 10. The CLI (`greenlight`)

Thin in V1 (two adopted tools + one greenfield). Commands:
- `greenlight init` — prompts/validates tokens (CF, GitHub, Vercel, Supabase, OCI), writes secrets only to provider stores + local gitignored `.greenlight/secrets.env`, `terraform init && apply`, first deploy, prints live URLs (+ MCP connect URL).
- `greenlight adopt <path|name>` — §8.
- `greenlight add <name> --lane --target --data [--auth]` — copy V1 lane template, append manifest entry, scoped `terraform apply`. Idempotent.
- `greenlight verify <name> --env <env>` — run the harness against the deterministic URL; mode auto-selected from lane.
- `greenlight promote <name>` — gated fast-forward `develop`→`main` via `gh workflow run`.
- `greenlight doctor` — token validity, DNS propagation, `terraform plan` drift, manifest↔dir↔workflow consistency, **keepalive health, OCI PAYG status, OCI billing alarm presence, Vercel cap headroom**.

**Secret principles:** entered once, validated (fail fast), stored only in provider stores + a local gitignored file; never committed/echoed. Prefer GitHub OIDC → cloud over long-lived Actions secrets where supported.

## 11. Config as code

`infra/` = root module + reusable `module "tool"` (inputs `{ name, subdomain, lane, target, data, auth, access, envs }`; outputs URLs + resource IDs). Providers (V1): Cloudflare (DNS, Worker routes/custom domains, Tunnel ingress, Worker Cron, D1/KV), GitHub (repo settings, branch protection, environments, secrets), Vercel (HeistMind), Supabase (project-per-env, HeistMind).

- **State:** Cloudflare R2 (S3-compatible) with the S3-native lockfile.
- **Pin every provider version hard** — multi-provider Terraform churn (esp. the Cloudflare provider) is the highest-maintenance surface.
- **Adopt-by-reference:** import existing resources rather than recreating them.
- **Decision to revisit:** for 5 providers, full Terraform may be heavier than idempotent provider-CLI scripts. V1 keeps Terraform for the declarative "one module block per tool"; flag if the ceremony outweighs the benefit during build.

## 12. CI/CD environments

Three environments, git-mapped. Branches standardized to **`main` / `develop`**.

| Trigger | Env | URL |
|---|---|---|
| PR / feature branch | preview | per-target alias |
| `develop` | beta | `beta.<name>.<domain>` (behind Cloudflare Access) |
| `main` | prod | `<name>.<domain>` |

- Preview/prod builds use the target's native git integration where possible (conserves Actions minutes).
- GitHub Actions owns: unit tests, **verify** gates, the Supabase migration pipeline, Terraform plan/apply on `infra/**`. **Keepalive does NOT live in GH Actions** (§6).
- **`promote`** = `workflow_dispatch` fast-forward `develop`→`main` after beta verify passes. **Divergence policy:** a direct hotfix to `main` breaks the fast-forward; `promote` must detect non-fast-forward and stop with a reconcile instruction rather than force-push.

## 13. Data & environment model

- **Supabase (HeistMind only).** Branching is paid, so per-env isolation = **project-per-env**. Free tier caps at **2 projects** = beta + prod — exactly enough for one Supabase tool. Adding a *second* Supabase tool breaks free isolation; that's a V2 problem.
- **Migration pipeline** (lift from HeistMind): name/syntax validation, local-Supabase spin-up, schema-deploy verification, dangerous-SQL scan gate, pre-deploy backup, rollback job, type-gen-and-commit.
- **Blog:** D1/KV only if needed (§9).

## 14. Security

- Tokens validated, stored only in provider stores + a local gitignored file; never committed/echoed. Prefer GitHub OIDC → cloud.
- All `beta.*` and any `private` tool behind Cloudflare Access.
- MCP tools that mutate/expose private data default to `bearer`/`oauth`, never `none`. BAMCP is public read-only → `none` is acceptable.
- Dangerous-SQL scan gate on migrations; dependency-audit step in CI (warn).
- OCI: billing budget alarm mandatory once PAYG (§6).

---

## 15. Distribution & the personal-repo model

The differentiation between **"the clonable baseline"** and **"my personal setup"** rests on one seam, one hard rule, and a **packages-based update path** (chosen — no merge-hell).

### 15.1 The seam — three places personal data may live, nothing else

| | Framework (the clonable baseline) | Personal (yours) |
|---|---|---|
| **Logic** | `cli/`, `packages/*`, `infra/modules/`, `_template-*`, `.github/workflows/*` (all parameterized) | — |
| **Config** | `greenlight.config.example.ts` + the `defineConfig` schema/types | `greenlight.config.ts` (your domain + tools) |
| **Secrets** | — | `.greenlight/secrets.env` (gitignored) + provider stores |
| **Content/apps** | lane templates, blog *theme* | `tools/<yours>/`, `apps/blog/src/content/` (your posts) |

### 15.2 Two hard rules that keep the seam (and the package split) honest

1. **No personal value — domain, token, tool name — ever appears in a framework file.** Every framework file reads from the manifest. Hardcoding `rtrentjones.dev` in a workflow or adapter breaks the seam. **CI enforces this** (a check greps framework paths for the configured domain/known personal strings and fails).
2. **No load-bearing logic outside `packages/*` and `cli/`.** Workflows and app files only *call* the framework. This is what makes the package extraction (§15.4) mechanical instead of a rewrite.

### 15.3 `greenlight init` is the differentiator

The baseline ships `greenlight.config.example.ts` (generic domain, zero tools, one sample post). `init` copies it to `greenlight.config.ts`, prompts for the cloner's domain + tokens, and writes *their* values into provider stores + the gitignored secrets file. "Trent's setup" and "anyone's setup" are the same framework with a different manifest; `init` is literally the transform between them. Your own real config is just the output of having run `init` once.

### 15.4 Distribution: framework as published packages (the chosen path)

The framework is published to npm under the **`@rtrentjones/greenlight*`** scope; consumers depend on it and update with `pnpm update` — **no merging of framework code, ever.**

- `@rtrentjones/greenlight` — the CLI (`bin: greenlight`).
- `@rtrentjones/greenlight-verify` — the `api | playwright | mcp` harness.
- `@rtrentjones/greenlight-adapters` — the four-hook deploy adapters (`workers | vercel | oci`).
- `@rtrentjones/greenlight-shared` — manifest schema, `defineConfig`, types, loader.
- `@rtrentjones/greenlight-keepalive` — the CF Worker cron (later phase).
- Terraform: the `module "tool"` is published as a **versioned, source-referenced module** (Git tag or a Terraform registry entry), pinned by ref in consumer `infra/`.
- Lane templates (`_template-*`) ship inside the CLI package and are materialized by `greenlight add` — so updated templates arrive with a CLI bump, not a copy-paste.

**Versioning:** semver; Changesets for release notes; the CLI records the framework version it scaffolded so `doctor` can flag when a consumer is behind.

### 15.5 This repo vs. the personal repo

Two repos, one direction of dependency.

- **`RTrentJones/greenlight` (this repo, public, MIT).** The framework monorepo: `cli/` + `packages/*` + `infra/modules/` + `_template-*` + the example config + a sample blog post. It is *self-hosting* — it builds and publishes the `@rtrentjones/greenlight*` packages. It carries **no real tools and no real domain** (CI rule 15.2.1 guarantees this). The blog here is the docs site / sample, dogfooded.
- **The personal repo (e.g. `RTrentJones/rtrentjones.dev`, private).** A **thin consumer**: a `package.json` depending on the published `@rtrentjones/greenlight*` packages, a real `greenlight.config.ts`, `infra/` that calls the published `module "tool"` by pinned ref, `.github/workflows/*` that invoke the CLI, and your actual `tools/*` + `apps/blog/src/content/*`. **No framework source.** Created by: scaffold from the template → `greenlight init` → fill the manifest → `greenlight add`/`adopt`.

```
personal-repo/                      # consumes the framework; owns only config + content
  package.json                      # deps: @rtrentjones/greenlight*  ← pnpm update = framework upgrade
  greenlight.config.ts              # your domain + tools (the ONE file that defines "your setup")
  .greenlight/secrets.env           # gitignored
  infra/  main.tf                   # module "tool" { source = "git::…greenlight//infra/modules/tool?ref=vX.Y.Z" }
  .github/workflows/                # thin: `pnpm greenlight verify`, `… promote`, etc.
  apps/blog/src/content/            # your posts (theme comes from the framework)
  tools/                            # your real tools (bamcp, heistmind, …)
```

**Update flow for the personal repo:** `pnpm update @rtrentjones/greenlight @rtrentjones/greenlight-*` for code; bump the `?ref=` tag for the Terraform module; `greenlight doctor` reports version drift and any template changes worth re-materializing. No cherry-picks, no upstream-merge conflicts.

**Bootstrapping order:** until the packages are first published, the personal repo can consume the framework via `pnpm`'s workspace/`file:` link or a Git dependency at a pinned commit — the dependency *direction* (personal → framework) is identical, so nothing about the model changes when packages go live.

**Separate repo, NOT a branch of this one.** A tempting shortcut is to keep the personal wrapper on `main` and strip it on a "clean" branch for others to clone. Don't: it breaks the seam (real domain in framework files → seam-check fails / leaks), git history still contains the stripped data, and the wrapper would consume the framework via workspace instead of *published versions* — losing the no-merge-hell update channel (§15.6). It's also unnecessary: this repo is kept generic by design (the example config, blog, and ping-mcp are all generic samples), so `main` **is** the clonable baseline already — just mark the repo a GitHub *template*. The wrapper is a distinct repo that depends on the packages.

### 15.6 How updates propagate (the no-merge-hell mechanism)

**You never merge framework code. You bump a version (usually via an automated PR), and because your workflows call the CLI at *runtime*, the next `pnpm install` in CI runs the new code.** Updates are *pulled* through a gated PR, never *pushed*. This works only if the two hard rules (§15.2) hold: all behavior lives in the packages, and consumer workflows are dumb shells that only call `pnpm greenlight <cmd>`.

**Publish side (framework repo).** A merge with a Changeset triggers the release workflow: build + test → `npm publish` each `@rtrentjones/greenlight*` package → `git tag` the Terraform module. Semver carries intent: verify bug-fix = patch, new CLI flag = minor, breaking manifest-schema change = major.

**Consume side (personal repo).** `package.json` pins a **range**; `pnpm-lock.yaml` pins the **exact** version in use. The update arrives as a **dependency-bump PR** (just `package.json` + lockfile, no code):
- **Renovate/Dependabot** (normal path) polls, sees the new version, opens the PR.
- **`repository_dispatch`** (optional) lets the framework release ping the personal repo to open the PR immediately.

**How CI runs the new code.** Consumer workflows are thin:
```yaml
- run: pnpm install --frozen-lockfile     # installs the version the lockfile pins
- run: pnpm greenlight deploy --env beta  # behavior comes entirely from the installed package
- run: pnpm greenlight verify --env beta
```
So "CI picks up the change" = the bump PR updates the lockfile → that PR's CI run does `pnpm install` (pulling the new version) → the thin steps execute the new code. No consumer file knew anything changed.

**End-to-end (a verify bug-fix):**
```
greenlight repo:  fix → changeset → CI publishes greenlight-verify@1.4.1
        ▼
personal repo:    Renovate PR: bump ^1.4.0 → ^1.4.1
                  PR CI: pnpm install (1.4.1) → greenlight verify (preview) ✅
        ▼
        merge → develop → beta verify ✅ → greenlight promote → prod
```

**Safety property.** The lockfile means a framework publish cannot silently change your prod deploy — you move only when the lockfile moves, and it moves only via a PR gated by verify→promote. Rollback = revert the bump PR.

**The two artifacts that update differently (honest caveats):**
1. **Terraform module** — referenced by Git ref (`?ref=v1.4.1`), not npm. Bump the ref (Renovate can manage it), then `terraform init -upgrade && plan`. Same pull-and-gate shape, different file.
2. **Lane templates do NOT auto-update.** `greenlight add` *copies* a template into the consumer; from then on it's the consumer's file, and later template improvements don't flow into already-scaffolded tools (only into newly-added ones). Mitigations: push as much template logic as possible behind the CLI/packages so the copied file stays a thin shell (then fixes arrive via version bump after all), and have `greenlight doctor` detect template drift and offer assisted re-materialization. This is the one deliberate exception to automatic propagation.

### 15.7 Agent-context distribution — the third channel

The loop is **agent-driven during the dev cycle**: working in any of these projects, you ask for a change and the agent ships it through deploy-preview → `verify` → (beta → `verify` → `promote` → prod). For that to work in a repo, the agent must *know about* the loop — which is a distinct artifact from the code, and distributes through a **third channel**:

| Layer | Carries | Channel | Auto-updates? |
|---|---|---|---|
| loop **mechanics** | `@rtrentjones/greenlight*` + CLI | npm dependency (§15.6) | ✅ `pnpm update` |
| loop **parameters** | `greenlight.config.ts` (manifest) | per-repo file | n/a (the personal bit) |
| agent **awareness** | a Skill + `CLAUDE.md` | **plugin / filesystem** | ⚠️ not via npm |

Critically, **Claude Code does not scan `node_modules` for skills** and does not read `.agent/` — agent awareness cannot ride the npm channel. So it gets its own distribution (built in **Phase 7**):

- **Primary — a Claude Code plugin + marketplace.** Greenlight ships a `greenlight` plugin (the `deploy-verify-promote` skill + subagent). Add the marketplace once and install at **user scope** → the skill is available in **every repo you open** — the monorepo *and* standalone BAMCP/HeistMind — with zero per-repo files, versioned and updated centrally (`/plugin marketplace update`).
- **Fallback — `greenlight agent sync`.** A CLI subcommand that materializes/updates `.claude/skills/deploy-verify-promote/SKILL.md` (+ a `CLAUDE.md` block) into the current repo from the installed package version, for environments not using the plugin system.

Plugin = the *procedure*, manifest = the *parameters*, packages = the *mechanics*. In the monorepo today the skill lives at `.claude/skills/deploy-verify-promote/SKILL.md` with always-on awareness in root `CLAUDE.md`.

---

## 16. Implementation plan

Ordered **framework + loop first, then make it repeatable, then migrate the real tools, then keepalive.** Blog is the first loop subject; the MCP loop is second. Each phase has deliverables and acceptance criteria.

### Phase 0 — Monorepo skeleton + the seam
- **Deliver:** pnpm + Turborepo; `packages/{shared,verify}` + `cli/` package boundaries (logic lives only here — rule 15.2.2); `greenlight.config.example.ts` + typed `defineConfig`/loader in `@rtrentjones/greenlight-shared`; lift lint/test/husky from HeistMind; the V1 lane templates; **a CI check enforcing rule 15.2.1** (no personal strings in framework files).
- **Accept:** `pnpm install && pnpm build && pnpm lint` pass; example config loads + type-checks; the seam CI check is green and *fails* when a domain is hardcoded into a framework file.

### Phase 1 — Verify harness + deploy adapters + the loop (centerpiece)
- **Deliver:** `@rtrentjones/greenlight-verify` (`api`, `mcp`, light `playwright`); `@rtrentjones/greenlight-adapters` four-hook contract (`build`/`deploy`/`url`/`teardown`) for `workers`/`vercel`/`oci`; deterministic `url(tool, env)`; `.claude/skills/deploy-verify-promote/SKILL.md` + root `CLAUDE.md` loop awareness.
- **Accept:** the loop runs end-to-end locally against a stub tool (deploy → `verify` → promote); `verify` reports are machine-readable and identical whether run by CI or the agent.

### Phase 2 — The blog (FIRST loop subject)
- **Deliver:** `apps/blog` Astro/`workers` from `_template-astro`; light verify (`api`: 200s + valid RSS/sitemap + no broken internal links; minimal `playwright`: a post renders); `data: none`.
- **Accept:** a new post goes preview → `verify` → beta → `promote` → prod entirely through the harness. **The web loop is proven.**

### Phase 3 — CI/CD + promote gate
- **Deliver:** `ci`, `deploy`, `promote` (with **non-fast-forward guard** — refuse + instruct on divergence), `alert` workflows; three git-mapped envs (`main`/`develop`); Cloudflare Access on `beta.*`.
- **Accept:** push to `develop` deploys + verifies beta; `promote` fast-forwards to prod only after beta verify passes and refuses on a diverged `main`.

### Phase 4 — The MCP loop (SECOND loop subject)
- **Deliver:** `_template-mcp` with a Workers `McpAgent` dev shape **and** the OCI/Docker prod shape; `mcp` verify mode wired (initialize → `tools/list` → call → auth assertion); connect-URL printing; a **throwaway MCP on `mcp`→`workers`** to exercise it.
- **Accept:** `verify <throwaway> --env preview` runs the full protocol check and passes; the throwaway runs preview → beta → `promote`. **The protocol loop is proven**, without a live OCI box.

### Phase 5 — Terraform / infra as code
- **Deliver:** `infra/` root + reusable `module "tool"` (published, source-ref-pinnable per §15.4); R2 state + lockfile; **pinned provider versions**; the CLI appends a module block per tool.
- **Accept:** `terraform plan` is clean for the blog + throwaway MCP; adding a tool is one CLI-appended module block.

### Phase 6 — CLI completion + `init` differentiator + `doctor`
- **Deliver:** `init` (example→personal manifest, token prompts/validation, secrets to provider stores, first deploy — §15.3), `add`, `verify`, `promote`, `adopt` (stub for Phase 7), `doctor` (DNS, drift, manifest↔dir↔workflow consistency, framework-version drift, Vercel cap headroom).
- **Accept:** a cold clone → `init` → first deploy works from docs alone; `doctor` is all-green on a healthy repo and flags version drift.

### Phase 7 — Package publishing + agent-context distribution + stand up the personal repo
- **Status: built (validated locally); `npm publish` + live deploy gated on creds.** See [docs/phase-7-plan.md](docs/phase-7-plan.md).
- **Deliver:**
  - publish `@rtrentjones/greenlight*` to npm (Changesets, semver) + the source-ref Terraform module;
  - **agent-context distribution (§15.7):** a Greenlight **Claude Code plugin** (bundling the `deploy-verify-promote` skill + subagent) published via a **marketplace** (this repo as the marketplace source), plus a **`greenlight agent sync`** CLI fallback that materializes `.claude/skills/` + a `CLAUDE.md` block into a consuming repo;
  - create the **thin personal repo** (§15.5) consuming the published packages, with the plugin installed at user scope;
  - verify the loop runs there.
- **Accept:**
  - the personal repo depends only on published packages (no framework source); `pnpm update` upgrades the mechanics cleanly;
  - the `deploy-verify-promote` skill is available in the personal repo (and any other repo) via the user-scope plugin — no per-repo copy — and `greenlight agent sync` reproduces it for non-plugin environments;
  - the blog loop runs from the personal repo.

### Phase 8 — Keepalive (was Phase 1)
- **Deliver:** `@rtrentjones/greenlight-keepalive` CF Worker Cron (Supabase query + OCI health ping + `github-issue` alert sink); **OCI → PAYG + billing-alarm runbook**; `doctor` integration (keepalive health, OCI PAYG status, billing alarm presence).
- **Accept:** a forced failure opens a GitHub issue; once tools are migrated, Supabase survives a 7-day window and OCI is PAYG.

### Phase 9 — Migrate BAMCP + HeistMind (adopt)
- **Deliver:** `greenlight adopt` for both: manifest entries, `verify.config.ts` specs, CI wiring, branch standardization (fix HeistMind's `develop`/`development`), secrets into provider stores, Terraform import-by-reference, Supabase migration pipeline for HeistMind. Bring both **back to life on the harness**.
- **Accept:** both build + deploy + verify through the harness **without app-code changes**; HeistMind's branch bug is gone; redeploying either is `edit manifest → apply`.

### Phase 10 — Docs (dogfood)
- **Deliver:** README quickstart; per-lane READMEs; the adopt guide; the clone-vs-personal model (§15); host docs as the blog.
- **Accept:** a cold reader can scaffold → `init` → `add` and (later) `adopt` from the docs alone.

---

## 17. Open questions for V1

1. **Terraform vs. CLI scripts** — commit to Terraform, or go thinner for 5 providers? (Defaulting to Terraform; revisit during Phase 5.)
2. **`adopt` imports vs. recreate** — how much existing OCI/Vercel/Supabase state can be cleanly `terraform import`-ed vs. referenced out-of-band?
3. **Alert sink default** — `github-issue` for V1 (zero new vendor); add Resend `email` only if issue-noise becomes a problem.
4. **BAMCP PAYG** — confirm the tenancy can convert without disrupting the running service.

## 18. Identity (unchanged)

GitHub `RTrentJones/greenlight`; npm `@rtrentjones/greenlight` (bin `greenlight`); docs at `greenlight.rtrentjones.dev`; MIT, public from day one.
