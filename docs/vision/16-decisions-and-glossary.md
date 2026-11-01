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
- **Decision.** Milestones M0 to M6 target Claude Code. Codex parity is M7, a stretch goal. From
  M0 on, three constraints apply (FR-AGENT-01):
  - skills use only portable frontmatter (`name`, `description`, `version`);
  - every query an agent needs is a CLI command;
  - gates live in CI and the CLI, not in agent behavior.
- **Consequences.** M7 is mostly copying files plus a sync guard. Skills cannot use Claude-only
  features to do load-bearing work.
- **Alternatives considered.** Both agents from M0: rejected on cost. Claude-only with no
  constraints: rejected, because retrofitting portability later means rewriting the skills.
- **Status.** Accepted.

### ADR-03 — The project wiki lives in the wrapper

- **Context.** An adopted tool's code is in its own repo (a submodule), while its verify config and
  infra are in the wrapper. Intent and liveness could live in either place.
- **Decision.** `wiki/` lives in the wrapper, with `wiki/tools/<name>/` for each tool. `agent sync`
  and `adopt` write a pointer block into the tool repo's `CLAUDE.md`, and into `AGENTS.md` once M7
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
- **Consequences.** The bench exists from M1 and the first gated iteration runs in M2. Until a
  skill has an active bench slice, its changes go through the temporary human-reviewed path, which
  still writes a ledger event (FR-SKILL-03).
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
  - For `human` tools, every production channel requires an owner approval artifact bound to the
    tool and sha. This is enforced by the protected execution identity (ADR-15, 18).
  - **Amended.** Setting or changing `promotion` is itself a policy edit. It takes effect only
    after the owner has approved the commit that makes it, through the same protected path. An
    agent's commit that sets `auto-on-green` grants nothing (DR-32).
- **Consequences.** Release control is a mechanism, not a skill instruction. Auto-promotion cannot
  reach tools with user data or auth, and an agent cannot opt a tool into it.
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
  - Bench rollouts get no lookup (`GREENLIGHT_WIKI=off`).
- **Consequences.** Production-mode evaluation (06 §4.7, from M3) measures whether the hooks
  help. It runs the val split with hooks on against the isolation-mode result, and the hooks are
  removed if they do not help.
- **Alternatives considered.** Full wiki access: rejected on the paper's evidence. No access:
  rejected, because intent and liveness are required for safe cold edits.
- **Status.** Accepted.

### ADR-11 — One policy table: safety before efficacy, across two models and two modes

- **Context.** The paper accepts a change on strict improvement in average validation score. An
  average can rise while a known incident comes back. Skills also transfer negatively across models
  (50.5 → 18.1).
- **Decision (amended).** Skill and template candidates are judged by the single policy table in
  06 §5.4.
  - **Safety.** No baseline-passing replay task regresses, on **both** gate models and **both**
    evaluation modes, at every blast radius. High radius requires 3 of 3 runs and allows no flaky
    replay task in the baseline.
  - **Efficacy.** The capability score strictly improves in isolation mode, using a paired
    bootstrap with 1,000 resamples and p < 0.05 over three runs. Which models must improve
    depends on the blast radius.
  - **Production mode.** Must not regress.
  - **Two human-reviewed alternatives replace efficacy, never safety.** The *safety-fix* path
    covers replay-only fixes and security repairs. The *neutral-prerequisite* path covers changes
    that enable a later one.
  - **Release check.** A release carrying skill or template changes must pass the held-out test
    split against the previous release (06 §5.7).
  - **Scope.** Other outlets use their own acceptance rules (ADR-16).
- **Consequences.**
  - Each proposal costs more rollouts.
  - Replay-only fixes are no longer rejected for want of an unrelated capability gain.
  - Reusing the validation split makes p-values optimistic. The test-split release check and
    recomputable evaluation records (06 §5.8) compensate.
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
  - Proposals against it must pass every baseline-passing replay task 3 of 3, on both models and
    both modes, and must strictly improve capability on both models (06 §5.4).
  - Its bench slice includes `trajectory` tasks (06 §4.6). Its rules are about the order of
    preview, push, approval, deploy and verification, which a final-artifact grader cannot observe.
  - `candidate-accepted` is followed by a human merge and a release that passes the held-out test
    check. The ledger records each stage separately (06 §6.1).
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
- **Decision.** The lane is not built in M0 to M7. The manifest reserves `kind: 'package'`, and the
  app contract and wiki schemas avoid assuming HTTP where they can.
- **Consequences.** A later milestone can add the lane without a schema redesign.
- **Alternatives considered.** Building it alongside the first creation path (M4): rejected, because it would dilute the core
  vibe-code flow.
- **Status.** Accepted.

### ADR-14 — The WikiSkill cycle drives improvements from the first working milestone

- **Context.** The first roadmap ordered the full evolution cycle last (P6), after most of the
  improvements it was meant to select had already been designed and built. The method would have
  been unproven during most of the work. The exit criterion "≥1 accepted change" also rewarded
  manufacturing an improvement.
- **Decision.**
  - A small, complete cycle is the first working milestone (M2), preceded only by its contracts
    (M0) and its fixtures (M1). The cycle runs: training rollouts under the accepted skills, then a
    maintainer pass, a single atomic proposal, outlet-specific evaluation, a ledger event and human
    review.
  - Later roadmap items enter through that cycle.
  - **An iteration succeeds when it reaches a reviewed, reproducible decision.** A justified
    rejection or `no_action` counts. No exit criterion, metric or review requires an acceptance.
- **Consequences.**
  - Portfolio operations, the new secret platform and automatic capture are no longer
    prerequisites for evaluation. The first fixtures are local and credential-free.
  - Roadmap items after M2 are expected outlets rather than a fixed script.
- **Alternatives considered.** Keeping the evolution loop last: rejected, for the reasons above.
  Running the full-scale bench first: rejected on cost. The first cycle needs only a handful of
  tasks.
- **Status.** Accepted.

### ADR-15 — Release authority rests on a protected execution identity and an owner approval artifact, across every channel

- **Context.** The first draft guarded only the `promote.yml` dispatch. Production can also change
  through:
  - Git pushes to production-triggering refs;
  - dispatches by numeric workflow id or alternate Git APIs;
  - direct Cloudflare script uploads;
  - Vercel production deployments;
  - infrastructure apply;
  - OCI's direct-to-prod path;
  - recovery.

  A GitHub actor being a user rather than a bot does not prove a human authorized a call. A TTY
  does not prove a human is present. A workflow naming an environment does not prove reviewers are
  configured on it.
- **Decision.**
  - The release authorization matrix (18) lists every target × channel.
  - Production mutation runs only in jobs of a protected execution identity. Those jobs proceed
    only for a commit carrying an owner approval artifact bound to the tool and sha.
  - Agents hold beta-scoped capabilities only. For Cloudflare that means a separate free account
    for beta.
  - Recovery may redeploy only the last approved immutable artifact.
  - A change to promotion policy is itself owner-approved.
- **Consequences.** OCI loses unapproved direct-to-prod: each deploy needs an approval. Vercel
  production deploys move to the protected job. DR-34 to DR-36 check the wiring. The free path does
  not depend on GitHub plan features (01 K-8).
- **Alternatives considered.** Guarding only promotion: rejected, as above. Relying on
  environment required reviewers: rejected as the sole control, because it is not available for
  private repositories on every plan.
- **Status.** Accepted.

### ADR-16 — One learning cycle, with an acceptance rule per outlet

- **Context.** A framework fix should not have to raise app-building success rates. A passing unit
  test does not show that revised instructions change agent behaviour.
- **Decision.** One cycle and one ledger serve every outlet. Acceptance follows 06 §5.6:
  - skill: controlled baseline/candidate rollouts;
  - template: generated-app tests plus template mutants;
  - mechanism and doctor: a trusted reproduction that fails before the change and passes after;
  - verify: rejection of the faulty artifact.

  Candidate acceptance, merge, release and verification in production are separate ledger stages.
- **Consequences.** A pattern becomes `confirmed` only at the stage 06 §6.1 allows. An accepted
  candidate is never reported as a shipped fix.
- **Alternatives considered.** One gate for every outlet: rejected, for the reasons in Context.
- **Status.** Accepted.

### ADR-17 — Two trust models for agent isolation

- **Context.** Replacing environment variables and launching a child process does not isolate an
  agent from the operator's credentials. A coding agent can also allocate a pseudoterminal.
  Setting a proxy environment variable is routing configuration, not enforced egress.
- **Decision.**
  - **Trust model A (isolated)** is the supported adversarial boundary. The agent runs in a
    sandbox (container, VM, cloud session or separate OS user) that holds no operator credentials,
    key files, credential helpers, sockets or parent-process credentials. Its egress is enforced.
    Approval signing is outside its reach.
  - **Trust model B (local convenience)** is `agent run` on the operator's machine. It is documented
    as making no adversarial guarantee.
  - `doctor` and `agent run` state which model is in effect.
- **Consequences.** The M5 drill runs under model A. Claims in 11 and 12 are scoped to a named
  model.
- **Alternatives considered.** A single local mode presented as a boundary: rejected as
  overclaiming.
- **Status.** Accepted.

### ADR-18 — Retirement is a lifecycle with plan-bound deletion authorization

- **Context.** The guard emitted by `init` exits 1 on any planned deletion of a Supabase, Neon, D1
  or R2 store, and approval cannot resume a failed plan job. Some resources are Wrangler-managed or
  adopted, and Terraform does not own them.
- **Decision.**
  - Tools move `active → retiring → retired`.
  - `retiring` starts from an inventory with an ownership verdict and a data disposition for every
    resource.
  - The guard permits deletion only when the plan's delete set equals an owner-approved
    authorization naming exactly those addresses and the plan hash. Shared stores are never
    authorized.
  - Wrangler-managed and adopted resources get explicit outcomes.
  - `retired` is reached only when every inventory item is confirmed gone.
- **Consequences.** The general guard stays in place. Retirement is slower, but it cannot delete
  an unrelated or shared store.
- **Alternatives considered.** Telling users to remove the guard temporarily: rejected.
- **Status.** Accepted.

### ADR-19 — Milestones replace versioned phases

- **Context.** The first roadmap assigned a CLI version to each research phase (0.11 to 0.18), and
  some exit drills depended on later phases. For example, the P0 drill needed check ids that
  arrived in P2.
- **Decision.**
  - The roadmap is a sequence of milestones, M0 to M7.
  - A release is cut when a milestone's items merge, and it is numbered then.
  - Every milestone's exit drill must run against a clean installation of that milestone's release,
    using only its listed prerequisites.
- **Consequences.** The scope after M2 grows as the cycle's evidence justifies it.
- **Alternatives considered.** Keeping versioned phases and fixing only the ordering: rejected,
  because version promises would again constrain what the cycle is allowed to find.
- **Status.** Accepted.

## 2. Open questions

| id | question | recommended answer | decides |
|---|---|---|---|
| Q1 | Where does the project wiki live? | the wrapper, with pointers in tool repos (ADR-03) | M3 layout |
| Q2 | Is promotion strictly human, or opt-in automatic for low-stakes tools? | human by default; `auto-on-green` only for public tools with no store or a non-pausing store, and only after the owner approves the policy commit (ADR-07) | M4 schema, M5 enforcement |
| Q3 | Hosted or self-hosted Infisical, and is Agent Proxy on the free tier? | decide in M5 from a prototype: one credential integration with an explicit trust model and client compatibility tests comes before choosing a general fallback | M5 |
| Q4 | Which two models form the gate pair, and what are the caps? | one current frontier model and one small or cheap model; `bench/budget.json` `{monthlyUsd, perGateMaxUsd, perGateMaxRollouts}`, starting with per-gate caps sized for the M2 iteration | M1 caps, M6 monthly |
| Q5 | Does Tracer become required? | no; it stays optional (ADR-08) | M6 |
| Q6 | Who writes replay graders? | a human writes the first grader for each pattern class; the maintainer may propose graders for later instances, subject to the mutation check | M1 |
| Q7 | Do template edits go through the automated gate? | yes, by the template acceptance rule (generated-app tests plus mutants), with a human merge (ADR-16) | M4 |
| Q8 | Does the package lane join this plan? | no; it is reserved (ADR-13) | later |
| Q9 | Where does a beta of a stateful app live without creating production resources? | a separate free Cloudflare account for beta, with beta-only D1 created by the beta job; production resources are created only by the protected job after approval (18, 09) | M4 |
| Q10 | Which GitHub plan features can the free path rely on? | none beyond Actions and secrets; environment reviewers and branch protection are extra backstops where the plan provides them (01 K-8) | M5 |

## 3. Glossary

**Accounts report.** The output of `greenlight accounts`. It says which providers are configured and
verified, their quota usage and headroom, and which cells can be deployed now (08 §11.1).

**Adopted tool.** An existing project brought under Greenlight by `greenlight adopt` without
rewriting its code. Its code lives in a tool repo mounted as a submodule.

**Affects and relevance.** Two pattern fields that replace the earlier `applies` range (08 §3.1). `affects` is the set of framework versions that have the defect. `relevance` says whether the lesson still matters for app code on a fixed framework (`framework-version`, `app-code` or `both`).

**App contract.** The seven clauses, C1 to C7, that make an app self-verifying (09):

- **C1** identity;
- **C2** liveness versus readiness;
- **C3** guarded writes;
- **C4** freshness per producer;
- **C5** recorded success;
- **C6** zero idle cost;
- **C7** marking of environment-invariant checks.

**Approval artifact.** The owner's authorization for one production mutation, bound to a tool name and a sha and checked by the protected execution identity's job (18). An agent cannot create one.

**Baseline identity.** The content hashes of everything an evaluation depends on apart from the change under test: tasks, fixtures, splits, graders, mutants, runner dependencies, sandbox image, agent runtime, models, proxy policy, mode and wiki snapshot (06 §1.5, 08 §10.3). Any difference forces a new baseline.

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

**Control arm.** A deliberately wrong proposal, labelled `control` and never merged, that the evaluator must reject. It is evidence that the gate can refuse a plausible but wrong lesson (06 §10).

**Credential proxy.** An HTTP proxy that swaps placeholder credentials for real ones on outbound
requests to allow-listed hosts and routes (11).

**Doctor rule (`DR-*`).** A consistency check run by `greenlight doctor`.

**Evaluation record.** The content-addressed record of one baseline or candidate evaluation, with per-task, per-run, per-model and per-mode outcomes, seeds and costs. `bench gate --recompute` reproduces a decision from it alone (06 §5.8, 08 §10.4).

**EvidenceRef.** A typed pointer to durable evidence, such as `issue:`, `pr:`, `commit:`, `run:`,
`raw:`, `tracer:` or `post:` (08 §3.1).

**Evolution loop.** The maintain → propose → gate → ledger cycle that improves skills (06). It is
distinct from the loop.

**Fact page.** A wiki page describing one provider tier's properties and quotas, with a verified-on
date.

**Fidelity.** Whether a bench task is graded on live behavior (`runtime`) or on artifacts
(`structural`).

**Framework repo.** `RTrentJones/greenlight`, which holds the CLI, packages, Terraform modules,
skills and framework wiki.

**Framework wiki.** `wiki/` in the framework repo, shipped with the CLI.

**Gate.** The acceptance test for a skill or template candidate: the single policy table in 06 §5.4, with safety (replay non-regression) checked before efficacy (capability improvement). Other outlets use their own acceptance rules (06 §5.6).

**`greenlight-evo` / `greenlight-evo-alarm`.** GitHub labels. The first marks issues, branches and
PRs opened by the evolution loop. The second marks regression alarms opened by `evo-monitor.yml`.

**`GREENLIGHT_WIKI=off`.** An environment switch that disables `wiki lookup` and every skill hook
that reads the wiki. The bench runner sets it for every rollout.

**Headroom.** The share of a free-tier quota still unused across the whole portfolio.

**Hook.** A defined point at which a managed skill reads or writes the wiki: `on-start`,
`on-failure`, `on-complete` or `on-incident` (05 §3).

**Incident.** A timeline page that links evidence for a failure that unfolded over time. It is
never shown to building agents.

**Inject spec.** A provider-registry declaration of how the proxy attaches a token: hosts, header,
scheme, allow-list and scrub rules.

**Intent.** A tool's purpose and its acceptance criteria in the owner's words, each mapped to verify
check ids.

**Isolation mode and production mode.** The two evaluation modes (06 §4.7). Isolation mode runs with the wiki off and attributes effects to skill text. Production mode runs with the hooks on against a pinned wiki snapshot, and checks the workflow as shipped.

**Lane.** What a tool is: `astro`, `next`, `mcp`, `agent`, and in future `package`.

**Ledger stage.** One append-only event in a proposal's life: `no-action`, `candidate-rejected`, `candidate-accepted`, `merged`, `released`, `verified-in-production` or `withdrawn` (06 §6.1).

**Ledger.** `wiki/ledger.jsonl`, the harness-written record of every proposal and remediation,
rendered to `skill-impact.md`.

**Lexicographic gate.** The ordering inside the policy table: safety constraints are checked first, and efficacy is evaluated only if safety holds.

**Lint rule (`LR-*`).** A check run by `greenlight wiki lint`.

**Liveness model.** What idleness does to a tool's weakest dependency: `needs-traffic`,
`needs-silence`, `needs-heal` or `always-on`.

**Loop, the.** The deploy-verify-promote delivery loop: local gate, then verify config, push, ship,
promote. The skill `deploy-verify-promote` carries it.

**Maintainer.** The role, played by an agent following the `greenlight-wiki` skill, that compiles
raw evidence into wiki edits.

**Managed skill.** Any skill under Greenlight's skill system, with a `SKILL.md`, a `PURPOSE.md`, a
version, hooks, a bench slice and ledger rows. Every skill is managed, the loop skill included.

**Milestone (M0–M7).** A unit of the roadmap (14). A release is cut when its items merge, and its exit drill runs against a clean installation of that release.

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

**Protected execution identity.** The CI identity that alone holds production credentials and runs production-mutating jobs, and only for commits carrying an approval artifact (18).

**Proxy check.** A check that measures something next to the thing at risk, so that it passes while
the thing fails. This is the dominant failure class in Greenlight's history.

**PURPOSE.md.** A skill's sidecar file. It maps the skill's rules to the wiki pages that justify
them and carries the skill's management metadata.

**Raw record.** An immutable, redacted record of one run, with durable references (08 §5).

**Replay task.** A bench task that reproduces a confirmed failure pattern. A proposal that makes a
previously passing replay task fail is rejected.

**Retire, retiring, retired.** Retirement lifecycle states. `retiring` starts with an inventory and a plan-bound deletion authorization. `retired` is reached only when every inventory item is confirmed gone (ADR-18, 10).

**Safety-fix path and neutral path.** Human-reviewed alternatives to the efficacy requirement, never to safety. The safety-fix path is for replay-only fixes and security repairs. The neutral path is for prerequisite changes (06 §5.4).

**Settle loop.** Verify's retry window for eventually consistent deploys. Without SHA gating, it can
green-light the previous artifact.

**SHA gating.** Verify asserting that the deployed `/__version` equals the commit being shipped.

**Ship.** One loop turn for one environment: build, deploy, SHA-gated verify, and rollback on
failure.

**Stage event.** A JSON event emitted for each ship or preview stage (08 §7).

**Target.** Where a tool runs: `workers`, `vercel`, `oci` or `docker`.

**Tool repo.** An adopted project's own repository.

**Training, validation and test evidence.** Bench splits with different visibility (06 §1.4). The proposer sees training traces in full and validation only as an aggregate score. Test results are seen only at release. Graders and mutants are never visible to agents.

**Trajectory.** The time-ordered record of shimmed commands and agent tool calls in a rollout, written through a channel the agent cannot edit. Trajectory graders judge action order, such as whether preview came before push (06 §4.6).

**Trust model.** The declared isolation level of an agent session (ADR-17). Model A, isolated, is the adversarial boundary. Model B, local convenience, makes no adversarial guarantee.

**Vibe coding.** Building software by describing it to an agent. In Greenlight, the agent writes
the intent and checks, and the gates hold it to them.

**Wrapper.** A consumer repo scaffolded by `greenlight init`. It holds the manifest, infra, verify
configs, the project wiki and content.
