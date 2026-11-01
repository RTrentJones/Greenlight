# 14 — Roadmap

## 1. How this roadmap works

The WikiSkill cycle (06 §0, ADR-14) is the method that drives Greenlight's improvements. It is
also the first thing built. The roadmap therefore has two parts:

- **M0–M2 build the smallest complete cycle.** M0 closes the contracts it needs. M1 bootstraps a
  small wiki and a handful of mutation-tested, credential-free fixtures. M2 runs one complete
  iteration: training rollouts → maintainer → one atomic proposal → outlet-specific evaluation →
  ledger → owner review.
- **M3–M7 are the work that cycle is expected to drive.** Each item lists the pattern or proposal
  that motivates it. An item is started when the cycle produces or confirms that motivation, and
  it is evaluated by its outlet's acceptance rule (06 §5.6). A cycle may show that an item is
  unnecessary or should take another form. The item is then closed with that ledger reference
  (13 §6), and that counts as progress.

**The first cycle comes before portfolio operations, before the new secret platform, and before
automatic evidence capture.** None of those is a prerequisite for evaluating local fixtures. The
first fixtures run on a laptop or a CI runner with no provider accounts and no secrets.

**No milestone promises a version number (ADR-19).** A release is cut, and numbered, when a
milestone's items merge. Every exit drill runs against a clean installation of that milestone's
own release, using only the prerequisites listed for it (13 §1, principle 6). No drill may rely on
an unpublished command, a later schema or a later milestone's tooling.

**No exit criterion requires an accepted proposal.** An iteration passes when it reaches a
reviewed, reproducible decision. A justified rejection or `no_action` passes (ADR-14).

**Release-authority gaps block deployment work, not the cycle.** M0 records the gaps in 18 as
blocking issues. Every deployment-related item before M5 links to them. That covers anything that
deploys beyond a local preview or a beta in the separate beta account. The cycle itself (M1–M2)
deploys nothing.

### 1.1 Mapping from the earlier phases

| earlier phase (first draft) | where its work lives now | why it moved |
|---|---|---|
| P0 memory | M1 (wiki engine, cycle seeds), M3 (project wikis, PURPOSE.md, context) | the cycle needs a minimal wiki first; project memory is an expected outlet of the cycle |
| P1 contract in templates | M4 (astro), M6 (other lanes) | one creation path first, proven end to end |
| P2 vibe-code flow | M4 | depends on the Astro runtime design (09) and beta-only provisioning (18) |
| P3 portfolio | M6 (portfolio, quota), M5 (retirement) | not needed to evaluate fixtures; retirement needs the plan-bound lifecycle (ADR-18) |
| P4 secrets | M5 | one credential integration is prototyped with an explicit trust model before a general platform is chosen |
| P5 learning from failures | M1–M3 | maintainer and ledger are part of the first cycle; automatic capture is not |
| P6 evolution loop | M0–M2 (first cycle), M6 (scale) | the method comes first (ADR-14) |
| P7 Codex | M7 | unchanged, still a stretch goal |

## 2. Dependency graph

```
M0 contracts ──▶ M1 wiki + fixtures ──▶ M2 first iteration ──┬──▶ M3 cold edits + incident prevention ──┐
                                                              │                                        ├──▶ M6 scale
                                                              └──▶ M4 one creation path ───────────────┤
                                                                         │                             │
                                                                         └──▶ M5 release authority, ───┘
                                                                              retirement, credentials
M7 Codex (stretch) ◀── M3 (portable skills, CLI-first queries)
```

- M3 and M4 can proceed in parallel after M2.
- M5 depends on M4, because the creation path is the first thing that needs a protected production
  path. Its blocking issues exist from M0.
- M6 depends on M2 having shown **discrimination** (the control rejected) and an affordable cost
  per iteration (01 §5).

## 3. Sequencing summary

| milestone | goal | items | prerequisites | exit drill (13 §3) |
|---|---|---|---|---|
| M0 | contracts the first iteration needs | 8 | — | contracts close |
| M1 | a small wiki and fixtures that discriminate | 9 | M0 | fixtures discriminate |
| M2 | one complete WikiSkill iteration | 5 | M1 | first iteration, with control arm |
| M3 | cold edits and incident prevention, driven by the cycle | 9 | M2 | cold edit, two tools |
| M4 | one creation path: Astro + Workers + D1, no domain, beta only | 9 | M2 (M3 for context tooling) | newcomer drill |
| M5 | release authority, retirement and credentials, through evaluated proposals | 8 | M4 | release-authority and isolation suite |
| M6 | scale the established loop | 9 | M3, M4, M5; M2 discrimination shown | scale |
| M7 | Codex parity (stretch) | 4 | M3 | Codex cold edit and newcomer |

---

## M0 — Contracts for the first iteration

**Goal.** Every schema and interface the first iteration touches is closed, validated and tested,
so that M1 and M2 can be built without inventing contracts on the way. The executable boundaries
of every later milestone are fixed.

**How the cycle selects this work.** The cycle cannot run yet. M0 is the only milestone whose
items are fixed in advance, and they are limited to what 06 §10 requires.

### M0 items

**M0-01 — Verify check `id` and the `meta` export.** (FR-BUILD-03)
- Files: `packages/verify/src/types.ts`, `validate.ts`, `index.ts`, `export.ts`, and the
  verify-config loader in `cli/src/commands/verify.ts`.
- Change: accept `id` on `VerifySpecBase` and `ApiCheck` (08 §6), and reject duplicates. Copy the id
  to `VerifyCheck` and to `eval.check_id`. The loader preserves the named `meta` export. A
  function-form config is evaluated once per context (`preview`, `beta`, `prod`) to report its
  invariant coverage.
- Tests: 13 §2.1, verify `id` and `meta` row. The regression case is the current
  `unsupported field "id"`.

**M0-02 — Evidence identity and the raw record.** (FR-WIKI-09, FR-LOOP-05)
- Files: `packages/shared/src/evidence.ts` (new), plus `packages/loop/src/ship.ts` for the
  `StageEvent` fields only.
- Change: implement `EvidenceIdentity` (08 §5.1): source repo, wrapper/config revision,
  environment, run, attempt, change identity, `dirty` and `treeHash`, artifact identity,
  `skills.installed` and `skills.used` (`"unknown"` when the agent cannot report it). Implement
  `RawRecord` (08 §5.2). `StageEvent` gains `rawId` and `skills` as optional fields only.
- Tests: 13 §2.1; the dirty-tree and attempt cases of 13 §2.9.

**M0-03 — Task, baseline and evaluation schemas.** (FR-EVO-11, FR-EVO-12, FR-EVO-17)
- Files: `packages/wiki/src/schema/bench.ts` (new package skeleton, 03 §3).
- Change: implement `TaskSpec` with every kind (`capability`, `replay`, `loop`, `wiki`, `routing`,
  `portfolio`, `mechanism`), grader kinds and `state` (`pending`, `active`, `quarantined`).
  Implement `TrajectoryEvent` (08 §10.2), `BaselineIdentity` (08 §10.3), `EvaluationRecord`
  (08 §10.4) and `Budget` (08 §10.5).
- Tests: 13 §2.1, `TaskSpec` row.

**M0-04 — Ledger events.** (FR-EVO-06, FR-EVO-15)
- Files: `packages/wiki/src/schema/ledger.ts`.
- Change: one append-only event per stage (`no-action`, `candidate-rejected`,
  `candidate-accepted`, `merged`, `released`, `verified-in-production`, `withdrawn`, `spend`,
  `release-check`). Each event carries `path` (`standard`, `safety-fix` or `neutral`) and
  `control`. Gate evidence carries one result per model and mode (08 §8).
- Tests: stage-order and single-result-rejection cases (13 §2.1, §2.7).

**M0-05 — Maintainer and proposer I/O.** (FR-EVO-03)
- Files: `packages/wiki/src/schema/io.ts`.
- Change: `MaintainerOutput` (08 §9.1), and `ProposerOutput` with multi-file patches, where each
  edit names `SKILL.md`, `PURPOSE.md` or a template path (08 §9.2).
- Tests: 13 §2.1, multi-file patch row.

**M0-06 — Pattern schema with `affects` and `relevance`.** (FR-WIKI-08)
- Files: `packages/wiki/src/schema/pages.ts`.
- Change: 08 §3. `affects` and `relevance` replace `applies`. Decision and contract pages carry
  `skills[]`, so that LR-11 back-links hold for every cited page.
- Tests: 13 §2.1, page-schema row.

**M0-07 — Executable boundaries.**
- Files: this document, and `docs/vision/13-test-and-acceptance.md`.
- Change: confirm that each milestone's drill uses only its listed prerequisites. A CI script,
  `scripts/check-roadmap-prereqs.mjs`, parses the "prerequisites" and "drill uses" lists below and
  fails if a drill names a command or schema introduced in a later milestone.
- Tests: the script runs in `check-all`.

**M0-08 — Release-authority blocking issues.** (FR-LOOP-06, FR-SEC-05)
- Files: none in the repo. The item creates GitHub issues on the framework repo, labelled
  `blocks-deploy`, one per row group of 18's matrix. Every deployment-related item in M3–M6 links
  to them.

**Prerequisites:** none. **Drill uses:** `pnpm test`, the contract fixtures. **Exit drill:**
13 §3 M0.

---

## M1 — Bootstrap the wiki and the evaluation fixtures

**Goal.** The minimum wiki and bench needed for one iteration exist and are shown to discriminate.
Everything is local and credential-free, and it starts from the existing skills and the existing
framework tests.

**How the cycle selects this work.** The items are fixed by 06 §10.1. The seed content is limited
to the patterns that iteration needs, plus the evidence that their remediations are verified.

### M1 items

**M1-01 — Minimal `packages/wiki`.** (FR-WIKI-01, FR-WIKI-04)
- Modules: `parse`, `ids`, `lint` (LR-01, LR-02, LR-03, LR-05, LR-06, LR-08, LR-11, LR-12, LR-14,
  LR-19, LR-20 only), `patch` (the atomic op engine), `ledger` (append and render) (03 §3).
- Tests: 13 §2.2. Lint fixtures cover only the rules listed here. The remaining rules land in M3.

**M1-02 — Seed the cycle's wiki.** (FR-WIKI-10)
- Content: the 3–5 `confirmed` patterns of 15 §8, each with a verified remediation and lint-clean:
  `keepalive-probe-misses-postgres` (its 0.9 deployment was verified by hash),
  `settle-greenlights-previous-deploy`, `dcr-disabled-silently`, `unplanned-compute-replacement` and
  `spec-typo-disables-assertion`. Add the hypotheses `neon-never-sleeps`, `probe-touches-wrong-layer`
  and `keepalive-probe-cached`, and the two incident pages (15 §2, §7). Seed status follows 15. Framework prose is anonymized, and evidence links are kept
  through the LR-19 exception.
- Tests: the seed passes `wiki lint --strict` (13 §2.2, "seeds pass actual lint").

**M1-03 — Fixture tools and fake stores.**
- Files: `bench/fixtures/supabase-shaped/`, `bench/fixtures/neon-shaped/` (fake stores that count
  queries and model idle timers), `bench/fixtures/loop-tool/`.
- Tests: unit tests for the fakes' idle and query accounting.

**M1-04 — First tasks, graders and mutants.** (FR-EVO-02, FR-EVO-12)
- Tasks:
  - `replay/keepalive-probe-reaches-store`;
  - `replay/idle-probe-leaves-store-asleep`;
  - `wiki/probe-layer-incidents` (maintainer grader);
  - `loop/fixture-preview-before-push` (trajectory grader).

  Each task has train and val variants (06 §10).
- Graders live in `bench/graders/<taskId>/` and mutants in `bench/mutants/<taskId>/`. The mutants
  include both overgeneralized rules and the historical faults.
- Tests: `bench check-graders` (13 §2.7).

**M1-05 — Bench runner with isolated rollout and grading.** (FR-EVO-01, FR-EVO-10)
- Files: `cli/src/commands/bench.ts`, `packages/wiki/src/bench/{runner,sandbox,shims,grade}.ts`,
  `packages/wiki/src/llm/{gemini,react}.ts` (06 §4.8), `bench/models.json`, and
  `bench/runner/Dockerfile`.
- Model provider: the Gemini free tier, through the Greenlight harness (ADR-20). This needs a
  `GEMINI_API_KEY` from Google AI Studio, with no billing. It is the only credential the bench
  uses.
- Change:
  - the rollout container, unprivileged and with no grader mount;
  - trajectory shims that write through a channel the agent cannot edit;
  - process-tree kill, then a separate grading container over a read-only mount;
  - isolation mode only (production mode lands in M3).
- Tests: the rollout isolation and trajectory cases of 13 §2.7.

**M1-06 — Training rollouts and baselines.** (FR-EVO-09, FR-EVO-11)
- Change: `bench run --split train` under the accepted skill set, keyed by `BaselineIdentity`.
  `bench run --split val` writes baselines. Invalidation follows 06 §1.5.
- Tests: the baseline invalidation case of 13 §2.7.

**M1-07 — Maintainer and proposer bundles with split isolation.** (FR-WIKI-06, FR-EVO-03,
FR-EVO-04, FR-EVO-10)
- Files: `cli/src/commands/wiki.ts` (`ingest`, `propose`, `read`, `traces`).
- Change: bundles built from an allow-list (06 §1.4), with prompts as in 06 §2.2 and §3.3. The
  sandbox holds the bundle only.
- Tests: the split isolation case of 13 §2.7.

**M1-08 — Gate, policy table and recompute.** (FR-EVO-05, FR-EVO-17)
- Files: `packages/wiki/src/bench/gate.ts`.
- Change: 06 §5.1–§5.4 and §5.6, writing `EvaluationRecord`s, and
  `bench gate --recompute <hash>`.
- Tests: policy boundary vectors (13 §2.8) and the recompute case (13 §2.7).

**M1-09 — Per-gate budget caps.** (FR-EVO-18)
- Change: `perGateMaxUsd` and `perGateMaxRollouts` from `bench/budget.json`. Spend is written as
  ledger `spend` events. The `greenlight-evo` concurrency group is declared in a workflow stub.
  Monthly budgets land in M6.
- Tests: 13 §2.7, budget case.

**Prerequisites:** M0. **Drill uses:** `bench check-graders`, `bench run`, `wiki lint`, docker,
two model ids in `bench/models.json`. No provider accounts. **Exit drill:** 13 §3 M1.

---

## M2 — The first complete WikiSkill iteration

**Goal.** One iteration of 06 §10 runs end to end and produces a reproducible, owner-reviewed
decision. The control arm shows that the evaluator can refuse a plausible but wrong lesson.

**How the cycle selects this work.** This milestone *is* the cycle. Its output decides what M3 and
M4 start with.

### M2 items

**M2-01 — `ITERATE` orchestration.** (FR-EVO-09)
- Files: `cli/src/commands/bench.ts` (`bench iterate`), and `.github/workflows/evo.yml` with
  `workflow_dispatch` only and concurrency group `greenlight-evo`.
- Change: 06 §1.3 steps 1–5, with the ledger events and review hand-off of step 5.

**M2-02 — Outlet evaluation for the first iteration's likely outlets.** (FR-EVO-14)
- Change: the skill rule (controlled rollouts), the doctor rule and the mechanism rule (a `repro`
  grader against base and candidate commits), and the verify rule (rejection of the faulty
  artifact). The template rule waits for M4, since no template is in play yet.

**M2-03 — Control arm.** (FR-EVO-19)
- Files: `bench/controls/probe-layer-overgeneral.json`, a hand-written skill patch labelled
  `control`.

**M2-04 — Review hand-off.**
- Change: a PR for skill and template outlets, or an issue for mechanism, doctor and verify. Each
  carries the ledger event, the evaluation record hash and the recompute command. The owner's
  review is recorded as a ledger annotation.

**M2-05 — Run the iteration.**
- Run it, record it in `wiki/drills/m2-<date>.md`, and render `skill-impact.md`.

**Prerequisites:** M1. **Drill uses:** `bench iterate`, `bench gate --recompute`, and the M1
fixtures. **Exit drill:** 13 §3 M2. Acceptance of the real proposal is not required.

**After M2.** The ledger from M2 decides where M3 and M4 start. For example, if the proposal
routed to `doctor`, DR-21 and DR-22 are evaluated first in M3. If it was `no_action`, M3 begins
with the cold-edit items.

---

## M3 — Cold edits and incident prevention, driven by the cycle

**Goal.** An agent that has never seen a project can change it safely, and known incidents stay
prevented. The cycle evaluates each item.

**Motivation.** These patterns are expected to motivate the items, and each is confirmed or
refuted by the cycle:
- `fix-merged-not-running`;
- `preview-prod-path-drift`;
- `ok-before-success`;
- `freshness-across-producers`;
- `dcr-disabled-silently`;
- the M2 outcome.

### M3 items

**M3-01 — `wiki context` and `wiki lookup`.** (FR-LOOP-01, FR-LOOP-02, FR-WIKI-05, FR-LOOP-08)
- Change: the on-start bundle and the failure lookup keyed to check ids, with failure-report links.
- Outlet evaluated: `mechanism`, by a `repro` on a fixture with a failing check.

**M3-02 — Criteria tooling and project wikis for the six live tools.** (FR-BUILD-04, FR-WIKI-03,
FR-WIKI-10)
- Change: `intent.md`, `liveness.md` and decisions for the six tools (15 §6), mapped to check ids.
  The tool-repo pointer block.
- Outlet evaluated: `verify` for each new check id, by rejection of a faulty artifact.

**M3-03 — PURPOSE.md for every existing skill.** (FR-SKILL-01, FR-SKILL-02, FR-SKILL-07)
- Change: sidecars citing confirmed pages. Provider-skill footgun sections shrink to rules plus
  links.

**M3-04 — Manual and minimal redacted capture.** (FR-LOOP-03, FR-SEC-06)
- Change:
  - `wiki capture --manual` records drill and incident evidence by hand (03 §5.3);
  - `wiki capture --retain` and `--export` keep minimal evidence in `wiki/evidence/` (08 §5.3);
  - a minimal redacted capture from `preview` and `verify` with the identity of 08 §5.1.

  Automatic sinks (Tracer, the ingest POST) wait for M6.
- Tests: the planted-secret test (13 §2.6) and the identity cases (13 §2.9).

**M3-05 — The temporary human-reviewed skill-version path.** (FR-SKILL-03)
- Change: 05 §4. It applies until a skill has 3 active bench tasks, and it writes a `neutral` or
  `safety-fix` ledger event with the reviewer's reason.

**M3-06 — Production-mode evaluation.** (FR-EVO-13)
- Change: `--mode production` with a pinned wiki snapshot. The loop skill's slice is baselined in
  both modes.

**M3-07 — Routing and repro graders; held-out release check.** (FR-EVO-12, FR-EVO-16)
- Change: `routing` tasks for skill descriptions, generalized `repro` graders, and 06 §5.7 in the
  release workflow.

**M3-08 — Remaining lint rules and local advisories.** (FR-WIKI-01, FR-WIKI-08)
- Change:
  - LR-04, LR-07, LR-09, LR-10, LR-13, LR-15 to LR-18 and LR-21;
  - `doctor --advisories`, reporting only locally known fixes (DR-33);
  - the opt-in `greenlight advisories` feed, which fetches the newest release's wiki index.

**M3-09 — Framework wiki packaging.** (FR-WIKI-02)
- Change: copy the wiki into the npm package and materialize it with `agent sync`. DR-12 and DR-13
  apply.

**Prerequisites:** M2. **Drill uses:** `wiki context`, `wiki capture --manual`, `preview`,
`verify`, and the live wrapper on the M3 release. **Exit drill:** 13 §3 M3.

---

## M4 — One creation path: Astro + Workers + D1, no domain, beta only

**Goal.** A newcomer with free accounts and no domain goes from an idea to a working, stateful
beta. Nothing production-side is created before an approval.

**Motivation.** Expected patterns: `preview-prod-path-drift`, `supabase-pause` (for the cell
choice), and the cycle's evidence from M3. The newcomer drill's raw records then become training
evidence, and its scripted form becomes the capability task `cap/astro-workers-d1-vote`.

### M4 items

**M4-01 — Astro runtime on the Cloudflare adapter.** (FR-BUILD-02, FR-KICK-06)
- Change: the exact runtime in 09:
  - `@astrojs/cloudflare` and a server output (the removed `hybrid` mode is not used);
  - extensionless endpoints at `/__version`, `/health/live` and `/health`;
  - D1 bindings, migrations and local emulation;
  - SHA injection at deploy.
- The adapter in `packages/adapters` builds and deploys the Worker output, not a static `dist/`.
- Outlet evaluated: `template`, by generated-app tests plus template mutants (06 §5.6).

**M4-02 — No-domain mode.** (FR-KICK-04)
- Change: `init` without a domain; `resolveUrl` for `workers.dev` (08 §1.3); `doctor` skips
  apex-only checks; preview URLs disabled for workers.dev deployments of private routes (09).

**M4-03 — Beta-only provisioning in a separate beta account.**
- Change: per 18, the beta job creates beta D1 and Workers in the beta account. No production
  resource is created by any job before an approval.
- This item links to the M0 blocking issues. Production remains unreachable until M5.

**M4-04 — Liveness in the manifest, and doctor rules.** (FR-PORT-02, FR-PORT-03)
- Change: `liveness`, DR-20 to DR-24 and DR-26, evaluated by fixtures (`doctor` outlet).

**M4-05 — Minimal `accounts`.** (FR-KICK-01, FR-KICK-02)
- Change: configured and verified providers, plus available cells. Quota fields are `unknown`
  until M6.

**M4-06 — Kickoff and build skills.** (FR-SKILL-04, FR-KICK-03, FR-KICK-05, FR-BUILD-01,
FR-BUILD-05)
- Change: managed from creation, with PURPOSE.md, hooks and blast radius. They use the temporary
  path until they have 3 active bench tasks.

**M4-07 — Identity, auth and persistence checks for the vote app.** (FR-BUILD-06)
- Change: the template's contract checks plus the scenario's criteria:
  - a vote persists across independent clients;
  - a duplicate vote is rejected;
  - an unidentified voter is rejected.

**M4-08 — `cap/astro-workers-d1-vote` capability task.**
- Change: a hidden grader and mutants (auth removed, unique constraint dropped, stale sha), added
  as `pending`.

**M4-09 — First beta handoff.** (FR-KICK-08)

**Prerequisites:** M2, and M3-01 for `wiki context`. **Drill uses:** the M4 release, a new
Cloudflare account pair (beta and prod), and a GitHub account. **Exit drill:** 13 §3 M4.

---

## M5 — Release authority, retirement and credentials, through evaluated proposals

**Goal.** Human release control holds over every production mutation, retirement deletes exactly
what was authorized, and agents work with credentials under a declared trust model.

**Motivation.** Expected patterns: `unplanned-compute-replacement`, `neon-state-rm`, and the
review findings recorded as the M0 blocking issues. Each item below is submitted as a proposal and
evaluated by its outlet. Most are mechanism outlets with `repro` graders drawn from 13 §4.

### M5 items

**M5-01 — Protected execution identity and the approval artifact.** (FR-LOOP-06, FR-SEC-05)
- Change: 18.
  - Production credentials exist only for the protected identity's jobs.
  - The owner approval artifact is bound to the tool and sha.
  - `greenlight approve` is the owner-side command. It runs outside any agent sandbox.
  - DR-34 and DR-35.
- Evaluated by: 13 §4.1.

**M5-02 — Every channel in the matrix.**
- Change: promotion by name and numeric id; Git refs through every API; Cloudflare prod script
  uploads, which are unavailable to the agent because beta lives in a separate account; Vercel
  production deploys from the protected job only; OCI deploys gated on approval
  (`decision/oci-direct-to-prod` is superseded); infra apply.
- Evaluated by: 13 §4.1.

**M5-03 — Recovery from the last approved artifact.**
- Change: remediate workflows redeploy only the last approved immutable artifact (DR-36).

**M5-04 — Promotion policy as an owner-approved edit.** (FR-LOOP-07)
- Change: DR-32. A policy commit grants nothing until the owner approves it.

**M5-05 — Retirement lifecycle.** (FR-PORT-04)
- Change: the inventory, ownership verdicts, data disposition, plan-bound deletion authorization,
  `active → retiring → retired`, and explicit Wrangler and adopted outcomes (10, ADR-18). The guard
  in `init.ts` gains the authorized-set exception and keeps every other refusal.
- Evaluated by: 13 §4.3.

**M5-06 — Trust models.** (FR-SEC-04)
- Change: model A, an isolated sandbox with enforced egress; model B, documented local
  convenience. `agent run` and `doctor` state the model.
- Evaluated by: 13 §4.2.

**M5-07 — One credential integration, prototyped.** (FR-SEC-01, FR-SEC-03, FR-SEC-08)
- Change: one integration chosen by the cycle's proposal, either Infisical Agent Proxy or the
  Worker reverse proxy. It is implemented with the typed policy language (08 §12) and tested
  against every client the skills use (11). The general fallback and `--sink` default are decided
  from its evidence, not in advance (Q3).
- Evaluated by: the typed-policy cases of 13 §2.6.

**M5-08 — CI-only tokens and secrets settings.** (FR-SEC-02, FR-SEC-07)
- Change: DR-30 and `SecretsSettings` (08 §13).

**Prerequisites:** M4. **Drill uses:** the M5 release, a scratch wrapper, the beta and prod
accounts, and a trust-model-A sandbox. **Exit drill:** 13 §3 M5.

---

## M6 — Scale the established loop

**Goal.** Broaden coverage once the small loop has shown reliable discrimination and an
affordable cost per iteration (01 §5). Until both hold, M6 does not start.

### M6 items

- **M6-01 — Other lanes' templates and contract** (next, mcp workers and oci, agent).
  (FR-BUILD-02, FR-KICK-06) Each lane is evaluated by the template rule.
- **M6-02 — Portfolio view.** (FR-PORT-01, FR-PORT-06)
- **M6-03 — Quota accounting.** (FR-PORT-05, FR-KICK-07) Observations keyed by account, resource,
  quota, period and unit (08 §11.1). Observed, declared and estimated values stay separate, and
  unknown is never treated as safe. Tested by 13 §2.10.
- **M6-04 — Broader bench.** Capability briefs per available cell, routing and portfolio tasks.
  Test-split rotation as in 06 §4.1.
- **M6-05 — Monthly budgets and scheduled monitoring.** (FR-EVO-18, FR-EVO-07) Monthly caps,
  persistent `spend` events, `evo-monitor.yml`, and the `greenlight-evo-alarm` label.
- **M6-06 — Automatic capture sinks.** (FR-WIKI-09, FR-LOOP-03) Tracer and the ingest POST.
  Automated cold-edit metrics.
- **M6-07 — Contribution path.** (FR-WIKI-07)
- **M6-08 — Advisory feed hardening.** Signature and version pinning for `greenlight advisories`.
- **M6-09 — Remaining provider skills' bench slices.**

**Prerequisites:** M3, M4, M5, and the M2 discrimination and cost metrics. **Exit drill:**
13 §3 M6.

---

## M7 — Codex parity (stretch)

- **M7-01** — `agent sync` writes `.agents/skills/` and `AGENTS.md`. (FR-AGENT-04)
- **M7-02** — DR-14 covers the third copy.
- **M7-03** — The Codex cloud secrets path, through CI `ship` or the proxy. (FR-AGENT-05)
- **M7-04** — Codex rollouts in the bench runner (`codex exec`), recorded as a separate agent in
  the baseline identity.

**Prerequisites:** M3. **Exit drill:** 13 §3 M7.

## 4. Risks across the roadmap

| risk | mitigation |
|---|---|
| The first fixtures are too few to discriminate | The control arm is the test of discrimination. If it is not rejected, M2 fails and the fixtures are extended before anything else |
| The cycle produces only `no_action` | That is a valid result. It means either the skills are adequate for these tasks or the tasks are too easy, and the ledger says which. M3 and M4 items still proceed when motivated by confirmed patterns |
| Cost per iteration is too high | Per-gate caps from M1; the cost is reported every iteration; M6 is held until the cost is acceptable |
| Release authority work stalls deployment features | Beta-only work in a separate account proceeds; production stays unreachable until M5 by design |
| The Astro adapter version changes | 09 pins the adapter major version, and M4-01's template tests catch breakage |
