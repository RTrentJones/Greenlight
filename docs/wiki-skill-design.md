# Wiki skill — design considerations

Companion to [plan-wiki-skill.md](plan-wiki-skill.md). The plan describes *what* to build. This
document works out *why the design has the shape it does*. It starts from the failures the
current tools have actually had, then from the vision of anyone pointing an agent at Greenlight,
and it records where Greenlight should depart from the WikiSkill paper (arXiv:2608.27454) and why.

## 0. Scope against the vision

Greenlight's vision is a managed portfolio. It keeps projects alive, it lets Claude or Codex edit
them, it verifies each change in beta, and it leaves release under the owner's control. This
extension lets someone vibe code new projects onto the free tiers they have set up. The
[plan](plan-wiki-skill.md) ranks the work against that vision. The project wiki (handoff memory),
the vibe-code flow, portfolio operations and agent neutrality come first. The paper-derived
evolution loop in section 5 is optional and comes last.

This document remains the reasoning behind each mechanism. Read section 5 as the design for that
optional phase, not as the centre of the work.

## 1. Evidence from the current use cases

Six tools run on Greenlight today:

- **blog**: astro/workers.
- **heistmind**: next/vercel/supabase, with OAuth.
- **bamcp**: mcp/oci, with OAuth.
- **tracer**: next/vercel/neon.
- **muse**: agent/workers/kv.
- **polyphony**: a FastAPI container on the mcp/oci path, with a separately wired Neon database.

Between them they have produced about forty `fix:` commits across this repo and the wrapper (24 here, 18 in the wrapper), two
long-running incidents (wrapper issues #55 and #86), and two blog posts that analyse incidents. Taken
together, that history is a better specification for the wiki than the paper. Sorting it by root
cause gives eight classes.

### 1.1 Proxy checks: the check measures something next to the thing at risk

This class is the largest, and it is the one the operator singled out as the lesson: "a check that
passes for the wrong reason is worse than having none, because it is the one I trust." Instances:

- The keepalive probed `/rest/v1/`. PostgREST answers that from its schema cache, so Postgres never
  saw the request and Supabase paused anyway (#55).
- The keepalive response was served from Cloudflare's cache, so the probe never left the Worker.
- Polyphony's keepalive and container healthcheck hit `/health`, which wakes the database, when the
  thing at risk was the container.
- Muse reported `ok` before an attempt had succeeded ("report ok only after a successful recorded
  attempt").
- Verify accepted empty matchers and attempts that never succeeded.
- Tracer computed freshness across all tools instead of per feed. One fresh producer hid a stale
  one.
- The verify settle loop could green-light the *previous* deployment. This is why SHA gating exists.

**Design consequence.** A pattern has to name the **thing at risk**, the **layer that was actually
probed**, and **the check that would distinguish the two**. A generic "problem, root cause, fix"
record does not capture what made each of these failures hard to see. Section 3.2 turns this into
a structural rule for pattern pages.

### 1.2 The fix exists but is not what is running

- HeistMind's probe-table setting was committed two weeks before the pause. It was inert, because
  the deployed Worker was still 0.8.
- `^0.8.0` did not admit 0.9.0, so `pnpm update` silently kept the old version (the 0.x caret trap).
- Vercel production builds and OCI restarts outlast the verify window (the settle-window fixes,
  #52).
- The operator closed #55 only after hashing the deployed Worker against the release.

**Design consequence.** A pattern can be marked *resolved* only on evidence that the **deployed
artifact** changed and that the distinguishing check went from red to green. A merged PR is not
enough. Patterns are also *version-scoped*: "fixed in 0.9" is useless to an agent unless the wiki
knows which version the reader has installed (section 3.4).

### 1.3 Free-tier physics

- Supabase pauses after 7 days.
- Neon never slept, because of 50k idle queries a day from three timers, which burned the compute
  allowance.
- OCI reclaims idle instances, and OCI signup requires a card.
- Gemini has free-tier overloads, and its default model rotates (#25, #26).

These are facts about providers, they change on a schedule nobody controls, and the two directions
of failure are opposite. Supabase needs traffic, while Neon needs silence. **Design consequence.**
Free-tier knowledge is its own page type (`fact`). Each fact page carries a verified-on date and a
statement of which direction idleness cuts. The build skill's rule is "idle cost is zero, and
liveness never touches the store unless the store is what is at risk."

### 1.4 Preview and prod contracts drift

- Polyphony's preview base path had to become `/mcp` so that relative paths would resolve the same
  way in both.
- Tracer's data-dependent checks had to become prod-only.
- HeistMind serves a holding page in prod and the full app in beta.
- BAMCP runs with auth off in preview.

The function-shaped `verify.config` exists because of this class. **Design consequence.** The
self-verifying-app contract must say explicitly which checks are environment-invariant and which
depend on environment. A bench grader that runs only in preview must not be mistaken for a prod
guarantee.

### 1.5 Silent capability regression

BAMCP's OAuth Dynamic Client Registration was disabled. The static M2M token kept verify green while
claude.ai's connector could no longer register (#49). `exactTools` exists for the same reason.
**Design consequence.** A pattern in this class has a natural outlet that is a *verify assertion*,
not skill prose. The fix that stuck was a check that DCR is advertised *and* that it answers.

### 1.6 IaC hazards

- An unplanned replacement of running compute (#27).
- Neon state surgery (`state rm` of branch and endpoint "failing loudly").
- `adopt` remediate plans that were missing the account id and zone id.

**Design consequence.** These outlets are mechanism: a guard in `infra.yml`, or a `doctor` rule.
Skill prose would be a weak substitute.

### 1.7 Spec validity

Eleven `fix(verify)` commits made specs strict, because a typo or an unknown field
could silently turn an assertion off. **Design consequence.** Any machine-written artifact in the
wiki loop must pass the same strict validation before anything trusts it. That covers maintainer
JSON, proposer edits and bench graders. The paper's exact-substring patch protocol is in the same
spirit, and the plan adopts it.

### 1.8 Alert suppression

While #55 was open, the alerting sent nothing new, so a BAMCP or Polyphony failure could not have
alerted either. **Design consequence.** This one is small, but it is a reminder that the raw layer
must capture *runtime* signals (keepalive sweeps, alert issues), not just build-time episodes.

### What the classes add up to

Three conclusions follow, and the rest of the design hangs on them.

1. **Most lessons were absorbed as mechanism, not as instruction.** Strict specs, SHA gating, the
   destroy guard, `exactTools` and the required probe table are all examples. The paper's only
   outlet for a learned pattern is skill text. Greenlight's history says skill text is the
   *weakest* outlet. The wiki loop therefore has to route each pattern to the strongest outlet
   available (section 2).
2. **Incidents unfold over weeks, not episodes.** The keepalive story ran from July to October and
   spanned two repos, three releases, two issues and a blog post. The paper's trace is one task
   rollout. Greenlight's raw layer has to link artifacts across time (section 4).
3. **The dominant failure is a check that lies.** Every grader, health route and liveness probe
   that the wiki loop produces is itself liable to that failure. The design has to test its own
   checks (section 5.3).

## 2. Outlets: where a pattern should go

The paper has one outlet: create or patch a skill. Greenlight needs a ranked list. The proposer
picks the **strongest outlet that can express the pattern**, and the gate evaluates it. The rule
behind the ranking is that a lesson enforced by code cannot be forgotten by a model.

| rank | outlet | example from history | who can apply it |
|---|---|---|---|
| 1 | framework mechanism: CLI, verify harness, adapter, TF module | SHA gating; strict specs; required probe table | human PR to Greenlight |
| 2 | `doctor` rule (drift or lint) | missing verify spec; version-ref drift; no preview receipt | human PR to Greenlight |
| 3 | template default (`tools/_template-*`) | agent template's `/__version` + `/health` | human PR, gated by bench |
| 4 | verify assertion in a tool's spec | BAMCP DCR advertised + answers 400 | agent, in the consumer repo, via the normal loop |
| 5 | skill text | "liveness never touches the store" | proposer, gated by bench |

Two consequences follow for the loop:

- **Outlets 1–3 are code changes, so they go through the framework's own review and release.** The
  wiki loop *proposes* them by opening an issue that cites the pattern. It does not apply them. The
  automated propose–gate–accept cycle from the paper runs only over outlet 5, plus template edits
  (outlet 3) when those can be expressed and benched in isolation.
- **`skill-impact.md` generalizes into a remediation ledger.** Each row records:
  - the pattern;
  - the outlet chosen;
  - the change, as a diff or a PR link;
  - the evidence it worked, which is a bench delta for outlets 3 and 5, or the distinguishing
    check going red to green on a deployed artifact for outlets 1, 2 and 4;
  - the outcome.

  A pattern whose only remediation is skill text, while a mechanism was possible, is a lint
  warning ("instruction where a mechanism would do").

This also gives the proposer a concrete decision procedure that the paper lacks. Before writing
prose, it asks whether a check could have caught the failure. If one could, the first remediation
is that check.

## 3. The knowledge model

### 3.1 Page types

The paper has a single page type. Greenlight's existing knowledge comes in five shapes, and forcing
them into one would either bloat pattern pages or lose information.

| type | holds | length | read by |
|---|---|---|---|
| `pattern` | one failure mode or strategy (paper's unit) | 10–30 lines | proposer, building agent on failure |
| `fact` | a provider or free-tier property, with a verified-on date | ≤ 20 lines | kickoff and build skills (linked), lint |
| `decision` | a locked choice and its reason (e.g. the blog never uses a pausing store) | ≤ 20 lines | proposer (so it does not relitigate), humans |
| `incident` | a timeline that links raw evidence, citing the patterns it produced | unbounded | maintainer, humans; **never** the building agent |
| `contract` | the self-verifying-app contract, one page per clause | ≤ 30 lines | build skill, grader authors |

Incidents are where the multi-week stories live. The keepalive post is already essentially an
incident page with a narrative. Keeping incidents out of the building agent's reach follows the
paper's ablation, which showed raw narrative is worse context than distilled rules. It also keeps
token cost down.

### 3.2 Anatomy of a pattern page

The paper requires "pattern, root cause, trace evidence, workaround". This design adds fields that
section 1 shows are load-bearing:

```markdown
---
type: pattern
kind: failure            # or strategy
class: proxy-check       # one of the §1 classes; open set, lint warns on new values
at-risk: supabase idle timer (Postgres activity)
probed: PostgREST schema cache
cells: [next/vercel/supabase]
applies: ">=0.1 <0.9"     # semver range of @rtrentjones/greenlight where this bites
status: confirmed         # hypothesis | confirmed | superseded
superseded-by: null
evidence: [issue:RTrentJones/RTrentJones.dev#55, pr:RTrentJones/greenlight#28, raw:…]
catches: "api check: GET /rest/v1/<table>?select=<col>&limit=1 → 2xx with ≥1 row"
remediation: [outlet:mechanism, ref:greenlight@0.9.0]
---
```

The fields `at-risk`, `probed` and `catches` encode the lesson from section 1.1. A pattern
that cannot fill in `catches` is a signal that its remediation is still unproven. `applies` lets
the reader filter by installed version. `status` and `superseded-by` keep the wiki append-only, as
the paper requires, while still letting a wrong root cause be retired. The first keepalive fix was
superseded twice, and an agent must not follow it.

### 3.3 One home per fact

Knowledge today is spread across provider skills ("footguns"), `docs/`, `greenlight-v2.md`, both
`CLAUDE.md` files and the blog. A wiki can easily become a fifth copy that drifts. The rule is:

- **skills** say what to do;
- **`docs/` and the spec** say how the framework works;
- **the wiki** says what happened, why, and how we know.

Each statement has one home, and the other places link to it. In practice this means that, as each
pattern is seeded, the footgun paragraph in the provider skill shrinks to a one-line rule plus a
link to the pattern. Reviewers enforce this rule, because lint cannot detect duplicated meaning
reliably. Lint can detect that a skill cites a pattern through `PURPOSE.md`.

### 3.4 Versioning

The plugin is at `0.1.0` while the CLI is at `0.10.1`. The skills already drift silently from the
mechanics they describe. The wiki would make this worse, because patterns describe version-specific
behavior. Options:

- **Ship the wiki and skills inside the npm package**, so `greenlight agent sync` materializes the
  version-matched copy, as it already does for the loop skill. The plugin then tracks the same
  version (lockstep, the same trade-off as `MODULE_REF`). **Recommended.** It is consistent with
  the existing lockstep stance, and it makes `applies:` resolvable from `package.json`.
- Keep the plugin on its own channel and treat `applies:` as advisory. This is cheaper, but agents
  in a stale consumer repo will read patterns about versions they do not have.

`doctor` gains a check that the installed skills' and wiki's version equals the CLI's version.

## 4. The raw layer when evidence spans weeks

The paper's raw layer is a directory of rollouts that a harness writes once. Greenlight's evidence
lives in places it does not own (GitHub issues and PRs, CI runs, Cloudflare deploy history, Tracer
runs) and accumulates over weeks.

- **Store by reference, pin by identity.** A raw entry is a small JSON record. It holds the URL plus
  an immutable identifier (commit SHA, CI run id, issue number with a `updated_at` snapshot, Tracer
  run id) and an excerpt truncated to the paper's 15k characters. It does not copy the full logs.
  Immutability comes from the identifiers. The approach also keeps most secret-bearing logs out of
  the store entirely.
- **Tracer is the natural runtime store.** It already ingests the OTel-shaped `verify --json`,
  stores runs per `tool · mode · suite · env`, computes flakiness and regressions, and compares
  models. Stage events and bench runs should flow to Tracer as more suites. The wiki's raw records
  then point at Tracer run ids. This avoids building a second store, and it gives the remediation
  ledger a dashboard for free. Because the ingest shape is a standard one, a consumer without Tracer
  can point the same export at Langfuse or Phoenix. The design must not *require* Tracer, so the
  local fallback is `.greenlight/raw/`.
- **Three time scales, one join key.** Signals arrive at three time scales:
  - build time: an agent session, `preview`, a bench rollout;
  - deploy time: `ship` stage events;
  - run time: keepalive sweeps, cron freshness, alert issues.

  The join key is `(tool, sha)`, and incident pages are views over it. The maintainer is invoked
  per incident ("compile #86"), or per batch of failing bench rollouts. It is not invoked per
  iteration as in the paper.
- **Agent transcripts are opt-in.** The reasoning that produced a bad change lives in the agent's
  transcript (a Claude Code session JSONL, or a remote session's events). That transcript is the
  most informative raw evidence, and it also carries the highest risk of personal data and secrets.
  The default capture is the gate outputs plus the diff. Transcripts are captured only in bench
  sandboxes, where no real secrets exist, or when the operator explicitly asks.

## 5. Validation

### 5.1 Why field data cannot gate skill changes

Greenlight already records the first-pass gate rate per skill version (`skillVersion()` on stage
events, v2 §6). It is tempting to use that as the paper's validation score, but it does not work for
three reasons:

1. **The tasks are confounded.** A week of blog posts and a week of OAuth work have different
   difficulty.
2. **The sample is tiny.** One operator ships a few dozen times a month.
3. **Exposure is the risk being gated.** A bad skill version that ships to everyone before the
   data arrives has already done its damage.

Field data therefore becomes a **monitor, not a gate**. It raises an alarm when the first-pass rate
or the rollback rate for a skill version drops relative to the previous version. That alarm opens a
maintainer pass. The counterfactual comparison happens on the bench.

### 5.2 A bench built from incidents

The paper's benchmarks are external. Greenlight's bench has two parts:

- **Capability briefs.** These are "build X on cell Y, free tier" tasks spread across the lane ×
  target × data matrix. They measure the kickoff and build skills.
- **Replay tasks**, one per `confirmed` failure pattern whose class is reproducible locally.
  Examples:
  - "add a keepalive target for this Supabase-shaped service", graded on whether the probe reaches
    the store;
  - "add a health route to this Neon app", graded on whether idle traffic is zero over a simulated
    window;
  - "add an OAuth MCP server", graded on whether DCR is advertised and answers.

  Replay tasks turn the operator's rule, "add it to the verify loop", into "add it to the bench".

The gate is **lexicographic**. A proposal must first not fail any replay task that passed before;
this is a hard constraint. It is then accepted only if the capability score strictly improves, per
the paper's criterion. Without the replay constraint, a skill edit that helps capability could
reintroduce a known incident, and the strict-improvement rule alone would not notice as long as the
average rose.

### 5.3 Graders must be shown to fail

The dominant failure class applies to the bench too. A hidden grader that passes for the wrong
reason would make the bench a proxy check. Every grader therefore ships with **at least one
known-bad variant**: the replay's original faulty implementation, or for capability briefs a
mutation such as removing the auth guard, serving a stale sha, or pointing the probe at a cache.
**The grader must fail on each one.** CI runs these mutation checks whenever a grader changes.
This is the bench's equivalent of the operator's "verify the deployed artifact, not the pipeline's
report", and it is a departure from the paper, which takes benchmark graders on trust.

### 5.4 Locality, determinism and cost

Bench scoring runs through `greenlight preview`, so it needs no cloud and costs $0 in
infrastructure. Some classes cannot reproduce locally: real Supabase pausing, OCI reclaim, Vercel
build latency. For these, the replay task grades the *artifact* against the pattern's `catches`
assertion; for example, the keepalive config must name a table and the probe must request it. Each
such task is marked `fidelity: structural`, so nobody mistakes it for a runtime guarantee.

Token cost is the binding constraint. A rough figure is 30 briefs × 3 runs × 2 models ≈ 180
rollouts per proposal. The plan starts with a 10-brief validation split plus all replay tasks, runs
on demand, and stops early when R reaches 1.0, as the paper does. The paper's argument for a cost
that stays constant as training grows (`1 + T_ReAct` optimizer calls) carries over unchanged.

### 5.5 Model plurality

The paper found skills that collapse another model's performance (50.5 → 18.1). "Anyone's agent"
means any model, and possibly not Claude at all. Every ledger row therefore records the model used
for rollouts. The gate runs one frontier model and one small or cheap model. A proposal may not
regress either of them. A scheduled monthly re-run of the test split against current default models
detects drift that comes from the model changing underneath the skill. Muse's Gemini default
already rotated twice.

## 6. Working back from the vision

### 6.1 "Anyone points their agent"

- **Any agent, not just Claude Code.** SKILL.md is the portable layer, but routing, the
  tool-permission model and plugin installation are vendor-specific. The vendor-neutral interface
  should be the **CLI**:
  - `greenlight wiki lookup <check-id|class|cell>` prints the relevant patterns;
  - `greenlight verify` failure reports append `see: wiki/patterns/<slug>` whenever a failing
    check's signature matches a pattern's `catches`.

  The debugging lookup then reaches any agent that reads command output. This is also how the
  design answers the paper's open question on retrieval: retrieval is keyed by the *failing check*,
  not by semantic search, and it fires only after a failure. That timing also respects the ablation
  about wiki access during normal work (section 6.4).
- **Zero cost for real.** The domain is the one paid item on the default path (`domain` is
  required, and `init` assumes a Cloudflare zone). The no-domain mode in the plan is a prerequisite
  for the promise, not a convenience. Card-required providers (OCI) and pausing providers
  (Supabase) are offered only with their `fact` page linked inline.
- **Starting from nothing.** Kickoff has to handle a user with no GitHub CLI, no Cloudflare account
  and no idea what HCP is. Every prerequisite step therefore has a verifiable done-state that the
  skill checks: `gh auth status`, `greenlight secrets check`, `greenlight doctor`. The skill never
  relies on the agent's belief that a step is finished, which is the same principle as SHA gating
  applied to onboarding.

### 6.2 "All sorts of self-verifying web apps"

The vision is lane-agnostic. Today only `_template-agent` serves `/__version` and a health route, so
the self-verifying contract is mechanism for one lane and an instruction for the other three. The
contract, drawn from section 1, has seven clauses:

1. **Identity.** `/__version` serves the build sha. This turns on SHA gating (§1.2).
2. **Liveness vs readiness.** `/health/live` never touches the store, and `/health` checks each
   dependency as JSON (Polyphony, §1.3).
3. **Guarded writes.** Every write route has an unauthenticated-rejection assertion (§1.5).
4. **Freshness per producer.** Every cron or feed exposes a last-success time *per producer*, and
   verify asserts `maxAgeHours` on each (tracer and muse, §1.1).
5. **Success is recorded, not inferred.** An `ok` status exists only after a recorded successful
   attempt (muse, verify, §1.1).
6. **Idle cost is zero.** No timer touches a scale-to-zero store while the app is idle (Neon, §1.3).
7. **Environment-invariant checks are marked.** The spec separates invariant checks from
   environment-specific ones (§1.4).

**Outlet ranking applies to the contract itself.** Clauses 1, 2 and 7 belong in every template
(outlet 3). A `doctor` rule (outlet 2) flags a tool whose spec lacks an identity or freshness check.
The build skill carries only what cannot be mechanized, which is mainly clauses 4–6 for app-specific
logic. The `contract` page type exists so that templates, `doctor`, graders and the skill all cite
the same clause text.

### 6.3 Contribution, trust and poisoning

Once anyone can contribute patterns, the wiki becomes a channel through which untrusted text
reaches other people's agents as guidance. This is a prompt-injection supply chain. The controls:

- The **framework wiki changes only through a reviewed PR** to Greenlight. `wiki contribute` opens
  a PR and nothing more. The PR template asks for evidence links, and `check-seam` runs on the
  pattern.
- **Skills change only through the gate**, and patterns never become skill text without a ledger
  row. A pattern is data to the proposer, never instruction. The proposer prompt must say so, as
  the paper's maintainer prompt implicitly assumes.
- **Building agents see only the framework wiki and their own project wiki.** They never read
  another consumer's project wiki directly.
- **Evidence must be checkable.** A contributed pattern whose evidence links do not resolve, or whose
  `catches` assertion has no grader, merges as `status: hypothesis`. A hypothesis is never surfaced
  by `wiki lookup` to building agents.

### 6.4 Wiki access for the building agent

The paper's result (63.7 → 60.9 when the inference agent reads the wiki) was measured during
*evolution*, where the concern is trace informativeness. In production the concern is solving the
user's problem. The design draws the line by **timing and content**:

- **Before a failure**, the agent reads skills only. Skills carry rules, and `fact` pages are linked
  from the skills when choosing a cell.
- **After a gate fails**, the agent receives `wiki lookup` results keyed to the failing check, and
  only `confirmed` patterns.
- **In bench rollouts**, the agent gets no lookup at all, so that traces measure skills.

Phase 4 measures whether the post-failure lookup helps, by running the validation split with
lookup on and with it off. If it does not help, it is removed. The plan does not assume that it
does.

## 7. Growth and pruning

The paper names pruning as an open limitation. At Greenlight's scale the risk is not size; it is
**stale authority**, meaning a pattern that was true for 0.8 and is still being surfaced at 0.12.
Version scoping (`applies:`) handles most of that without deletion. The remaining rules:

- A `pattern` with no evidence newer than 180 days, no citing skill and an `applies:` range that
  excludes the current version moves to `wiki/archive/`. It is archived, not deleted.
- A `fact` past 90 days since `verified:` makes `doctor --strict` warn. It is refreshed by a human,
  or by an agent with the provider's docs.
- **The index is split by cell** once it passes about 60 lines, so a reader loads only the cells in
  their manifest. The paper's full-index regeneration still applies within each shard.

## 8. Non-goals

- **No hosted wiki or knowledge service.** It would contradict clone-and-own (v0 §2). The wiki is
  files in git, and the optional runtime store is Tracer, which the consumer runs.
- **No automatic merging into the public plugin.** The gate accepts a change into a release
  candidate, and a human cuts the release.
- **The wiki is not framework documentation.** `docs/` remains that, as described in section 3.3.
- **Online learning inside a user's session is out of scope.** The loop is offline and batch, as in
  the paper.

## 9. How this changes the plan

1. **Phase 0 becomes "compile the corpus".** It turns the existing ~40 fix commits, issues #55 and
   #86, and the two incident posts into `pattern`, `incident`, `fact`, `decision` and `contract`
   pages, with the section 3.2 frontmatter. It also writes `PURPOSE.md` for each existing skill.
   This phase delivers the most value with the least machinery, and it tests the schema against
   real cases before any automation depends on it.
2. **A new Phase 1.5 puts the contract into the templates.** Clauses 1, 2 and 7 go into the astro,
   next and mcp templates, and `doctor` gets rules for identity and freshness. This is outlet
   ranking applied to the project's own goal.
3. **Raw capture becomes reference-based and feeds Tracer** (section 4), with
   `.greenlight/raw/` as the fallback.
4. **The Phase 4 bench gains replay tasks, mutation-tested graders and the lexicographic gate**
   (section 5).
5. **The skill-impact ledger becomes the remediation ledger**, with an outlet column (section 2).
6. **The wiki and skills version in lockstep with the CLI**, and `doctor` checks for drift
   (section 3.4).
7. **`wiki lookup` and failure-report links** replace "the agent may read the index on failure"
   (section 6.4).
8. **Secrets move to one readable source with three consumers**, and agents get credentials only
   through an injecting proxy (section 11). Raw-capture redaction becomes a backstop instead of the
   primary control.

## 10. Open questions

- **Does Tracer become a required part of the evolution loop, or stay optional?** Recommended:
  optional. The bench gate reads local results, and Tracer adds history and dashboards.
- **Who writes replay graders?** Recommended: a human writes the first grader for each class. The
  maintainer may then propose graders for new instances of that class, subject to the mutation check.
- **Should outlet-3 template changes go through the automated gate?** They are code, but they are
  benchable in isolation. Recommended: yes for gate evidence, with a human merge.
- **Which models make up the gate pair, and what is the monthly token budget?** This is the
  operator's call. Without a budget the bench will either run rarely or run up costs.
- **Hosted Infisical or self-hosted, and is Agent Proxy on the free tier?** Its free-tier status
  was not confirmed when this was written (section 11.3). The answer decides between Infisical's
  proxy and the Worker proxy as the default.

## 11. Secrets: one source, three consumers

### 11.1 The current model and where it stops working

Today GitHub Actions secrets are the single store (`docs/security.md`). `secrets gather`
hidden-prompts each value, verifies it fail-fast, and pushes it with `gh` over stdin. Terraform
then carries provider credentials into the runtime stores (Workers secrets, Vercel env). That model
is sound for CI, but it has one structural property the wiki loop runs into: **Actions secrets are
write-only from outside a workflow.** Nothing outside CI can read them, so any agent-side step that
needs a credential has no sanctioned source. Steps of that kind:

- `verify --env prod` with `BAMCP_VERIFY_TOKEN`;
- `deploy` from a session;
- a provider MCP server;
- a bench rollout that touches a real API.

The result is the usual workaround of a token pasted into a shell, or into chat. The vision makes
this worse. "Anyone points their agent" means many agents, on many machines, each needing some
credentials, and the contribution channel in section 6.3 means some of the text those agents read
will be adversarial. An agent that holds no secret cannot be talked into leaking one.

### 11.2 What Codex does, and the pattern worth copying

Codex cloud, per OpenAI's environment docs, exposes secrets **only to the setup script** and
removes them before the agent phase starts, whereas plain environment variables persist through the
task. That is a phase boundary rather than an HTTP mechanism. It is the right instinct, because the
agent never holds the value. It does not help an agent that needs to call an authenticated API
*during* its work. Any file written during setup, such as an `~/.npmrc` token, also defeats the
boundary.

The pattern that does cover the working phase is the **credential-injecting egress proxy**. The
agent's environment holds a placeholder, or nothing at all. Outbound HTTPS goes through a proxy
that matches the destination host and swaps in the real credential on the wire. This Claude Code
cloud session runs behind one of these, and the same design appears in Docker's AI sandboxes, in
Infisical's Agent Proxy and open-source Agent Vault, and in Blaxel's sandbox networking. The agent
keeps using its normal CLIs, SDKs and MCP clients.

### 11.3 Candidate tools

| tool | fit for Greenlight | agent-facing mechanism | cost / ops |
|---|---|---|---|
| **Infisical** | best overall fit: OSS and self-hostable (clone-and-own), syncs secrets *to* GitHub Actions so CI keeps working, GitHub OIDC auth | **Agent Proxy** (GA July 2026; `infisical secrets agent-proxy connect`, placeholders, header/path/body substitution) and **Agent Vault** (OSS forward proxy); official MCP server | cloud free tier exists; whether Agent Proxy is included was **not confirmed**; self-host is free but is one more service to run |
| **Cloudflare Worker proxy (build our own)** | lives on the always-on spine, free tier, no new account | reverse proxy at `vault.<domain>`: a session token goes in, the real header comes out; per-route method/path allow-list; no TLS interception | we own the code and its security; each client needs a base-URL override, which not every CLI supports |
| **Bitwarden Secrets Manager** | open source, free plan, per-agent machine-account tokens | SDK/CLI fetch plus an MCP server (experimental); **no injecting proxy**, so the agent holds the value | free plan limits apply |
| **Doppler** | polished, syncs to GitHub/Vercel/Cloudflare | `doppler run`, MCP server (preview); the agent holds the value | free developer tier; reportedly does not bill machine identities |
| **1Password** | strong UX, Environments MCP built into the desktop app, Unified Access aims to keep secrets from models | `op run`, service accounts | **no free plan**, which conflicts with the free-tier goal |
| **Vault / OpenBao** | dynamic, short-lived credentials | Vault Agent templating, response-wrapping | heavy to operate for one person |
| **Docker sandboxes (`sbx`)** | local sandbox runs only | host-side injecting proxy (`sbx secret set`) | local, free; does not cover CI or cloud sessions |

Treat vendor details as of November 2026, and re-verify them, because several of these products
are months old.

### 11.4 Recommended architecture

**One readable source, three consumers.** The CI and runtime stores become *projections* of a
single source.

```
           ┌────────────── Infisical (source of truth; GitHub OIDC; audit log) ─────────────┐
           │                              │                                                  │
   sync → GitHub Actions secrets    Terraform → Workers secrets /           Agent Proxy (or Worker proxy)
   (CI: ship, infra.yml)            Vercel env (runtime, unchanged)          → agents get placeholders only
```

- **CI is unchanged.** Workflows keep reading `secrets.*`. Infisical's GitHub sync writes them, so
  `infra.yml`, `deploy.yml` and `promote.yml` need no edits. GitHub OIDC remains the preferred auth
  for cloud providers that support it.
- **Runtime is unchanged.** Terraform still projects values into Workers and Vercel.
- **Agents never receive raw values.**
  - `greenlight agent run -- <cmd>`, or the session's `HTTPS_PROXY`, wraps the agent.
  - The environment carries placeholders, and the proxy injects the real header for allow-listed
    hosts.
  - Node 24 tools need `NODE_USE_ENV_PROXY=1` for built-in `fetch` to honour the proxy, and the
    proxy's CA has to be trusted. `doctor` should check both. Requests that skip the proxy fail
    with an invalid-placeholder error, which is the safe direction.

**The provider-pack registry generates the proxy configuration.** This is where centralization
becomes real rather than a policy. `providers.ts` already declares every token's `envVar`, scopes,
create-link and a fail-fast `verify` call against the provider's API. One more field per token
lets the registry emit the proxy's service definitions:

```ts
inject?: { hosts: ['api.cloudflare.com'], header: 'Authorization', scheme: 'Bearer',
           allow?: [{ method: 'GET', path: '/client/v4/**' }] }
```

With that field, `greenlight add` declares a tool's credentials once, and the same declaration
drives four things:

- `secrets gather`, which writes to Infisical instead of `gh`, with `--sink github` kept for the
  current model;
- the GitHub sync;
- the proxy routes;
- `secrets check`.

**Not everything can be injected over HTTP**, and the registry should say so explicitly:

- **OCI** authenticates by request signing over the request itself. A header swap cannot produce
  that signature, so OCI keys stay CI-only.
- **The docker target's SSH key** is not HTTP at all, so it also stays CI-only.
- **`GREENLIGHT_DISPATCH_TOKEN`** lives in tool repos, so it remains a per-repo GitHub secret.

Tokens without an `inject` field are CI-only by definition. `doctor` lists them, so the boundary
is visible rather than discovered.

### 11.5 Limits the design must not overclaim

- **A proxy prevents leaking the credential, not misusing it.** An agent behind the proxy can still
  ask Cloudflare to delete a DNS record. Least-privilege tokens remain the first control. Per-route
  method/path allow-lists are the second: an agent's Cloudflare route can be read-only plus
  `workers/scripts` writes, with zone deletes denied. The keepalive lesson applies here too, so
  each allow-list ships with a mutation check proving that a forbidden call is refused (section
  5.3).
- **Responses can carry secrets back.** Some provider APIs echo tokens or connection strings, such
  as Neon connection URIs and Supabase keys. The proxy should scrub known secret shapes from
  response bodies, and raw capture keeps its redaction as a second layer.
- **TLS interception is a trust decision.** A forward proxy that injects headers has to see
  plaintext. Installing its CA lets it see all traffic, not only the allow-listed hosts. The Worker
  reverse proxy avoids this, at the cost of base-URL overrides.
- **Sessions must be short-lived and attributable.** Each agent session gets its own proxy identity
  with a TTL, and the audit log records `(session, host, method, path, status)`. Those records
  become raw-layer evidence for the wiki in the same `(tool, sha)` join as everything else (section
  4).

### 11.6 How this changes the plan

- **Phase 1 (raw capture).** Agents run behind the proxy, so captured traces contain placeholders.
  Redaction stays as the backstop, and its planted-secret test remains a merge blocker.
- **Phase 2 (kickoff).** The kickoff skill sets up Infisical (free cloud or self-host) after GitHub
  and before Cloudflare. It also offers `--sink github` for users who want today's model with no new
  account.
- **Phase 4 (bench).** Bench sandboxes run the same proxy pointed at fake upstreams, so the rollout
  code path matches production while holding no real credentials.
- **New registry work** (lands with Phase 2): the `inject` field, proxy config emission, Infisical
  as a `secrets gather` sink, and the `doctor` checks for CI-only tokens, proxy CA trust and
  `NODE_USE_ENV_PROXY`.
