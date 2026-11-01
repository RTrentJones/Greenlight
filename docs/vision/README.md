# Greenlight vision pack

This folder is the complete specification for the next stage of Greenlight. It covers the
business case, the product requirements, the architecture, the data contracts, the CLI surface,
the skill system, the knowledge (wiki) system, security, testing and the roadmap. Someone with only
this folder and the Greenlight repository should be able to implement every item without having
to ask what was meant.

Status: **SPECIFICATION, not built.** It supersedes `docs/plan-wiki-skill.md` and
`docs/wiki-skill-design.md`, which remain as the working drafts it grew from.

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
| 06 | [evolution-loop.md](06-evolution-loop.md) | maintainer, proposer, outlets, bench, gate, ledger | implementer |
| 07 | [cli-spec.md](07-cli-spec.md) | every new or changed command, flag, output and exit code; doctor rules `DR-*` | implementer |
| 08 | [data-contracts.md](08-data-contracts.md) | every schema: manifest, frontmatter, raw records, events, ledger, bench, JSON outputs | implementer |
| 09 | [app-contract.md](09-app-contract.md) | the self-verifying-app contract `C1`–`C7`, per-lane implementation | implementer, build skill |
| 10 | [free-tier-and-portfolio.md](10-free-tier-and-portfolio.md) | liveness models, quota accounting, portfolio view, retirement | implementer |
| 11 | [secrets.md](11-secrets.md) | one readable source, three consumers, the credential proxy | implementer |
| 12 | [threat-model.md](12-threat-model.md) | threats `T-*` and the controls that answer them | reviewer |
| 13 | [test-and-acceptance.md](13-test-and-acceptance.md) | test strategy, drills, metrics, definition of done | implementer, reviewer |
| 14 | [roadmap.md](14-roadmap.md) | phases `P0`–`P7`, work breakdown, dependencies, exit criteria | owner, implementer |
| 15 | [seed-content.md](15-seed-content.md) | the initial wiki: patterns, facts, decisions, project pages for the six live tools | implementer, maintainer agent |
| 16 | [decisions-and-glossary.md](16-decisions-and-glossary.md) | decision records `ADR-*`, open questions, glossary | everyone |
| 17 | [appendix-wikiskill.md](17-appendix-wikiskill.md) | what the paper says and how each idea maps or departs | reviewer |

To build, read 01 → 02 → 03, then 08 alongside whichever component you are implementing. Read 14
for the order of work.

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
| `P0`–`P7` | roadmap phase | 14 |

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
