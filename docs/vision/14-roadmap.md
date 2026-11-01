# 14 — Roadmap

This document orders the work into eight phases, `P0` to `P7`. Each phase is broken down into
items small enough for one pull request. For each item it gives the files it touches, the tests
that prove it, and the requirement and rule IDs it satisfies. All eight phases are in scope:

- `P0`–`P5` are the core and run in order.
- `P6`, the evolution loop, is in scope but runs last, because it builds on everything before it
  and costs the most.
- `P7`, Codex parity, is a stretch goal.

From `P0` onward the work follows the constraints that keep `P7` possible (FR-AGENT-01, ADR-02).

## 1. Release model

Every phase ships through the normal framework release. `node scripts/release.mjs <version>` bumps
the npm version and `MODULE_REF` together (lockstep), and consumers pick the release up with
`pnpm update @rtrentjones/greenlight && pnpm greenlight bump`. Because the framework wiki and skills
now ship inside the package (ADR-04), every release also carries the matching wiki and skill
versions.

The current release is `0.10.1`. The plan assigns one minor version per phase:

| phase | release | consumer action after `pnpm update` |
|---|---|---|
| P0 | 0.11.0 | `greenlight agent sync`; commit the seeded `wiki/` |
| P1 | 0.12.0 | re-run `greenlight add` dry-run diff for existing tools (optional); fix new DR warnings |
| P2 | 0.13.0 | add `liveness` to every tool (DR-20 becomes an error in 0.14) |
| P3 | 0.14.0 | none required |
| P4 | 0.15.0 | `greenlight secrets migrate --to infisical` (optional; GitHub-only remains valid) |
| P5 | 0.16.0 | none required; raw capture starts automatically |
| P6 | 0.17.0 | none; the bench runs in the framework repo |
| P7 | 0.18.0 | `greenlight agent sync` again to write `.agents/` |

**Upgrades across a 0.x minor must be explicit.** The pattern `caret-range-0x-blocks-minor` (15
§2.4) shows that `^0.10.0` will not pick up 0.11.0. Each phase's release notes therefore MUST tell
consumers to run `pnpm add @rtrentjones/greenlight@^0.<n>.0`. DR-33 flags the gap once the wiki
exists.

## 2. Dependency graph

```
P0 memory ──▶ P1 contract ──▶ P2 vibe-code ──▶ P3 portfolio ──▶ P4 secrets ──▶ P5 learning ──▶ P6 evolution
   │                              ▲   │                              │              ▲
   │                              │   └──────────────▶ (P3 reads accounts) ──────────┘ (P5 uses proxy env)
   └──── P0 portability constraints ─────────────────────────────────────────────▶ P7 Codex (stretch)
```

The hard dependencies are:

- P1 needs P0's contract pages, because templates and doctor rules cite them.
- P2 needs P1's templates, so that kickoff scaffolds a contract-compliant tool, and P0's `intent`
  schema.
- P3 needs P2's `accounts` and quota usage probes.
- P4 needs P2's kickoff, because Infisical setup is a kickoff step, and P3's portfolio, because
  promotion approval is surfaced there.
- P5 needs P4, so that captured traces contain placeholders rather than secrets, and P0's wiki
  parser.
- P6 needs P5's raw capture and maintainer, and P1's templates, because bench fixtures come from
  them.
- P7 needs only P0's portability constraints, so it can be pulled forward at any point after P0.

## 3. Sequencing summary

| phase | goal | PR items | depends on | release | exit drill |
|---|---|---|---|---|---|
| P0 | durable memory for every project and skill | 9 | — | 0.11.0 | cold edit, Claude (§P0.4) |
| P1 | every new tool is self-verifying by construction | 7 | P0 | 0.12.0 | `add` per lane passes C1/C2 on first preview |
| P2 | idea → beta URL on free accounts, no domain | 9 | P0, P1 | 0.13.0 | newcomer drill (§P2.4) |
| P3 | see and control the whole portfolio | 6 | P2 | 0.14.0 | portfolio matches reality; retire frees resources |
| P4 | agents never hold raw credentials | 8 | P2, P3 | 0.15.0 | newcomer drill with no raw secret; unapproved promote refused |
| P5 | failures become patterns and links | 7 | P0, P4 | 0.16.0 | reintroduced fault links to the right pattern |
| P6 | skills improve only by measured change | 9 | P1, P5 | 0.17.0 | one full evolution run with ≥1 accepted change |
| P7 | Codex can do everything Claude can (stretch) | 4 | P0 | 0.18.0 | cold edit and newcomer drill with Codex |

---

## P0 — Memory

**Goal.** Give every project and every skill a durable, checkable memory before building anything
that depends on it. The phase delivers the wiki schema and tooling, the seeded framework wiki, the
project wikis for the six live tools, and a `PURPOSE.md` for every existing skill, the loop skill
included.

### P0.1 Work breakdown

**P0-01 — `packages/wiki`: page parsing and schemas.**
- Files: `packages/wiki/{package.json,tsconfig.json,src/index.ts,src/schema.ts,src/parse.ts,src/ids.ts}`;
  the root `pnpm-workspace.yaml` already globs `packages/*`.
- Content: zod schemas for every page type in 08 §3, an `EvidenceRef` parser, and id normalization
  (`patterns/x` ↔ `pattern/x`, 04 §2.1).
- Tests: `packages/wiki/src/__tests__/schema.test.ts`, which covers every page type valid and
  invalid, rejects unknown fields, and rejects a `superseded` page without `supersededBy`.
- Satisfies: FR-WIKI area, LR-01, LR-02, LR-06.
- The package is `private` and bundled into the CLI via tsup `noExternal`, like the other framework
  libraries. `check-boundaries` MUST be extended so that `packages/wiki` imports only from
  `packages/shared`.

**P0-02 — `wiki lint` and `--fix`.**
- Files: `packages/wiki/src/lint.ts`, `cli/src/commands/wiki.ts` (subcommand `lint`), and the
  dispatch case in `cli/src/bin.ts`.
- Content: rules LR-01 to LR-21, except LR-14, which is stubbed until P6 writes ledgers. `--fix`
  regenerates the index, fixes ids and writes back-links. `--online` resolves `EvidenceRef`s through
  `gh`.
- Tests: `packages/wiki/src/__tests__/lint.test.ts`, with one fixture wiki per rule that passes and
  one that fails, and a golden-file test for the generated index.
- Satisfies: FR-WIKI, DR-28.

**P0-03 — Wiki in the package, and the version check.**
- Files: `cli/scripts/copy-assets.mjs` (copy `wiki/` → `cli/dist/assets/wiki/` and write `VERSION`),
  `scripts/check-plugin-sync.mjs` (mirror `wiki/` to `plugin/wiki`), and `cli/src/commands/agent.ts`
  (materialize `.greenlight/wiki/framework/`).
- Tests: `cli/src/__tests__/agent-kit.test.ts` (materialization), plus a new case in
  `doctor.test.ts`.
- Satisfies: FR-WIKI, FR-SKILL, DR-12, DR-13.

**P0-04 — `doctor` runs wiki lint.**
- Files: `cli/src/commands/doctor.ts`.
- Content: add the `wiki lint` result as one check with sub-findings. Errors fail, and warnings
  fail only under `--strict`.
- Tests: `doctor.test.ts`.
- Satisfies: DR-28.

**P0-05 — Seed the framework wiki.**
- Files: `wiki/**`, holding the pages drafted in 15 §2–§5: 16 patterns, 5 decisions, 7 contract
  pages, fact skeletons and 2 incidents.
- Content: shrink each provider skill's footgun paragraph to a one-line rule plus a link, under the
  one-home rule (04 §7).
- Tests: `wiki lint` is clean, and `check-seam` passes on `wiki/` (LR-19).
- Satisfies: FR-WIKI.

**P0-06 — `PURPOSE.md` for every existing skill.**
- Files: `.claude/skills/*/PURPOSE.md` for `deploy-verify-promote` and the nine provider skills,
  plus the mirrors under `plugin/skills/`.
- Content: the frontmatter per 08 §2.2. `deploy-verify-promote` gets `blast-radius: high` and
  `hooks: [on-start, on-failure, on-complete, on-incident]`. Provider skills get
  `blast-radius: medium` and `hooks: [on-failure]`. Each `cites` the seeded patterns behind its
  rules.
- Tests: LR-11, LR-12 and LR-13 are clean.
- Satisfies: FR-SKILL.

**P0-07 — Portability pass on skills.**
- Files: `.claude/skills/*/SKILL.md`.
- Content:
  - Remove any frontmatter beyond `name`, `description` and `version`.
  - Move any rule that depends on Claude Code tools into a sentence that works for any agent.
  - Add the portability rule to `docs/development.md`.
  - Add a lint step, `pnpm check-skill-portability`, which fails on extra frontmatter keys.
- Tests: the new script runs inside `check-all`.
- Satisfies: FR-AGENT-01.

**P0-08 — Project wiki scaffolding.**
- Files: `cli/src/commands/wiki.ts` (`wiki init`), templates under `cli/assets/wiki-project/`, and
  `adopt.ts` and `add.ts`, which call `wiki init <name>` and write the pointer block into the tool
  repo's `CLAUDE.md` (04 §2.2).
- Tests: `add.test.ts` and `adopt.test.ts` assert that the stubs and pointer block exist.
- Satisfies: FR-WIKI, LR-21.

**P0-09 — Project wiki for the six live tools (wrapper PR).**
- Files: in `RTrentJones.dev`, `wiki/**` from 15 §6–§7.
- Content: shrink the verify-config header comments in `verify/*.config.ts` and
  `apps/blog/verify.config.ts` to one line plus a link to `intent.md`.
- Tests: `pnpm greenlight doctor --strict` is green in the wrapper.
- Satisfies: FR-WIKI.

### P0.2 Dependencies and release

P0 has no dependencies, and it releases as 0.11.0. P0-09 lands in the wrapper after the 0.11.0 bump.

### P0.3 Risks

- **Seeding copies knowledge rather than moving it.** That would create a fifth copy that drifts.
  Mitigation: every seed PR also shrinks its source (P0-05, P0-09), and review checks this.
- **Lint is too strict for hand-written pages.** Mitigation: the length limits are warnings
  (LR-04). Only structural rules are errors.

### P0.4 Exit drill

A fresh Claude Code session receives the wrapper and the request "add a check that BAMCP's demo BAM
still loads after a cold start". It reads `wiki/tools/bamcp/intent.md`, adds a check with an `id`,
adds the criterion's check-id mapping, and gets a green `greenlight preview bamcp`. No operator
hint beyond the request is allowed. The drill passes if the change is correct and nothing the agent
needed was missing from the wiki. Missing knowledge found by the drill becomes a P0 fix.

---

## P1 — The self-verifying app contract in templates

**Goal.** Every tool created by `greenlight add` satisfies clauses C1, C2 and C7 of the app contract
(09) by construction. `doctor` enforces the clauses that can be checked statically.

### P1.1 Work breakdown

**P1-01 — astro template.**
- Files: `tools/_template-astro/src/pages/__version.ts` (serves `GREENLIGHT_SHA`),
  `src/pages/health/live.ts` and `src/pages/health.ts`, plus a new
  `tools/_template-astro/verify.config.ts` whose checks carry `id`s and C7 markers.
- Tests: `template-astro.test.ts` builds the template and runs verify against a local preview.
- Satisfies: FR-BUILD, C1, C2, C7.

**P1-02 — next template.**
- Files: `tools/_template-next/app/__version/route.ts` (`VERCEL_GIT_COMMIT_SHA`, falling back to
  `GREENLIGHT_SHA`), `app/health/live/route.ts`, and `app/health/route.ts`, which checks the
  database only when `data != none`.
- Tests: `template-next.test.ts`.
- Satisfies: C1, C2, C7.

**P1-03 — mcp templates (workers and oci).**
- Files: `tools/_template-mcp/{workers,oci}/…`, serving `/mcp/__version`, `/mcp/health/live` and
  `/mcp/health`, which matches BAMCP and Polyphony prod.
- Tests: `template-mcp.test.ts`.
- Satisfies: C1, C2, C7.

**P1-04 — agent template alignment.**
- Files: `tools/_template-agent/src/index.ts`.
- Content: split the existing `/health` into `/health/live` and `/health`, and add a per-producer
  freshness field (C4) and recorded-success semantics (C5).
- Tests: `template-agent.test.ts`, which already exists, is extended.
- Satisfies: C2, C4, C5.

**P1-05 — Doctor rules DR-24, DR-25, DR-26.**
- Files: `cli/src/commands/doctor.ts`, plus `packages/verify/src/inspect.ts`, a new module that
  loads a verify config statically without running it.
- Rules:
  - DR-24 warns when a tool's verify config has no `/__version` check, or no
    `requireIdentity: true` on a prod path.
  - DR-25 warns when a tool with a cron or feed lacks a `maxAgeHours` assertion. A tool is detected
    as having one through `wrangler.toml` triggers, `vercel.json` crons, or the `agent` lane.
  - DR-26 warns when a function-form config branches on `ctx.env` but no check is marked
    environment-invariant.
- Tests: `doctor.test.ts`.

**P1-06 — Doctor rules DR-20 to DR-23 (liveness), warn-only in P1.**
- Files: `cli/src/commands/doctor.ts`.
- Content: replace the inline "keepalive coverage" computation at `doctor.ts:290` with liveness
  rules that read the manifest `liveness` field. That field is added to the schema in P2-01, so in
  P1 the rules infer the model from `data` and `target` and only warn.
- Tests: `doctor.test.ts`.
- Satisfies: FR-PORT.

**P1-07 — Contract pages wired to their enforcers.**
- Files: `wiki/contract/c*.md`, updated so `enforcedBy` names the template paths and DR ids.
- Tests: `wiki lint`.

### P1.2 Dependencies, release, exit

- **Dependencies:** P0 (contract pages, lint).
- **Release:** 0.12.0.
- **Exit:** for each lane (astro, next, mcp/workers, mcp/oci, agent), `greenlight add t-<lane> …`
  followed by `greenlight preview t-<lane>` passes C1 and C2 on the first run, with no edits.

### P1.3 Risks

- **Template changes surprise existing adopted tools.** Mitigation: they do not, because templates
  apply only to new tools. Existing tools see new DR warnings, which are fixable one at a time.
- **Vercel previews do not carry the sha.** Mitigation: the next template's `/__version` reads
  `VERCEL_GIT_COMMIT_SHA`, which Vercel sets on git-integration builds. A local preview reports
  `null`, and the check is skipped there, matching HeistMind's existing behavior.

---

## P2 — The vibe-code flow

**Goal.** Someone with only free accounts, and no domain, goes from a one-sentence idea to a beta
URL. Their acceptance criteria are recorded and executable, their complaints become checks, and
prod changes only when they say so.

### P2.1 Work breakdown

**P2-01 — Manifest schema changes.**
- Files: `packages/shared/src/schema.ts`.
- Content: make `domain` optional; add `cloudflareAccountSubdomain`, `promotion`, `liveness`,
  `wiki` and `kind`; add the consistency rules in 08 §1.2.
- Tests: `packages/shared/src/__tests__/schema.test.ts`, covering every new rule in both directions.
- Satisfies: FR-KICK-04, FR-PORT.

**P2-02 — No-domain URL resolution and adapters.**
- Files:
  - `packages/shared/src/url.ts` (08 §1.3);
  - `packages/adapters/src/index.ts`: for workers, beta becomes the `<name>-beta` Worker; for
    vercel, `url()` reads the project alias;
  - `cli/src/commands/init.ts`, which accepts an absent `--domain`, asks for the workers.dev
    subdomain, and skips zone tokens;
  - the `infra/modules/*` emit paths in `cli/src/tf-emit.ts`, which emit no DNS when the domain is
    absent.
- Tests: `url.test.ts`, `tf-emit.test.ts`, and an `init` no-domain case.
- Satisfies: FR-KICK-04, ADR-09.

**P2-03 — Verify check `id`.**
- Files: `packages/verify/src/{types.ts,validate.ts,export.ts,api.ts,mcp.ts}` (08 §6).
- Tests: `verify-config.test.ts`, covering a duplicate id, a wrong-typed id, and the id appearing
  in the report and as `eval.check_id`.
- Satisfies: FR-BUILD, LR-15.

**P2-04 — Provider usage probes.**
- Files: `cli/src/providers.ts`, where each pack gains an optional `usage` function (08 §12).
- Content: implement usage probes only where the provider exposes a documented usage API; packs
  without one report `null`. Each function references a fact page quota key.
- Tests: `providers.test.ts`, with mocked fetch.
- Satisfies: FR-PORT.

**P2-05 — `greenlight accounts`.**
- Files: `cli/src/commands/accounts.ts` and `bin.ts`.
- Content: read configured tokens with `secrets check` semantics, run `verify()` unless `--offline`,
  run usage probes, and compute the cells available from the providers configured. The output is
  08 §11.1.
- Tests: `accounts.test.ts`, which covers human output and `--json` and asserts that no token value
  ever appears in output.
- Satisfies: FR-KICK, FR-PORT.

**P2-06 — `greenlight-kickoff` skill.**
- Files: `.claude/skills/greenlight-kickoff/{SKILL.md,PURPOSE.md}` and the plugin mirror.
- Content: the procedure in 05 §5.2.
- Tests: LR-11, LR-12 and LR-13; skill portability.
- Satisfies: FR-KICK.

**P2-07 — `greenlight-build` skill.**
- Files: `.claude/skills/greenlight-build/{SKILL.md,PURPOSE.md}`.
- Content: the procedure in 05 §5.3. It includes the rules "criterion → check id before code" and
  "complaint → criterion (source: feedback) → check → fix".
- Satisfies: FR-BUILD.

**P2-08 — Loop skill v3.**
- Files: `.claude/skills/deploy-verify-promote/{SKILL.md,PURPOSE.md}`.
- Content: add the hooks (05 §3): on-start reads `intent` and `liveness`; on-failure runs
  `wiki lookup`, which is wired in P5 and is a no-op until then; on-complete updates `intent.md`.
  Add the rule that **promotion is the owner's call** unless the tool's `promotion` is
  `auto-on-green`.
- Versioning: bump to `version: "3"` by hand, because this is the last manual bump. From P6 onward
  only the harness bumps versions.
- Satisfies: FR-LOOP.

**P2-09 — Liveness rules become errors for new tools.**
- Files: `doctor.ts`.
- Content: DR-20 is an error for tools added at or after 0.13.0, detected by the absence of an
  entry in `.greenlight/legacy-tools.json`, which `bump` writes once. DR-21 is an error.
- Tests: `doctor.test.ts`.

### P2.2 Dependencies, release

P2 depends on P0 and P1, and it releases as 0.13.0.

### P2.3 Risks

- **No-domain mode breaks the deterministic-URL invariant for Vercel.** Mitigation: the adapter
  supplies the alias, and `resolveUrl` throws for vercel without a domain, just as it does for
  `preview`. Callers go through `adapter.url()`.
- **Usage APIs differ by plan or change without notice.** Mitigation: headroom is `null` rather
  than a guess, and fact pages carry `verified` dates (LR-17).

### P2.4 Exit drill (the newcomer drill)

The operator recruits, or role-plays, someone who has never used Greenlight. That person has a
GitHub account and a free Cloudflare account, no domain, and nothing else. They give a fresh Claude
Code session, with the plugin installed, one sentence such as "a page where my book club votes on
next month's pick".

The drill passes when all of the following hold:

- A beta URL on workers.dev serves the app.
- `intent.md` lists the criteria the person confirmed, each with a check id.
- At least one complaint made after trying beta appears as a `source: feedback` criterion with a
  passing check.
- Prod is unchanged until the person says to release.

The operator records the time from the first sentence to a green beta. It is the BR success metric
"idea to beta".

---

## P3 — Portfolio operations

**Goal.** The owner sees every project's state in one place, including what is verified and waiting
for release, and can retire a project cleanly. No new project can starve an existing one of quota
without a warning first.

### P3.1 Work breakdown

**P3-01 — `greenlight portfolio`.**
- Files: `cli/src/commands/portfolio.ts`.
- Content: for each tool, compare beta and prod shas from `/__version` against the deterministic
  URLs, count commits on `develop` that are not on `main` via `gh api compare`, read the last ship
  from stage events or Tracer, read keepalive state from the latest keepalive issue or run, and list
  open alert issues. The output is 08 §11.2.
- Tests: `portfolio.test.ts`, with mocked fetch and `gh`.
- Satisfies: FR-PORT.

**P3-02 — Quota headroom rule DR-27.**
- Files: `doctor.ts` and `accounts.ts`.
- Content: `doctor --live` warns when any quota has under 20% headroom. `add` refuses, with
  `--force` to override, when the new tool's declared `liveness.quotas` would push a quota past 80%
  usage, as measured or as declared.
- Tests: `doctor.test.ts` and `add.test.ts`.

**P3-03 — `greenlight retire <name>`.**
- Files: `cli/src/commands/retire.ts`.
- Content: remove the manifest entry through `config-io.ts`, delete `infra/<name>.tf`, move
  `wiki/tools/<name>/` to `wiki/archive/tools/<name>/` with a final log entry, and remove the
  keepalive target. Then print the push instruction. The existing `infra.yml` destroy guard requires
  manual approval for the resulting destroy. `retire` never applies anything itself.
- Tests: `retire.test.ts`, covering the files changed and the refusal when another tool has
  `dataShareWith` pointing at this one.
- Satisfies: FR-PORT.

**P3-04 — `greenlight-portfolio` skill.**
- Files: `.claude/skills/greenlight-portfolio/{SKILL.md,PURPOSE.md}`.
- Content: the procedures for "what is waiting", "release X" (prepare, show the evidence, ask, then
  dispatch only on an explicit yes), and "retire Y" (05 §5.4).
- Satisfies: FR-PORT, FR-LOOP.

**P3-05 — Promote workflow emits a `promote` stage event.**
- Files: `cli/src/commands/promote.ts` and `packages/loop/src/promote.ts` (StageEvent stage
  `promote`, 08 §7).
- Tests: `promote` unit tests.

**P3-06 — Portfolio summary page.**
- Files: `cli/src/commands/wiki.ts`.
- Content: `wiki lint --fix` regenerates `wiki/portfolio.md` from the manifest and each tool's
  `intent` one-liner.

### P3.2 Dependencies, release, exit, risks

- **Dependencies:** P2 (accounts, usage probes, liveness field).
- **Release:** 0.14.0.
- **Exit:** the operator checks the portfolio table for the six live tools by hand against
  reality once. A throwaway tool `t-retire`, added and shipped to beta, is retired, and after the
  approved infra apply its Worker, DNS and keepalive target are gone.
- **Risk:** `gh api compare` rate limits on large portfolios. Mitigation: cache per run, and show
  `waiting: null` on failure rather than erroring.

---

## P4 — Centralized secrets

**Goal.** One readable source of secrets, with CI and runtime as projections of it. Agents work
behind a credential-injecting proxy and never hold raw values. The agent cannot dispatch a
promotion without approval, enforced as a mechanism.

### P4.1 Work breakdown

**P4-01 — `inject` and `scrub` on token specs.**
- Files: `cli/src/providers.ts` (08 §12).
- Content: add `inject` for Cloudflare, Vercel, Neon, Supabase, Gemini, HCP and GitHub. OCI and
  docker get none, so they are CI-only.
- Tests: `providers.test.ts`, checking that every injectable token has non-empty `hosts` and
  `allow`, and default-deny semantics.
- Satisfies: FR-SEC.

**P4-02 — Secret sinks.**
- Files: `cli/src/commands/secrets.ts` and a new `cli/src/secret-sinks/{github.ts,infisical.ts}`.
- Content: `secrets gather --sink infisical|github`, defaulting to the sink in
  `.greenlight/secrets.json`, which holds no values. The Infisical sink writes through the Infisical
  API using a machine identity, and configures Infisical's GitHub sync so Actions secrets stay
  populated.
- Tests: a secrets test with mocked HTTP, asserting values travel only in request bodies, never in
  argv or logs.

**P4-03 — `secrets migrate --to infisical`.**
- Content: for each token name in the manifest, prompt for the value with hidden input and write it
  to Infisical. Actions secrets cannot be read, so the owner re-enters each value once.
- Tests: secrets test.

**P4-04 — `secrets proxy-config`.**
- Files: `cli/src/commands/secrets.ts` (`proxy-config`) and `cli/src/proxy/{infisical.ts,worker.ts}`.
- Content: render the union of `inject` specs into Infisical Agent Proxy service definitions, or
  into the route table for the Worker proxy.
- Tests: golden files.

**P4-05 — Worker proxy (fallback implementation).**
- Files: `infra/modules/agent-proxy/` (Terraform plus Worker source) and `packages/agent-proxy/`.
- Content: a reverse proxy at `vault.<domain>`, or `vault.<sub>.workers.dev`. It authenticates with
  per-session tokens that have a TTL, enforces the per-route allow-list, scrubs responses, and
  writes audit lines (11 §4).
- Tests: Worker unit tests (miniflare), including a mutation test proving that forbidden routes are
  refused.
- Satisfies: FR-SEC, ADR-06.

**P4-06 — `greenlight agent run -- <cmd>`.**
- Files: `cli/src/commands/agent.ts`.
- Content: start, or connect to, the configured proxy, set the placeholder environment variables,
  `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1` and the CA bundle, then exec the command.
- Tests: agent test, asserting the child's environment holds placeholders only.

**P4-07 — Promotion guard DR-32.**
- Content: the GitHub `inject` allow-list excludes
  `POST /repos/*/actions/workflows/promote.yml/dispatches`. The `greenlight-portfolio` skill
  instead asks the owner to approve. Approval flows through the `promote` GitHub environment's
  required reviewers, which `infra/modules/github` sets for the wrapper, so the owner clicks
  approve in GitHub.
- DR-32 fails when `promote.yml` lacks an `environment:` with required reviewers on a tool whose
  `promotion` is `human`.
- Tests: `doctor.test.ts`, plus a proxy test.

**P4-08 — Doctor rules DR-30 and DR-31.**
- DR-30 lists CI-only tokens, informationally.
- DR-31 fails when an agent session environment (detected via `GREENLIGHT_AGENT`) contains a value
  matching a known token shape, or lacks `NODE_USE_ENV_PROXY=1` while `HTTPS_PROXY` is set.
- Tests: `doctor.test.ts`.

### P4.2 Dependencies, release, exit, risks

- **Dependencies:** P2 (kickoff runs Infisical setup) and P3 (portfolio surfaces approvals).
- **Release:** 0.15.0.
- **Exit:** the P2 newcomer drill runs under `greenlight agent run`. A scan of the agent's
  environment and of the captured transcript finds no raw credential. The agent's attempt to call
  the promote dispatch directly is refused by the proxy, and the refusal appears in the audit log.
- **Risks:**
  - Infisical's Agent Proxy may not be on the free tier, which was unconfirmed at the time of
    writing. Mitigation: the Worker proxy (P4-05) is a complete fallback, and the decision is made
    at the start of P4 (16 §2).
  - TLS interception widens the trust surface. Mitigation: prefer the Worker reverse proxy where
    clients support a base-URL override, and document which clients do (11 §4).

---

## P5 — Learning from failures

**Goal.** Every gate run leaves durable, redacted evidence. Failing checks link to the pattern that
explains them. Incidents can be compiled into patterns by a maintainer pass.

### P5.1 Work breakdown

**P5-01 — Raw capture.**
- Files: `packages/wiki/src/raw.ts`, plus hooks in `cli/src/commands/{preview,ship,verify}.ts`.
- Content: write `RawRecord` (08 §5) after each run, with `refs` taken from `GITHUB_RUN_ID` and
  `GITHUB_REPOSITORY` when present. Excerpts are truncated to 15,000 characters and redacted (11 §6).
- Tests: `raw.test.ts`. A planted-secret test plants every provider-pack `envVar` value shape and
  every scrub pattern, and fails the build if any survives. This test is a merge blocker.
- Satisfies: FR-WIKI, FR-SEC.

**P5-02 — StageEvent extension.**
- Files: `packages/loop/src/ship.ts`, `cli/src/commands/ship.ts` (`skillVersions()`) and
  `cli/src/commands/preview.ts`.
- Content: add `skills`, `agent` and `rawId` (08 §7). `skillVersion` is kept.
- Tests: `ship` tests, plus a compatibility test showing that old consumers parsing only the old
  fields still work.

**P5-03 — Tracer ingest of raw records.**
- Files: `cli/src/commands/ship.ts` (`stageEventToIngest`).
- Content: include `rawId` and `skills` as OpenInference attributes. In the Tracer repo, add a
  `wiki` suite view of first-pass rate by skill version. That part is optional and tracked
  separately.
- Tests: `ship` test.

**P5-04 — `greenlight wiki lookup`.**
- Files: `packages/wiki/src/lookup.ts` and `cli/src/commands/wiki.ts`.
- Content: given a check id, check name, class or cell, return `confirmed` patterns whose `applies`
  includes the installed version, following `supersededBy` links.
- Tests: `lookup.test.ts`.
- Satisfies: FR-WIKI, ADR-10.

**P5-05 — Verify failure reports link to patterns.**
- Files: `cli/src/commands/verify.ts` and `cli/src/commands/ship.ts`.
- Content: on a failing check, run the lookup and append `see: <path>` lines to the human report,
  and `eval.wiki_refs` to `--json`. Record `wikiHits` on the raw record.
- Tests: `verify.test.ts`.

**P5-06 — DR-33: open pattern fixed in a newer version.**
- Files: `doctor.ts`.
- Tests: `doctor.test.ts`, using a fixture pattern with `applies: "<0.9"` and an installed 0.8.4.

**P5-07 — Maintainer ingest.**
- Files: `packages/wiki/src/ingest.ts` (bundle builder plus `MaintainerOutput` validator and
  applier, 08 §9.1), the `wiki ingest` subcommand, and the maintainer section of the
  `greenlight-wiki` skill (05 §5.5, 06 §2).
- Tests: `ingest.test.ts`, with golden files for each patch op, refusal on zero or multiple target
  matches, and atomic rejection.
- Satisfies: FR-EVO, FR-WIKI.

### P5.2 Dependencies, release, exit, risks

- **Dependencies:** P0 (parser) and P4 (placeholders in traces).
- **Release:** 0.16.0.
- **Exit:** in a throwaway tool, the keepalive probe for a needs-traffic target is pointed at a
  cache path. Verify, or the keepalive dry run, fails. The report links to
  `pattern/keepalive-probe-schema-cache`, and `wiki ingest` over the resulting raw records produces
  a lint-clean update to that pattern's evidence.
- **Risk:** redaction misses a new token shape. Mitigation: agents hold only placeholders after P4,
  so redaction is the backstop rather than the primary control, and the planted-secret test grows
  with every new provider pack.

---

## P6 — The evolution loop (in scope, ordered last)

**Goal.** Every managed skill, the loop skill `deploy-verify-promote` included, changes only through
a measured, gated proposal with a ledger row. The bench contains a replay task for every confirmed,
locally reproducible failure pattern, and every grader is shown to fail on its mutants.

### P6.1 Work breakdown

**P6-01 — Bench runner.**
- Files: `bench/` and `packages/bench/src/{task.ts,run.ts,sandbox.ts}`.
- Content: validate `TaskSpec` (08 §10), materialize the fixture into a temp directory, run the
  agent headless with the brief and the plugin (Claude Code `claude -p`, behind the P4 proxy
  pointed at fake upstreams), then run the hidden grader through `greenlight preview`. Wiki lookup
  is disabled during rollouts (ADR-10).
- Tests: runner unit tests with a stub agent.
- Satisfies: FR-EVO.

**P6-02 — Mutation checks.**
- Files: `packages/bench/src/mutants.ts` and `scripts/check-graders.mjs`, which runs in `check-all`
  whenever `bench/**` changes.
- Content: each grader must fail on every mutant.
- Tests: mutants on a fixture task.
- Satisfies: FR-EVO.

**P6-03 — Replay tasks.**
- Files: `bench/tasks/replay/*`.
- Content: one replay task for each `confirmed` failure pattern in 15 §2 that is reproducible
  locally. Where the runtime cannot be reproduced locally, the task is graded structurally,
  `fidelity: structural` (06 §4.4).
- Tests: `check-graders`.

**P6-04 — Capability briefs.**
- Files: `bench/tasks/cap/*`.
- Content: about 30 briefs across the free-tier cells, split train/val/test in `bench/splits.json`
  with a 10-brief val split to start.
- Tests: `check-graders`.

**P6-05 — Proposer.**
- Files: `packages/wiki/src/propose.ts`, the `wiki propose` subcommand, and the proposer section of
  the `greenlight-wiki` skill (06 §3).
- Content: validate `ProposerOutput` (08 §9.2). `issue` actions open GitHub issues, and
  `create`/`patch` actions stage a branch.
- Tests: `propose.test.ts`.

**P6-06 — Gate.**
- Files: `packages/bench/src/gate.ts` and the `bench gate` subcommand.
- Content: the lexicographic gate (06 §5): replay first as a hard constraint, then strict
  capability improvement, using a paired bootstrap with 1,000 resamples and p < 0.05, three runs,
  and two models. The blast-radius strictness per `PURPOSE.md` is applied (06 §5.4).
- Tests: `gate.test.ts`, using synthetic score vectors.
- Satisfies: FR-EVO, ADR-11, ADR-12.

**P6-07 — Ledger writer and version bump.**
- Files: `packages/wiki/src/ledger.ts`.
- Content: only `bench gate` and `wiki remediate` call it. It appends a `LedgerRow` (08 §8),
  renders `skill-impact.md`, and on acceptance bumps `version` in both `SKILL.md` and `PURPOSE.md`.
  LR-14 is enabled.
- Tests: `ledger.test.ts`.

**P6-08 — `wiki remediate` for outlets 1–4.**
- Content: record field evidence (red-to-green on a deployed artifact) against a pattern's
  remediation, and set `verified: true`.
- Tests: unit tests.

**P6-09 — Scheduled re-evaluation.**
- Files: `.github/workflows/bench-monthly.yml` in the framework repo, run by manual dispatch plus a
  monthly cron.
- Content: re-run the test split on the current default models and open an issue on regression.
  It is budget-capped by `BENCH_MAX_ROLLOUTS`.

### P6.2 Applies to every managed skill

The loop skill, the kickoff, build, portfolio and wiki skills, and all nine provider skills are
managed equally. Each `PURPOSE.md` declares a `bench-slice`. A proposal against a skill runs:

- that skill's slice;
- every replay task, regardless of slice, because a change to any skill can reintroduce any
  incident;
- for `blast-radius: high` skills (the loop), the full val split.

### P6.3 Dependencies, release, exit, risks

- **Dependencies:** P1 (templates are bench fixtures) and P5 (raw capture, maintainer).
- **Release:** 0.17.0. Accepted skill changes ship in later patch releases, which a human cuts.
- **Exit:** one full evolution run from the then-current skills completes. At least one proposal is
  accepted with a ledger row whose patterns are cited by the changed skill's `PURPOSE.md`, and the
  test split is reported against the starting skills.
- **Risks:**
  - Cost. Mitigation: the 10-brief val split to start, early stopping at R = 1.0, a monthly cap,
    and on-demand runs only.
  - Overfitting to the bench. Mitigation: a held-out test split, new briefs seeded from field
    patterns, and graders that check behavior rather than layout.

---

## P7 — Codex parity (stretch)

**Goal.** Codex can do everything Claude Code can in a Greenlight repo.

### P7.1 Work breakdown

**P7-01 — `agent sync` writes `.agents/skills/` and an `AGENTS.md` block.**
- Files: `cli/src/commands/agent.ts`.
- Tests: `agent-kit.test.ts`.
- Satisfies: FR-AGENT.

**P7-02 — `check-agent-sync` guard (DR-14).**
- Content: `.agents/skills/` is byte-identical to `.claude/skills/` in every repo that has both.
- Files: `scripts/check-agent-sync.mjs` and `doctor.ts`.

**P7-03 — Codex cloud secrets path.**
- Content: document, and make the skills state explicitly, that Codex cloud strips secrets before
  the agent phase. Authenticated verify therefore runs in CI `ship`, or through the proxy when
  Codex's network policy allows it.
- Files: the skills and `docs/agentic-loop.md`.

**P7-04 — `GREENLIGHT_AGENT=codex` attribution.**
- Content: the skills set this variable, so stage events and raw records attribute runs to the
  right vendor.

### P7.2 Exit

The P0 cold-edit drill passes with Codex on a different tool, and the P2 newcomer drill passes with
Codex driving.
