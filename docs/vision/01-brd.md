# 01 — Business requirements

## 1. Problem

Greenlight exists because two real projects kept dying unattended. BAMCP ran on an OCI free-tier
container that Oracle reclaims when idle. HeistMind ran on a Supabase database that pauses after a
week without activity. Greenlight made both stay alive, and it made their deploys declarative and
verified. Six projects now run on it:

- the blog, astro/workers;
- HeistMind, next/vercel/supabase;
- BAMCP, mcp/oci;
- Tracer, next/vercel/neon;
- Muse, agent/workers/kv;
- Polyphony, a container on the oci path with a Neon database.

Running them for a year exposed three gaps that the current framework does not close.

**Knowledge does not survive the session that produced it.** Most changes to these projects are
made by a coding agent in a chat session. The agent learns what the project is for, which checks
matter and why a strange-looking choice was made, and that knowledge disappears when the session
ends. What survives is scattered:

- BAMCP's verify config opens with a forty-line comment that explains each check.
- Polyphony's manifest entry carries a paragraph justifying a lane choice that looks wrong without
  it.
- The full account of why HeistMind's keepalive failed exists only as a blog post and two GitHub
  issues (wrapper #55 and #86).

The next agent to touch a project starts nearly from scratch and has to rediscover the reasoning.

**Lessons are learned once, then relearned.** The keepalive was green while HeistMind's database
paused, because the probe hit PostgREST's schema cache instead of Postgres. Polyphony's health
check kept a Neon database awake around the clock, which consumed the free compute allowance. Both
failures belong to the same class: a check that measured something next to the thing at risk. The
framework fixed each instance as mechanism, in the form of a required probe table, SHA gating and
strict specs. No step, however, carries the lesson to the next project or to the skills agents
follow. The deploy-verify-promote skill has a version number stamped on every stage event
(`packages/loop/src/ship.ts`, `StageEvent.skillVersion`) so that skill changes could be compared
against gate outcomes, but nothing reads that data back.

**Starting a new project still takes expertise.** A newcomer with free accounts cannot yet describe
an app and get a running, verified, kept-alive project. They have to choose a lane, target and data
store without knowing the free-tier consequences, and they need a domain, which is the one paid
item on the default path because `domain` is required in `packages/shared/src/schema.ts`. They have
to write verify specs by hand. They also have no view across the portfolio of what is waiting in
beta, what is consuming shared quota, or what has been abandoned.

## 2. Vision

Greenlight manages a portfolio of projects for one owner:

- It keeps every project alive on free tiers.
- It lets a coding agent edit any project safely, whether or not that agent built it. Claude Code
  is the first target, and Codex is a stretch goal.
- It verifies every change in beta against the artifact that is actually deployed.
- It leaves every release decision with the owner.

This stage adds vibe coding. The owner describes an app, and the agent builds it on the free-tier
accounts the owner has already set up and brings it into the portfolio on the same terms as
everything else. It also adds a knowledge system that every managed skill uses, including the
deploy-verify-promote loop. Skills read from a wiki at defined moments, write evidence back after
every gate, and improve only through measured, gated changes.

## 3. Personas

| persona | who | what they need from Greenlight | what they must never experience |
|---|---|---|---|
| **Owner (operator)** | The single person who owns the wrapper repo and the provider accounts. Today this is the maintainer of `RTrentJones.dev`. | A view of every project's state; control over every production change; confidence that idle projects stay up and do not exhaust shared quotas. | A production change they did not approve; a project dying silently; a leaked token. |
| **Vibe coder** | Someone with a GitHub account and a few free provider accounts, who can describe what they want but does not know Terraform, wrangler or verify specs. Often the same person as the owner, wearing a different hat. | To go from a sentence to a working beta URL; to correct the app in plain language; to know what each choice costs on their free tiers. | Being asked to paste a token into chat, read YAML, or buy a domain before anything works. |
| **Coding agent** | Claude Code first; Codex later; a fresh session with no memory of past work. It is a user of the CLI, the skills and the wiki. | To find out quickly what a project is for, how it stays alive and what has gone wrong before; objective pass/fail signals; credentials that work without being handed raw secrets. | Ambiguous instructions; checks that pass for the wrong reason; guidance that contradicts the installed version. |
| **Reviewer / contributor** | A human reviewing a PR to the framework, or another Greenlight user contributing a pattern. | Evidence behind each proposed change; a clear statement of what a skill change was measured against. | Unreviewable bulk changes; contributions that smuggle instructions into other people's agents. |

## 4. Business goals and outcomes

Every capability in this pack serves at least one of four outcomes. Work that serves none is out
of scope.

| goal | outcome | evidence that it has been met |
|---|---|---|
| **G1 Start** | A new project starts easily on the accounts the owner already has. | The idea-to-beta drill (13 §3, M4) passes for a newcomer with no domain. |
| **G2 Edit** | An agent that has never seen a project can change it safely. | The cold-edit drill (13 §3, M3) passes, and the cold-edit first-pass rate meets its target. |
| **G3 Stay alive** | Every project stays alive unattended, and no project starves the others of free-tier quota. | Keepalive and liveness doctor rules pass for every tool; no quota exceeds 80% without a warning having been raised. |
| **G4 Release** | Release stays in human hands, and the owner can see what is waiting. | Every production mutation, through every channel in 18, traces to an owner approval artifact for its tool and sha; `portfolio` shows beta-ahead-of-prod for every tool. |
| **G5 Learn** | Each failure becomes durable knowledge that reaches the skills and checks that would have prevented it. | WikiSkill iterations complete with reviewed ledger rows from M2 onward; the gate rejects plausible but wrong lessons (the control arm); every confirmed incident has a confirmed pattern with a verified remediation; replay tasks pass. |

G5 is the enabling goal, and its method drives the others. The WikiSkill cycle (06 §0, ADR-14) runs
from M2 onward, and later work on G1–G4 enters through it. G2 and G3 degrade over time without it.

## 5. Success metrics

No metric counts accepted proposals. A cycle that rejects a wrong change, or finds nothing worth
changing, has done its job. A target that rewarded acceptances would reward manufactured
improvements (ADR-14).

| metric | definition | target | how measured | from |
|---|---|---|---|---|
| **Completed iterations** | WikiSkill iterations that reach a human-reviewed ledger event (`candidate-accepted`, `candidate-rejected` or `no-action`) with a reproducible evaluation record | ≥ 1 per month once M2 ships; every iteration's decision reproduces with `bench gate --recompute` | Ledger events plus `EvaluationRecord` hashes (08 §10.4) | M2 |
| **Discrimination** | Share of control proposals (deliberately wrong, labelled `control`) that the evaluator rejects | 100% | Ledger events with `control: true` | M2 |
| **Cost per iteration** | LLM spend of one full iteration (train refresh, maintainer, proposer, evaluation) | Reported every iteration, and within `perGateMaxUsd` | Ledger `spend` events | M2 |
| **Idea to beta** | Wall-clock time from the owner's first sentence to a green beta `ship` on a fresh free-tier account with no domain | ≤ 60 minutes median over three drills, of which ≤ 10 minutes is human input | Drill log timestamps; the first `ship` StageEvent with `env: beta, passed: true` | M4 |
| **Cold-edit first-pass rate** | Share of changes by a session that did not create the project where the first `preview` after the change passes | ≥ 70% over a rolling 20 changes | `preview` raw records joined on change identity (08 §5); a cold session is one with no earlier raw record for that tool | M3 (manual), M6 (automated) |
| **Unattended uptime** | Share of keepalive sweeps per tool that pass, over 90 days | ≥ 99% per tool, excluding provider-wide outages | Keepalive raw records (`kind: keepalive`) or the keepalive Worker's issue history | ongoing |
| **No unapproved prod change** | Production mutations, on any channel in the release authorization matrix (18), without an owner approval artifact for that tool and sha | 0 | Protected-job history joined to approval artifacts; provider deployment logs | M5 |
| **Lesson capture** | Share of closed incidents with a confirmed pattern and a verified remediation within 14 days of closure | ≥ 90% | `wiki lint` plus incident `closed` and pattern `status` dates | M3 |
| **Skill change discipline** | Share of `version:` bumps on managed skills backed by a `candidate-accepted` then `merged` event, or by the temporary human-reviewed path before a skill has a bench slice | 100% | LR-14 plus a CI check comparing SKILL.md versions against the ledger | M1 |
| **Free-tier fidelity** | Share of `fact` pages with `verified` ≤ 90 days old | ≥ 90% | LR-17 | M3 |

### 6.1 In scope

- The framework wiki and the project wiki, with schemas, lint, versioning and seed content
  (04, 15).
- The managed-skill model applied to every skill Greenlight ships (05). This covers
  deploy-verify-promote, the nine provider skills, and the new kickoff, build, wiki and portfolio
  skills.
- The self-verifying-app contract, built into all lane templates and enforced by doctor (09).
- The vibe-code flow: `accounts`, no-domain mode, the kickoff and build skills (02, 07).
- Portfolio operations: `portfolio`, `retire`, quota headroom (10).
- Centralized secrets, with Infisical as the default, a GitHub-only fallback and a credential proxy
  for agents (11).
- The WikiSkill cycle: training rollouts, maintainer, proposer, outlet-specific evaluation, ledger
  and human review (06). It is the first working milestone (M2), and it drives the rest.
- Raw evidence capture and `wiki lookup` (06, 03).
- Release authority over every production-mutation channel (18).
- Codex parity, as a stretch milestone (M7).

### 6.2 Out of scope

- A hosted Greenlight service, dashboard or control plane. This would contradict clone-and-own, and
  Tracer remains an optional, self-run component.
- The `package` lane for CLIs and libraries. The schemas reserve `kind: 'package'`, but the lane
  itself is deferred (ADR-13).
- A CI provider other than GitHub Actions.
- Automatic merging of skill or framework changes into a published release. The gate accepts
  changes into a release candidate, and a human cuts the release.
- Online learning inside a user's session. The evolution loop runs offline and in batches.
- Multi-owner or team tenancy within one wrapper.

## 7. Constraints

| id | constraint | consequence |
|---|---|---|
| K-1 | **Free-tier-first.** The default path costs nothing. | No-domain mode is required; paid providers are opt-in; bench scoring runs locally with no cloud spend. |
| K-2 | **Clone-and-own.** Everything is files in repos the owner controls. | The wikis are git-tracked markdown; no hosted store is required. |
| K-3 | **GitHub-centric.** GitHub Actions is the only CI. | Approval and promotion ride protected workflows; Infisical syncs to Actions secrets rather than replacing them in CI. |
| K-8 | **GitHub plan features vary by repository visibility.** Environment protection rules (required reviewers) and branch protection are not available for private repositories on every plan. | The free path cannot assume them. Release authority (18) relies on an owner approval artifact checked by the protected job, which works on any plan. Environment reviewers and branch protection are used as additional backstops where the plan provides them, and `doctor` reports which ones are actually configured on the remote. |
| K-4 | **Solo operator.** One person reviews everything. | Human review load must be bounded: the proposer makes one atomic change at a time, and the ledger is the review queue. |
| K-5 | **Lockstep versioning.** The npm version equals `MODULE_REF`. | The framework wiki and skills ship in the same package at the same version (ADR-04). |
| K-6 | **No personal data in framework files** (`check-seam`). | Framework wiki pages pass the seam check (LR-19); project specifics stay in the wrapper. |
| K-7 | **Existing interfaces stay compatible.** | `StageEvent.skillVersion` is kept, the new manifest fields are optional for existing tools, and verify specs without `id` keep working. |

## 8. Assumptions

- The owner has, or will create, free accounts on GitHub, Cloudflare and HCP Terraform, plus the
  providers for the cells they use.
- Claude Code supports repo-scoped skills in `.claude/skills`, plugins and `CLAUDE.md`, as it does
  today.
- Provider APIs exposing usage remain available on free tiers for at least Cloudflare and Neon.
  Where they are not, headroom is reported as unknown rather than guessed.
- Infisical's free cloud tier or its self-hosted edition can serve as the secret source. Whether
  Agent Proxy is included on the free cloud tier was unconfirmed when this was written, and the
  Cloudflare Worker proxy is the fallback (11).
- LLM token cost for the evolution loop is affordable at the scale described in 06 §5.5 when it is
  run on demand.

## 9. Dependencies

| dependency | used for | if unavailable |
|---|---|---|
| Cloudflare (Workers, D1, KV, DNS) | default runtime, keepalive host, optional proxy | no workers cells; the blog cannot run |
| GitHub Actions | CI, secrets fallback, approvals | no deploys (K-3) |
| HCP Terraform | remote state | infra apply blocked |
| Infisical | secret source and agent proxy | GitHub-only fallback; agents get no authenticated calls outside CI |
| Tracer | runtime store for raw evidence and dashboards | `.greenlight/raw/` fallback (ADR-08) |
| An LLM API (Claude) | `eval`, `agent-web`, maintainer, proposer, bench rollouts | evolution loop and LLM verify modes degrade to failing checks, as they do today |

## 10. Risks

| id | risk | likelihood | impact | mitigation |
|---|---|---|---|---|
| R-1 | A token leaks through raw evidence or wiki text | medium | high | Agents hold placeholders only (11); redaction at capture; LR-20; planted-secret test as a merge blocker (13 §2.6) |
| R-2 | A contributed pattern injects instructions into other users' agents | medium | high | Reviewed PRs only; `hypothesis` pages are never surfaced; patterns are data to the proposer (12 T-04) |
| R-3 | An agent changes production without approval, through promotion or another channel | medium | high | Release authorization matrix over every channel (18, ADR-15); agents hold beta-scoped capabilities only; DR-32, DR-34–DR-36 |
| R-4 | A skill change helps one model and harms another | medium | medium | Two-model gate under one policy table, safety before efficacy (ADR-11) |
| R-5 | A bench grader passes for the wrong reason | medium | medium | Mutation checks for every grader (06 §4.3) |
| R-6 | Free-tier facts go stale | high | medium | `verified` dates, LR-17, refresh procedure |
| R-7 | Evolution loop cost exceeds its value | medium | medium | Start small (M1–M2: a handful of local, credential-free tasks); per-gate caps; cost reported per iteration; scale only after the cycle shows discrimination (M6) |
| R-11 | The cycle is pushed to manufacture improvements | medium | medium | No metric or exit criterion requires an acceptance (ADR-14); control arms; rejection history read first |
| R-8 | The wiki becomes a fifth copy of the docs and drifts | medium | medium | One home per statement (04 §7); footgun sections shrink to links |
| R-9 | Vibe-coded projects accumulate and exhaust shared quota | high | medium | Headroom warnings, `retire`, DR-27 |
| R-10 | The loop skill regresses and every project's delivery degrades | low | high | Highest blast radius: full replay suite plus human release (ADR-12) |

## 11. Business requirements

| id | requirement | rationale | goal | FR areas |
|---|---|---|---|---|
| BR-01 | Every project in the portfolio MUST carry a durable, machine-checkable record of its purpose, acceptance criteria, liveness model and decisions. | Session knowledge is currently lost. | G2 | WIKI, LOOP |
| BR-02 | Every acceptance criterion MUST map to at least one verify check. | Unrecorded intent cannot be enforced, and unexplained checks cannot be safely changed. | G2, G1 | WIKI, BUILD |
| BR-03 | A newcomer MUST be able to go from an idea to a verified beta deployment using only free accounts, with no domain. | A domain is currently the one paid item on the default path. | G1 | KICK |
| BR-04 | The system MUST propose only stacks the owner has the accounts for, and MUST state the free-tier consequences before scaffolding. | Choosing a cell currently requires expertise. | G1, G3 | KICK, PORT |
| BR-05 | Every new project MUST meet the self-verifying-app contract from its first preview. | Most incidents came from checks that could not distinguish working from broken. | G2, G3 | BUILD |
| BR-06 | Every project MUST declare how it stays alive, and the system MUST refuse configurations that contradict the declaration. | Supabase needs traffic, Neon needs silence, OCI needs healing; both directions have failed. | G3 | PORT, BUILD |
| BR-07 | The owner MUST see, across all projects, what is verified in beta and waiting for release, what is failing, and how much shared quota remains. | There is currently no portfolio view. | G4, G3 | PORT |
| BR-08 | No production change MUST happen without the owner's approval, through any channel, except where the owner has approved a policy opting a low-stakes project into autonomous release. | Release control is the owner's, and promotion is only one of several production channels. | G4 | LOOP, SEC |
| BR-09 | Abandoned projects MUST be retirable through a guarded lifecycle that deletes exactly the authorized resources and tracks every resource until it is confirmed gone. | Cheap project creation makes dead projects accumulate. | G3 | PORT |
| BR-10 | Coding agents MUST be able to make authenticated calls they need without ever holding raw credentials, and all secrets MUST have one readable source. | GitHub Actions secrets cannot be read outside CI, so tokens get pasted into sessions. | G2 | SEC |
| BR-11 | Every managed skill, including the deploy-verify-promote loop, MUST record which wiki evidence justifies each of its rules. | Rules without reasons are relitigated or silently dropped. | G5, G2 | SKILL, WIKI |
| BR-12 | Every gate run MUST leave durable evidence attributable to the tool, commit, skill versions and agent. | Skill quality cannot be measured without it. | G5 | LOOP, WIKI |
| BR-13 | Each failure MUST be compiled into a pattern and routed to the strongest available remedy: mechanism before doctor rule, before template, before verify check, before skill text. | History shows code-enforced lessons persist and prose lessons do not (ADR-01). | G5 | WIKI, EVO |
| BR-14 | Every change MUST be accepted only on evidence suited to its outlet. A skill change needs controlled rollouts showing no regression of known incidents and improved capability on more than one model. A framework fix needs a reproduction that fails before it and passes after it. | Skill text changes can harm other models (paper: 50.5 → 18.1), and a framework fix should not need an unrelated capability gain. | G5 | EVO |
| BR-18 | Improvements MUST be driven by the WikiSkill cycle from the first working milestone, and a justified rejection or no-action MUST count as a successful iteration. | Building features first and evolving later leaves the method unproven while most of the work is done. | G5 | EVO, WIKI |
| BR-15 | Knowledge shipped by the framework MUST match the installed framework version. | The 0.x caret trap left HeistMind running guidance for a version it did not have. | G2 | WIKI, SKILL |
| BR-16 | The system SHOULD be operable by Codex as well as Claude Code. | The owner uses more than one agent; this is a stretch goal (ADR-02). | G2 | AGENT |
| BR-17 | Contributions from other users MUST be reviewable and MUST NOT reach other users' agents without review and evidence. | The wiki is a channel into other people's agents. | G5 | WIKI, SEC |
