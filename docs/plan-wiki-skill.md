# Plan — the Greenlight wiki skill

Status: **PLAN** (not built). The rationale is in [wiki-skill-design.md](wiki-skill-design.md).
This plan sets the priorities, and where the two disagree, this plan wins. Background:
WikiSkill (arXiv:2608.27454).

## The vision this serves

Greenlight manages a **portfolio of projects**. It keeps them alive, it lets Claude or Codex edit
any of them, it verifies each change in beta, and it leaves the release decision with the owner.
This extension adds one thing: someone who has set up a few free-tier accounts can **vibe code** a
new web app, or other software, simply by describing it. The new project then joins the portfolio
on the same terms as the others.

Every item in this plan has to serve at least one of four outcomes:

1. **Start.** A new project starts easily on the accounts the user already has.
2. **Edit.** An agent that has never seen a project can change it safely.
3. **Stay alive.** Every project stays alive unattended, and none of them starves the others of
   free-tier quota.
4. **Release.** Release stays in human hands, and the human can see what is waiting.

The paper's automated skill-evolution loop (bench, proposer, gate) serves these outcomes only
indirectly, and it is the most expensive part. It therefore comes last and is optional (Phase 6).
The wiki's first job is something the paper does not cover: **memory that outlives a chat
session**, so that whichever agent opens a project next knows what it is for and how it is kept
alive.

## What the user experiences

The loop this plan builds, from the user's side:

1. The user says *"I want a site where my book club can vote on next month's pick."*
2. The agent runs `greenlight accounts`. It reports which providers are configured and verified,
   and how much free-tier headroom is left **across the whole portfolio**.
3. The agent proposes a cell using only those accounts, for example astro/workers/d1. It explains
   the free-tier consequences in a sentence or two, drawn from the wiki's fact pages. Example:
   "D1 stays up without traffic; this adds about 1% to your Workers request usage."
4. The agent writes the project's `intent.md`. It records the acceptance criteria in the user's own
   words ("members can vote once; results show after the deadline"), and the user confirms them.
5. The agent scaffolds from a template that already serves `/__version` and liveness/readiness
   routes. It turns each acceptance criterion into a verify check **before** writing the feature,
   then builds until `greenlight preview` is green.
6. The agent pushes to `develop`, and CI ships beta. The user gets a beta URL to try.
7. The user says what is wrong, in plain language. **Each complaint becomes a verify check plus a
   fix**, so it cannot come back, and it is recorded in `intent.md`.
8. The user says "ship it". Only then does promotion run: verify beta at the pinned sha,
   fast-forward, then ship prod. The agent can prepare a release but cannot perform one on its own
   initiative.
9. Months later, an agent in a fresh session (eventually Codex too) is asked to add a feature. It reads the project wiki, sees the intent, the
   liveness model and the past incidents, and goes through the same gates.

The user never has to read Terraform, YAML or a token, but nothing is hidden from them.

## The wiki, in priority order

### 1. Project wiki: the handoff memory (primary)

Each manifest tool gets `wiki/<tool>/` in the **wrapper**. The wrapper is the portfolio's home, and
it already owns each tool's verify config and infra. Tool repos get a generated pointer in their
`CLAUDE.md` (and `AGENTS.md` once Phase 7 lands), so an agent working inside a submodule finds the wiki.

| page | holds | today it lives in |
|---|---|---|
| `intent.md` | purpose, users, acceptance criteria in the user's words, each mapped to a verify check id; complaints turned into checks | chat history (lost) |
| `liveness.md` | what is at risk while idle (store pauses / compute reclaimed / must stay silent), which probe guards it, which free-tier quotas it draws on | verify-config header comments, manifest comments, blog posts |
| `decisions.md` | choices and reasons ("polyphony is lane mcp only to reach the oci target") | manifest comments |
| `incidents/` | timelines with evidence links | blog posts, GitHub issues |

The existing projects already prove this content is needed. BAMCP's verify config opens with a
forty-line comment explaining why each check exists. Polyphony's manifest entry carries a paragraph
explaining a lane choice that otherwise looks wrong. The keepalive post is an incident page written
as an essay. The project wiki gives this knowledge a home that `doctor` can check. The
verify-config comments then shrink to links.

### 2. Framework wiki: shared knowledge (secondary)

`Greenlight/wiki/` holds knowledge that is true for every user:

- `fact` pages, one per free tier, with quotas, whether a card is required, idle behavior, how to
  query current usage, and a verified-on date;
- `pattern` pages compiled from real incidents;
- `contract` pages, one per clause of the self-verifying-app contract.

The page schema, outlet ranking and versioning are in design sections 2–3. It ships with the CLI in
lockstep, and `agent sync` materializes it.

### 3. Automated skill evolution (optional, last)

The paper's mechanism is in design section 5. It is worth building only once the portfolio is
large enough that skill quality, not missing features, is the bottleneck.

## Portfolio concerns the extension creates

Vibe coding makes projects cheap to start. That turns several problems that do not matter at six
projects into the main risks at twenty.

- **Free tiers are per account, and projects share them.** Neon compute hours and project count,
  Workers requests per day, Vercel Hobby limits, Gemini requests per day, and OCI's A1 allowance
  are all spent by every project together. Polyphony alone came close to using up Neon's compute
  allowance (design §1.3). `greenlight accounts` reports headroom from provider usage APIs where
  they exist, and from fact-page quotas otherwise. Kickoff warns before a new project would push an
  account past roughly 80% of a limit.
- **Every project declares its liveness model.** `liveness.md` and a matching manifest field say
  whether the project needs traffic (Supabase), needs silence (Neon) or needs a reclaim heal (OCI).
  `doctor` fails a project whose store pauses and which has no keepalive, and it fails a
  scale-to-zero project whose probe touches the store.
- **Release visibility.** `greenlight portfolio` gives one table for all tools:
  - the beta sha against the prod sha, showing what is verified and waiting for a release
    decision;
  - the last ship result;
  - the last keepalive sweep;
  - open alert issues;
  - quota headroom.

  This table is the operator's release control panel. Tracer can render it, but the CLI output is
  the source.
- **Retirement.** A dead vibe-coded project keeps consuming quota and keepalive sweeps.
  `greenlight retire <name>` removes the manifest entry, archives `wiki/<tool>/`, and lets
  `infra.yml` destroy the resources through the existing destroy guard with manual approval.

## Agent neutrality: Claude first, Codex as the stretch

Claude Code is the target for Phases 0–6. Codex support is a stretch goal (Phase 7). The earlier
phases must not close it off, so they follow three constraints that cost almost nothing now.

**Constraints that apply from Phase 0:**
- **Portable skills.** Skills use only the shared SKILL.md standard: `name` and `description`
  frontmatter, then a markdown body, with no Claude-only frontmatter or tool names doing real work.
  A Claude-specific hint is allowed only if a skill still works when an agent ignores it.
- **The CLI is the interface.** Anything an agent needs to *query* is a CLI command, never a vendor
  feature: `accounts`, `portfolio`, `wiki lookup`, `status` and `verify`. Any agent that reads
  command output can then use it.
- **Mechanism over instruction.** Gates live in CI and the CLI: promotion approval, SHA gating and
  the credential proxy. They then hold whichever agent pushes.

**What Phase 7 adds, for reference.**
- Codex reads `AGENTS.md` and repo skills in `.agents/skills`, using the same SKILL.md standard.
  `agent sync` would write both skill trees and both instruction blocks from one source.
- A `check-agent-sync` guard would keep the copies identical, as `check-plugin-sync` does today.
- Codex cloud removes secrets before the agent phase starts. Codex tasks would therefore rely on
  CI's `ship` or the credential proxy for authenticated verification, and the skills would say so.

## Other software, not just web apps

The lanes today are `astro`, `next`, `mcp` and `agent`, which cover sites, apps, MCP servers and
scheduled agents. Vibe-coded software also includes bots, APIs, CLIs and libraries.

- **Bots and APIs** fit the existing workers path. A `hono` lane is already a v2 aim, and
  HeistMind's Discord interactions endpoint shows the bot shape.
- **Packages and CLIs** need no hosting. They need a `package` lane where:
  - beta is a prerelease dist-tag;
  - verify installs from the registry and runs a smoke command (`test` mode);
  - promote moves the dist-tag to `latest`.

  The loop has the same shape and needs no keepalive. This is out of scope for this plan's core
  phases, but the contract and wiki schema must not assume HTTP, so that the lane can be added
  without a redesign.

## Phases

Each phase has a test that shows it is done.

**Phase 0: memory.**
- Define the project-wiki schema and write `wiki/<tool>/` for all six live tools from the material
  that already exists: verify-config comments, manifest comments, blog posts, issues #55 and #86.
- Seed the framework wiki with free-tier `fact` pages, including quotas, and with patterns from the
  incident corpus.
- Write the skills to the portability constraints above.
- *Done when* a fresh Claude session, given only the wrapper and the request "add a check that
  BAMCP's demo BAM still loads", makes the change and gets a green `preview` without being told
  anything the wiki does not say.

**Phase 1: the contract in templates.**
- Put `/__version`, the split between `/health/live` and `/health`, and the marking of
  environment-invariant checks into the astro, next and mcp templates. Only the agent template has
  these today.
- Add `doctor` rules: a liveness model is declared, a pausing store has a keepalive, and a
  scale-to-zero store is not probed.
- *Done when* `greenlight add` for every lane produces a tool whose first `preview` already passes
  identity and liveness checks.

**Phase 2: the vibe-code flow.**
- Add `greenlight accounts`.
- Add the no-domain mode, falling back to `workers.dev` and `vercel.app` (design §6.1).
- Write the kickoff and build skills, including two rules: each acceptance criterion maps to a
  verify check, and each complaint becomes a check.
- Make the skills state that promotion is the user's call.
- *Done when* someone who has never used Greenlight, with only free accounts and no domain, goes
  from a one-sentence idea to a beta URL. Their complaints are visible as checks in `intent.md`, and
  prod changes only after they say so.

**Phase 3: portfolio operations.**
- Add `greenlight portfolio` (beta ahead of prod, ship and keepalive state, alerts, quota
  headroom).
- Add `greenlight retire`.
- Add the kickoff headroom warning.
- *Done when* the portfolio table for the six live tools matches reality, checked by hand once.
  Retiring a throwaway test tool also frees its resources through the guarded apply.

**Phase 4: centralized secrets.**
- Make Infisical, or the `--sink github` fallback, the single readable source, and have it sync
  secrets to GitHub Actions.
- Add the `inject` field to the provider registry, run agents behind the credential proxy, and list
  CI-only tokens explicitly (design §11).
- The proxy's GitHub allow-list denies the agent the call that dispatches `promote.yml` unless the
  user has approved it. This turns "release stays in human hands" from a skill instruction into a
  mechanism.
- *Done when* a full Phase 2 drill runs with no raw credential in the agent's environment, and the
  agent's attempt to dispatch promotion without approval is refused.

**Phase 5: learning from failures.**
- Add reference-based raw capture feeding Tracer, with `.greenlight/raw/` as the fallback.
- Add `greenlight wiki lookup`, and have verify failure reports link to matching patterns.
- Add the maintainer procedure that compiles incidents into patterns, and route each pattern to its
  strongest outlet (design §2).
- *Done when* a deliberately reintroduced known failure, such as a keepalive probe pointed at a
  cache, fails verify with a link to the right pattern.

**Phase 6 (optional): automated skill evolution.**
- Build the bench from replay tasks plus capability briefs, with mutation-tested graders, a
  lexicographic gate, a two-model gate and the remediation ledger (design §5).
- Start this phase only if Phases 0–5 have been running long enough that the first-pass gate rate,
  rather than missing features, limits the portfolio.

**Phase 7 (stretch): Codex parity.**
- Make `agent sync` write `.agents/skills/` and `AGENTS.md` alongside the Claude copies.
- Add the `check-agent-sync` guard.
- Document the Codex cloud secrets path, which runs through CI `ship` or the proxy.
- *Done when* the Phase 0 drill passes with Codex on a different tool, and the Phase 2 drill passes
  with Codex driving.

## How we know it is working

Two measures track the vision directly. Both can be taken by hand from the start.

- **Idea to beta.** The time from "I want X" to a green beta URL on a fresh free-tier account. This
  measures outcome 1.
- **Cold-edit first-pass rate.** How often an agent editing a project it did not create passes the
  local gate on the first push. This measures outcome 2 and the value of the project wiki. Stage
  events already record the first-pass rate per skill version, and Phase 5 adds the agent and model.

Uptime (outcome 3) and "nothing reached prod without approval" (outcome 4) are already observable,
through keepalive issues and the promote workflow history.

## Decisions for you

1. **Where the project wiki lives.** The plan puts it in the wrapper, with a pointer from each tool
   repo. The alternative is to put intent and decisions in the tool repo, where they travel with
   the code. That splits the wiki in two.
2. **The agent's power over promotion.** The plan treats promotion as human-only, enforced by
   mechanism in Phase 4. Alternatives are a per-project opt-in to autonomous promotion when beta is
   green, or that only for low-stakes lanes such as the blog.
3. **Infisical or GitHub-only for secrets.** This was open in design §10. The plan's default is
   Infisical, with GitHub-only as the no-new-account fallback.
4. **Whether the `package` lane joins this plan** or stays a later aim.
