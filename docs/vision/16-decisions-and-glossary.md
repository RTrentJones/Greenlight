# 16 — Decisions, open questions and glossary

## 1. Decision records

Each record follows one form: context, decision, consequences, alternatives considered, and status.
The possible statuses are **Accepted**, **Proposed** (awaiting the owner) and **Superseded**.

### ADR-01 — Outlet ranking: mechanism over instruction

- **Context.** WikiSkill turns every learned pattern into skill text. Greenlight's own history runs
  the other way. Its durable fixes were mechanisms:
  - strict verify specs;
  - SHA-gated verify;
  - the destroy guard in `infra.yml`;
  - `exactTools`;
  - the required `probeTable`.

  Lessons that lived only as prose were the ones that recurred.
- **Decision.** A pattern is remediated through the strongest outlet that can express it. The
  outlets, in order, are: framework mechanism, `doctor` rule, template default, verify assertion,
  skill text. The proposer must say why it did not use a stronger outlet. LR-18 flags a
  mechanism-class pattern whose only remediation is skill text.
- **Consequences.**
  - The automated gate covers only skill text and template edits.
  - The other outlets go through human-reviewed PRs, opened as issues by the proposer.
  - The ledger gains an `outlet` column.
  - Evolution is slower to "complete", and its results last longer.
- **Alternatives considered.** Skill text only, as in the paper: rejected on the evidence above.
  Mechanisms only: rejected, because some rules, such as the "idle cost is zero" design guidance,
  cannot be mechanized.
- **Status.** Accepted.

### ADR-02 — Claude Code first, Codex as a stretch

- **Context.** The vision names both Claude and Codex. Supporting both from the start would double
  the skill-distribution work before the core exists. Codex reads `AGENTS.md` and repo skills in
  `.agents/skills`, using the same SKILL.md standard.
- **Decision.** Phases P0 to P6 target Claude Code. Codex parity is P7, a stretch goal. From P0 on,
  three constraints apply (FR-AGENT-01):
  - skills use only portable frontmatter (`name`, `description`, `version`);
  - every query an agent needs is a CLI command;
  - gates live in CI and the CLI, not in agent behavior.
- **Consequences.** P7 is mostly copying files plus a sync guard. Skills cannot use Claude-only
  features to do load-bearing work.
- **Alternatives considered.** Both agents from P0: rejected on cost. Claude-only with no
  constraints: rejected, because retrofitting portability later means rewriting the skills.
- **Status.** Accepted.

### ADR-03 — The project wiki lives in the wrapper

- **Context.** An adopted tool's code is in its own repo (a submodule), while its verify config and
  infra are in the wrapper. Intent and liveness could live in either place.
- **Decision.** `wiki/` lives in the wrapper, with `wiki/tools/<name>/` for each tool. `agent sync`
  and `adopt` write a pointer block into the tool repo's `CLAUDE.md`, and into `AGENTS.md` once P7
  lands.
- **Consequences.**
  - There is one home per portfolio.
  - `portfolio`, `doctor` and the wiki read everything locally.
  - An agent opened only on a tool repo must follow the pointer.
- **Alternatives considered.** Putting the wiki in each tool repo, so intent travels with the code:
  rejected because it splits the wiki per tool and breaks portfolio queries. A split, with intent
  in the tool repo and liveness in the wrapper: rejected as confusing.
- **Status.** Proposed. This is open question Q1, and the recommended answer is as decided.

### ADR-04 — The framework wiki and skills version in lockstep with the CLI

- **Context.** The plugin is at `0.1.0` while the CLI is at `0.10.1`, so skills already drift from
  the mechanics they describe. Pattern `applies` ranges need a known installed version to be
  evaluated against.
- **Decision.** The framework wiki and skills ship inside the npm package, are copied by
  `copy-assets.mjs`, and are materialized by `agent sync`. The plugin's version tracks the CLI's.
  DR-12 and DR-13 flag drift.
- **Consequences.** A wiki-only fix requires a CLI patch release. This is the same trade-off as
  lockstep `MODULE_REF`, described under "Trade-offs & deliberate constraints" in
  `docs/architecture.md`.
- **Alternatives considered.** An independent plugin channel with advisory `applies`: rejected,
  because stale consumers would read patterns about versions they do not run.
- **Status.** Accepted.

### ADR-05 — Field data monitors; the bench gates

- **Context.** Stage events already record skill versions. Using first-pass rates as the gate for
  skill changes looks attractive, but it has three problems:
  - tasks differ in difficulty;
  - samples are small;
  - exposure is the very risk being gated.
- **Decision.** Field metrics (first-pass rate, rollback rate and settle retries per skill version)
  raise alarms and seed maintainer passes. Only the bench decides whether a skill change is
  accepted.
- **Consequences.** The bench must exist (P6) before any automated skill change. Until then, skill
  changes are human PRs.
- **Alternatives considered.** Field gating with canary skill versions: rejected, because one
  operator does not produce enough runs to detect differences.
- **Status.** Accepted.

### ADR-06 — Infisical as the default secret source, with a GitHub-only fallback

- **Context.** GitHub Actions secrets cannot be read from outside a workflow, so agent-side steps
  have no sanctioned credential source. The vision means many agents on many machines, and readers
  of untrusted text.
- **Decision.**
  - Infisical, open source and self-hostable, is the single readable source.
  - It syncs to GitHub Actions secrets, so CI is unchanged.
  - Terraform still projects values to runtime stores.
  - Agents run behind a credential-injecting proxy: Infisical Agent Proxy, or the Greenlight
    Worker proxy.
  - `--sink github` keeps the current model for owners who want no new account.
- **Consequences.**
  - There is a new optional dependency and a new trust surface, the proxy.
  - OCI request-signing keys and SSH keys remain CI-only.
  - The provider registry gains `inject`.
- **Alternatives considered.**
  - Doppler, Bitwarden Secrets Manager and 1Password: none offers an injecting proxy, and
    1Password has no free plan.
  - Vault or OpenBao: too heavy for one person.
  - The status quo: leaves agents pasting tokens.
- **Status.** Proposed. It depends on Q3 (Infisical free-tier coverage of Agent Proxy).

### ADR-07 — Promotion is human by default; auto-on-green only for low-stakes tools

- **Context.** The vision says the owner controls release. Some tools, such as a content blog, do
  not justify a manual click.
- **Decision.**
  - `promotion` defaults to `human`.
  - `auto-on-green` is allowed only for tools with `access: public` and `data` of `none`, `d1` or
    `kv`. The schema enforces this.
  - For `human` tools, the `promote.yml` dispatch requires an environment approval.
  - The proxy denies the agent the dispatch call (DR-32).
- **Consequences.** Release control is a mechanism, not a skill instruction. Auto-promotion cannot
  reach tools with user data or auth.
- **Alternatives considered.** Human-only with no opt-in: acceptable, but it adds friction for the
  blog. A per-tool opt-in with no restriction: rejected, because it would let a misconfiguration
  auto-ship a database-backed app.
- **Status.** Proposed. This is Q2.

### ADR-08 — The raw store holds references; Tracer is optional

- **Context.** Evidence lives in GitHub and Tracer and spans weeks. Copying full logs would
  duplicate data and multiply the risk of leaking secrets.
- **Decision.** Raw records hold pinned references and a redacted excerpt of at most 15,000
  characters. When Tracer is configured, stage events and records flow to it as well. Nothing
  requires Tracer.
- **Consequences.** Evidence resolution depends on GitHub retention. CI logs expire, so excerpts
  carry the essential lines.
- **Alternatives considered.** A full-trace store, as in the paper: rejected for size and secret
  risk. Tracer as required: rejected, because it would break clone-and-own for adopters without it.
- **Status.** Accepted.

### ADR-09 — No-domain mode through workers.dev and vercel.app

- **Context.** `domain` is required today, and a domain is the one paid item on the default path.
- **Decision.** `domain` becomes optional. Without it, workers tools resolve to
  `<name>.<sub>.workers.dev`, with beta as a separate `<name>-beta` Worker. Vercel tools use
  adapter-supplied aliases. oci and docker require a domain.
- **Consequences.**
  - Cloudflare Access cannot protect workers.dev beta URLs, so beta in no-domain mode is public.
    Kickoff states this.
  - A domain can be added later through a migration documented in 10.
- **Alternatives considered.** Requiring a domain: rejected, because the free-tier promise would be
  false.
- **Status.** Accepted.

### ADR-10 — Incidents are hidden from building agents; lookup surfaces only confirmed patterns after a failure

- **Context.** The paper's ablation found that giving the inference agent wiki access lowered
  scores. Incidents are long narratives, and hypotheses may be wrong.
- **Decision.**
  - Building agents read `intent`, `liveness`, `decision`, `fact` and `contract` pages at start.
  - They receive `confirmed` patterns only through `wiki lookup`, after a gate fails.
  - They never receive incidents.
  - Bench rollouts get no lookup.
- **Consequences.** P6 measures whether lookup helps, using the val split with lookup on and off,
  and removes it if it does not.
- **Alternatives considered.** Full wiki access: rejected on the paper's evidence. No access:
  rejected, because intent and liveness are required for safe cold edits.
- **Status.** Accepted.

### ADR-11 — Lexicographic gate across two models

- **Context.** The paper accepts a change on strict improvement in average validation score. An
  average can rise while a known incident comes back. Skills also transfer negatively across models
  (50.5 → 18.1).
- **Decision.** A proposal is accepted only if all three hold:
  1. it causes no regression on any replay task that passed before, which is a hard constraint;
  2. it strictly improves the capability score on the val split, using a paired bootstrap with
     1,000 resamples and p < 0.05, over three runs;
  3. both conditions hold for both gate models, a frontier model and a small one.
- **Consequences.**
  - Each proposal costs more rollouts.
  - Neutral proposals are rejected, as the paper notes.
  - An optional tie-breaker accepts a non-regressing proposal that shortens a skill. It is disabled
    by default.
- **Alternatives considered.** Paper-strict on one model: rejected for the reasons above.
- **Status.** Accepted.

### ADR-12 — The loop skill is managed under the same gate, at the highest blast radius

- **Context.** `deploy-verify-promote` drives every ship. A bad edit to it affects every tool.
  Exempting it from evolution would freeze the most important skill. Treating it like any other
  skill would underweight the risk.
- **Decision.**
  - The loop skill is a managed skill with `blast-radius: high`.
  - Proposals against it run the full val split and every replay task, and require
    `pending-human` approval after the gate accepts.
  - Its hooks (`on-start`, `on-failure`, `on-complete`, `on-incident`) make it the main producer of
    raw evidence and the main consumer of project wikis.
- **Consequences.** The loop skill improves on evidence, but more slowly than other skills.
- **Alternatives considered.** Exempting the loop skill: rejected, since it is where most lessons
  apply.
- **Status.** Accepted.

### ADR-13 — The package lane is deferred; the `kind` field is reserved

- **Context.** "Other software" includes CLIs and libraries, which have no hosting. Their loop
  would be: beta as a prerelease dist-tag, verify by installing and running, promote by moving the
  `latest` tag.
- **Decision.** The lane is not built in P0 to P7. The manifest reserves `kind: 'package'`, and the
  app contract and wiki schemas avoid assuming HTTP where they can.
- **Consequences.** A later phase can add the lane without a schema redesign.
- **Alternatives considered.** Building it in P2: rejected, because it would dilute the core
  vibe-code flow.
- **Status.** Accepted.

## 2. Open questions

| id | question | recommended answer | decides |
|---|---|---|---|
| Q1 | Where does the project wiki live? | the wrapper, with pointers in tool repos (ADR-03) | P0 layout |
| Q2 | Is promotion strictly human, or opt-in automatic for low-stakes tools? | human by default; `auto-on-green` only for public tools with no store or a non-pausing store (ADR-07) | P2 schema, P4 guard |
| Q3 | Hosted or self-hosted Infisical, and is Agent Proxy on the free tier? | check at the start of P4; if it is not free, default to the Worker proxy and keep Infisical as the source only | P4 |
| Q4 | Which two models form the gate pair, and what is the monthly rollout budget? | one current frontier model and one small or cheap model; cap with `BENCH_MAX_ROLLOUTS` (start at 300 per month) | P6 cost |
| Q5 | Does Tracer become required? | no; it stays optional (ADR-08) | P5 |
| Q6 | Who writes replay graders? | a human writes the first grader for each pattern class; the maintainer may propose graders for later instances, subject to the mutation check | P6 |
| Q7 | Do template edits go through the automated gate? | yes for evidence, with a human merge | P6 |
| Q8 | Does the package lane join this plan? | no; it is reserved (ADR-13) | later |

## 3. Glossary

**Accounts report.** The output of `greenlight accounts`. It says which providers are configured and
verified, their quota usage and headroom, and which cells can be deployed now (08 §11.1).

**Adopted tool.** An existing project brought under Greenlight by `greenlight adopt` without
rewriting its code. Its code lives in a tool repo mounted as a submodule.

**App contract.** The seven clauses, C1 to C7, that make an app self-verifying (09):

- **C1** identity;
- **C2** liveness versus readiness;
- **C3** guarded writes;
- **C4** freshness per producer;
- **C5** recorded success;
- **C6** zero idle cost;
- **C7** marking of environment-invariant checks.

**Applies range.** A semver range on a pattern giving the Greenlight versions where the pattern is
relevant.

**Bench.** The evaluation suite in `bench/`, made of capability briefs and replay tasks. It is used
only to gate skill changes.

**Blast radius.** A `PURPOSE.md` field (`low`, `medium` or `high`) that sets how strict the gate is
for a skill.

**Capability brief.** A bench task of the form "build X on cell Y", graded by a hidden verify config.

**Catches.** A pattern's distinguishing check: the assertion that tells the at-risk state apart
from what a faulty check actually probed.

**Cell.** One combination of lane, target and data, written `lane/target/data`, for example
`astro/workers/d1`.

**Cold edit.** A change made by an agent to a project it did not create, with no context beyond the
repo and its wiki.

**Confirmed.** A pattern status that requires evidence, a `catches`, and a remediation verified
red-to-green.

**Credential proxy.** An HTTP proxy that swaps placeholder credentials for real ones on outbound
requests to allow-listed hosts and routes (11).

**Doctor rule (`DR-*`).** A consistency check run by `greenlight doctor`.

**Evolution loop.** The maintain → propose → gate → ledger cycle that improves skills (06). It is
distinct from the loop.

**EvidenceRef.** A typed pointer to durable evidence, such as `issue:`, `pr:`, `commit:`, `run:`,
`raw:`, `tracer:` or `post:` (08 §3.1).

**Fact page.** A wiki page describing one provider tier's properties and quotas, with a verified-on
date.

**Fidelity.** Whether a bench task is graded on live behavior (`runtime`) or on artifacts
(`structural`).

**Framework repo.** `RTrentJones/greenlight`, which holds the CLI, packages, Terraform modules,
skills and framework wiki.

**Framework wiki.** `wiki/` in the framework repo, shipped with the CLI.

**Gate.** The acceptance test for a skill proposal: no replay regression, then strict capability
improvement, on two models.

**Headroom.** The share of a free-tier quota still unused across the whole portfolio.

**Hook.** A defined point at which a managed skill reads or writes the wiki: `on-start`,
`on-failure`, `on-complete` or `on-incident` (05 §3).

**Incident.** A timeline page that links evidence for a failure that unfolded over time. It is
never shown to building agents.

**Inject spec.** A provider-registry declaration of how the proxy attaches a token: hosts, header,
scheme, allow-list and scrub rules.

**Intent.** A tool's purpose and its acceptance criteria in the owner's words, each mapped to verify
check ids.

**Lane.** What a tool is: `astro`, `next`, `mcp`, `agent`, and in future `package`.

**Ledger.** `wiki/ledger.jsonl`, the harness-written record of every proposal and remediation,
rendered to `skill-impact.md`.

**Lexicographic gate.** A gate that checks a hard constraint before an improvement criterion.

**Lint rule (`LR-*`).** A check run by `greenlight wiki lint`.

**Liveness model.** What idleness does to a tool's weakest dependency: `needs-traffic`,
`needs-silence`, `needs-heal` or `always-on`.

**Loop, the.** The deploy-verify-promote delivery loop: local gate, then verify config, push, ship,
promote. The skill `deploy-verify-promote` carries it.

**Maintainer.** The role, played by an agent following the `greenlight-wiki` skill, that compiles
raw evidence into wiki edits.

**Managed skill.** Any skill under Greenlight's skill system, with a `SKILL.md`, a `PURPOSE.md`, a
version, hooks, a bench slice and ledger rows. Every skill is managed, the loop skill included.

**Mutant.** A known-bad implementation that a grader must fail.

**No-domain mode.** Running without a custom domain, on workers.dev and vercel.app URLs.

**Outlet.** Where a pattern's remediation goes. In ranked order: mechanism, doctor, template,
verify, skill.

**Pattern.** A short wiki page describing one failure mode or strategy, with root cause, fix, and
how it is caught.

**Portfolio.** All the tools in one wrapper's manifest, together with the free-tier accounts they
share.

**Project wiki.** `wiki/` in a wrapper, holding per-tool intent, liveness and decisions, plus
project patterns and incidents.

**Promotion policy.** `human` or `auto-on-green`; who may release beta to prod.

**Proposer.** The role that reads the wiki and ledger and proposes one remediation per iteration.

**Proxy check.** A check that measures something next to the thing at risk, so that it passes while
the thing fails. This is the dominant failure class in Greenlight's history.

**PURPOSE.md.** A skill's sidecar file. It maps the skill's rules to the wiki pages that justify
them and carries the skill's management metadata.

**Raw record.** An immutable, redacted record of one run, with durable references (08 §5).

**Replay task.** A bench task that reproduces a confirmed failure pattern. A proposal that makes a
previously passing replay task fail is rejected.

**Retire.** The command that removes a tool from the portfolio, archives its wiki, and lets guarded
infra apply destroy its resources.

**Settle loop.** Verify's retry window for eventually consistent deploys. Without SHA gating, it can
green-light the previous artifact.

**SHA gating.** Verify asserting that the deployed `/__version` equals the commit being shipped.

**Ship.** One loop turn for one environment: build, deploy, SHA-gated verify, and rollback on
failure.

**Stage event.** A JSON event emitted for each ship or preview stage (08 §7).

**Target.** Where a tool runs: `workers`, `vercel`, `oci` or `docker`.

**Tool repo.** An adopted project's own repository.

**Vibe coding.** Building software by describing it to an agent. In Greenlight, the agent writes
the intent and checks, and the gates hold it to them.

**Wrapper.** A consumer repo scaffolded by `greenlight init`. It holds the manifest, infra, verify
configs, the project wiki and content.
