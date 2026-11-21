# Greenlight vision pack

This folder is the complete specification for the next stage of Greenlight. It covers the
business case, the product requirements, the architecture, the data contracts, the CLI surface,
the skill system, the knowledge (wiki) system, security, testing and the roadmap. Someone with only
this folder and the Greenlight repository should be able to implement every item without having
to ask what was meant.

Status: **partly built on the `2.0` branch; nothing released.** It supersedes
`docs/plan-wiki-skill.md` and `docs/wiki-skill-design.md`, which remain as the working drafts it
grew from.

| Milestone | State (2026-11-19) |
|---|---|
| M0 | Code done: check ids, evidence identity, schemas, roadmap check. Not released; the blocking issues #30–#37 are open and not yet linked from the M3–M6 items. |
| M1 | Code done: wiki engine, bench runner and sandbox, graders, gate, budget. The exit review recorded on 2026-11-15 (`wiki/drills/m1-2026-11-15.md`) found that the bench could not measure skill quality and that the gate's statistics did not hold at this bench size. Both were fixed afterwards: the wiki task's prompt and output schema, a second objective task family per skill with per-skill slices, an exact stratified permutation test, an `underpowered` outcome when the test cannot reach alpha, and a flaky baseline replay task that blocks the gate instead of rejecting the candidate. Neither of those two outcomes writes a ledger event. **The exit drill has not been run again**, so no record of a passed M1 drill exists. `wiki capture --manual` is not built. |
| M2 | `bench iterate`, outlet evaluation, the control arm and the review hand-off are built, and the iteration has run end to end four times with external rollouts, maintainer and proposer (`wiki/skill-impact.md`). The gate rejected three proposals to the `greenlight-wiki` skill, two as not significant at 3 runs per task and one for a replay regression. It accepted the fourth, `prop-9c74a7769477`, a pre-submit checklist in that skill (capability 0.00→0.70 and 0.00→0.50 on the two models at 5 runs per task); it was reviewed, merged by pull request #39 and recorded with `bench merged`. **Not yet shown:** replay safety was vacuous for the accepted change, because the only active val replay task was quarantined at the time, and the control arm was underpowered and has no ledger row, so the M2 exit condition on the control (06 §10.3) is unmet and no `wiki/drills/m2-*.md` record exists. That replay task is active again. A fifth iteration on 2026-11-20 took the safety-fix path (06 §5.4) for it: a liveness rule proposed for `provider-neon` moved the replay from 3/5 and 2/5 to 5/5 on the two models, and the gate still rejected the candidate because the small model lost 4 passes on the other val tasks against a non-regression bound of 2. A second baseline of the same skills, run afterwards, differed from the first by 0 and 2 passes out of 20 on the two models, which puts a loss of 4 at about 3% under no real change and the bound's own false-rejection rate near 9% per model (`bench/README-models.md`); the bound was replaced on 2026-11-20 by a one-sided exact test at alpha (gate algorithm 3, 06 §5.4), under which that evidence would not have been a regression (p 0.124). The recorded rejection stands; a sixth iteration on 2026-11-21 re-gated the same rule on fresh rollouts under algorithm 3 and accepted it (`prop-4c6ab46f720c`: replay 2/5 and 3/5 to 5/5, non-regression held over the four objective val tasks at 17 against 16 of 20 and 10 against 9 of 20 on the two models; the capability columns read 0.00 because no objective task lists `provider-neon`, and replay safety was vacuous because the only active replay was the failing target). The control arm was not gateable in either iteration (a flaky baseline replay at high blast radius). That rule was merged by pull request #40 and recorded. A seventh iteration then ran on a baseline that passes the replay 5/5 on both models: the gate rejected the control, but for no strict improvement and not for `replay-regression`, because the replay still passed 5/5 with the control's over-general rule installed (the merged specific rule outweighs it). The seventh iteration's own candidate, for `greenlight-wiki`, got no decision: its two-task slice is underpowered on the frontier model. An eighth iteration on 2026-11-21 replaced the control with a reversal of the merged `provider-neon` rule, and the gate rejected it for `replay-regression` on both models (5/5 to 0/5), so **the control condition of 06 §10.3 is met** (`control-probe-layer-overgeneral-01496bdb`, recomputable). Its proposer returned a justified `no_action`: at this baseline no skill change is decidable on the frontier model. The drill record `wiki/drills/m2-2026-11-21.md` finds five of the seven M2 criteria of 13 §3 met. A ninth iteration the same day ran on a corrected maintainer grader (it had been failing reports of what a replay did as overgeneral rules) and was the first with a decidable `greenlight-wiki` slice: a one-sentence checklist change took the frontier model from 0/5 to 3/5 on the maintainer task with no loss elsewhere, and the gate rejected it as not significant (p 0.157, `prop-9583e28bc30b`); its control was rejected for `replay-regression` again. **Still open:** the maintainer role does not yet pass `wiki/probe-layer-incidents-val` in the baseline (0 of 5 runs on the frontier model on the corrected grader, where 06 §10.3 asks for 4; the hand-off prints these graded results beside the ungraded real-wiki pass); the spec has no rule for gating the same text twice; and the dollar cost of subagent rollouts is unmeasured, because an external agent reports no usage to the harness (`bench report --metric cost` gives their count and wall-clock time). |
| M3–M7 | Not started. |

No release has been cut for any milestone. CI runs on the branch (draft pull request #38). `evo.yml`
has never run, and it refuses to run while a role or a rollout model in `bench/models.json` is
external, so today the evolution loop runs locally only. Raw rollout records (`.greenlight/raw/`)
stay on the machine that produced them; the sealed evaluation records under `wiki/evidence/eval/`
and the ledger are committed. A merge does not bump a skill's `version` frontmatter: the accepted
skill set is identified by its hash in the ledger (06 §6.1). Treat every "complete" in the pack as
"written", not "proven", until its drill record exists under `wiki/drills/`. The operator's steps
are in [bench/README.md](../../bench/README.md).

**Revision 2 (after the owner's review of `b44c8ae`).** The WikiSkill cycle is now the method that
drives every improvement from the first working milestone. It is no longer a late phase
(ADR-14). The main changes:

- **Roadmap.** Versioned phases P0–P7 are replaced by milestones M0–M7 (ADR-19), and every exit
  drill runs against that milestone's own release.
- **Evaluation.**
  - Training, validation and test evidence are separated by mechanism.
  - Baselines are content-addressed.
  - Graders observe what each skill is responsible for, including the order of actions.
  - Each outlet has its own acceptance rule.
  - Ledger stages are recorded separately.
- **Release authority** covers every production-mutation channel (18, ADR-15).
- **Retirement** is a plan-bound lifecycle (ADR-18).
- **Agent isolation** is stated as two trust models (ADR-17).
- **Contradictions fixed.** These include check ids arriving after the drills that use them, the
  removed Astro `hybrid` output, the destroy guard, the seed statuses and the single-model gate
  evidence.

## The vision in one paragraph

Greenlight manages a portfolio of projects for one owner. It keeps every project alive on free
tiers. It lets a coding agent (Claude Code first, Codex as a stretch goal) edit any project safely.
It verifies every change in beta against the deployed artifact, and it leaves release decisions
with the owner. This stage adds two things. The first is **vibe coding**: describe an app, and the
agent builds it on the free-tier accounts the owner has already set up and brings it into the
portfolio on the same terms. The second is **a knowledge system that every skill uses**. Each
skill, including the deploy-verify-promote loop itself, reads from a wiki and writes evidence back.
The wiki compiles that evidence into patterns, and skills improve only through measured, gated
changes, an approach adapted from WikiSkill (arXiv:2608.27454).

## Documents and reading order

| # | document | answers | primary reader |
|---|---|---|---|
| 01 | [brd.md](01-brd.md) | why, for whom, what success means, business requirements `BR-*` | owner, reviewer |
| 02 | [prd.md](02-prd.md) | user journeys and functional requirements `FR-*` with acceptance criteria | implementer, reviewer |
| 03 | [architecture.md](03-architecture.md) | components, planes, repos, data flows | implementer |
| 04 | [knowledge-model.md](04-knowledge-model.md) | the wiki: page types, layouts, lint rules `LR-*`, versioning, pruning | implementer, maintainer agent |
| 05 | [skill-system.md](05-skill-system.md) | the managed-skill model applied to **every** skill, the catalog, hooks | implementer, skill author |
| 06 | [evolution-loop.md](06-evolution-loop.md) | the WikiSkill cycle: training rollouts, maintainer, proposer, outlet acceptance, bench, gate, ledger stages, the first iteration | implementer |
| 07 | [cli-spec.md](07-cli-spec.md) | every new or changed command, flag, output and exit code; doctor rules `DR-*` | implementer |
| 08 | [data-contracts.md](08-data-contracts.md) | every schema: manifest, frontmatter, raw records, events, ledger, bench, JSON outputs | implementer |
| 09 | [app-contract.md](09-app-contract.md) | the self-verifying-app contract `C1`–`C7`, per-lane implementation | implementer, build skill |
| 10 | [free-tier-and-portfolio.md](10-free-tier-and-portfolio.md) | liveness models, quota accounting, portfolio view, retirement | implementer |
| 11 | [secrets.md](11-secrets.md) | one readable source, three consumers, the credential proxy | implementer |
| 12 | [threat-model.md](12-threat-model.md) | threats `T-*` and the controls that answer them | reviewer |
| 13 | [test-and-acceptance.md](13-test-and-acceptance.md) | test strategy, drills, metrics, definition of done | implementer, reviewer |
| 14 | [roadmap.md](14-roadmap.md) | milestones `M0`–`M7`: the first WikiSkill cycle, then what it drives; work breakdown, prerequisites, exit drills | owner, implementer |
| 15 | [seed-content.md](15-seed-content.md) | the initial wiki: patterns, facts, decisions, project pages for the six live tools | implementer, maintainer agent |
| 16 | [decisions-and-glossary.md](16-decisions-and-glossary.md) | decision records `ADR-*`, open questions, glossary | everyone |
| 17 | [appendix-wikiskill.md](17-appendix-wikiskill.md) | what the paper says and how each idea maps or departs | reviewer |
| 18 | [release-authority.md](18-release-authority.md) | the release authorization matrix per target × channel, the protected execution identity, approval artifacts, recovery, trust models | implementer, reviewer |

To build, read 01 → 02 → 03, then 06 §0 and §10 for the method and the first iteration, then 08
alongside whichever component you are implementing. Read 14 for the order of work, and 18 before
touching anything that deploys.

## Conventions

**Normative language.** **MUST**, **MUST NOT**, **SHOULD** and **MAY** carry their RFC 2119
meanings. Plain prose is explanatory.

**Identifiers.** Every requirement, rule and decision has a stable ID, so that tests, commits and
issues can cite it. IDs are never reused.

| prefix | meaning | defined in |
|---|---|---|
| `BR-nn` | business requirement | 01 |
| `FR-<AREA>-nn` | functional requirement; areas `KICK` kickoff, `BUILD`, `LOOP`, `PORT` portfolio, `WIKI`, `SKILL`, `EVO` evolution, `SEC` secrets, `AGENT` agent neutrality | 02 |
| `NFR-nn` | non-functional requirement | 02 |
| `LR-nn` | wiki lint rule | 04 |
| `DR-nn` | doctor rule | 07 |
| `C1`–`C7` | app-contract clauses | 09 |
| `T-nn` | threat | 12 |
| `ADR-nn` | decision record | 16 |
| `Q-nn` | open question | 16 |
| `M0`–`M7` | roadmap milestone (replaces the earlier phases `P0`–`P7`; mapping in 14) | 14 |

**Names used throughout.** These are fixed so that every document agrees.

- **Framework repo**: `RTrentJones/greenlight`. **Wrapper**: a consumer repo created by
  `greenlight init` (the live one is `RTrentJones.dev`). **Tool repo**: an adopted project's own
  repo, mounted in the wrapper as a submodule.
- **Framework wiki**: `wiki/` in the framework repo. It ships inside the npm package and is
  materialized into wrappers at `.greenlight/wiki/framework/` by `agent sync`, read-only.
- **Project wiki**: `wiki/` in the wrapper. It has portfolio-level pages at the root and one folder
  per tool at `wiki/tools/<name>/`.
- **Raw store**: `.greenlight/raw/` (gitignored), plus Tracer when it is configured.
- **Ledger**: `wiki/ledger.jsonl`, the machine source, rendered to `wiki/skill-impact.md`. It
  exists in both wikis.
- **Managed skill**: any skill under Greenlight's skill system (05). This includes the loop skill,
  `deploy-verify-promote`.
- **The loop**: the deploy-verify-promote delivery loop. **The evolution loop**: the
  maintain → propose → gate cycle that improves skills (06). The two are kept distinct throughout.

**Grounding in the current code.** Every claim about current behavior names the file it comes
from, for example `packages/loop/src/ship.ts` `StageEvent`. Where this pack changes an existing
interface, 08 gives both the current shape and the new shape.
