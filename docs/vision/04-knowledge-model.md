# 04 — Knowledge model (the wiki)

## 1. Purpose

The wiki is Greenlight's memory. It answers four questions, and each one names a reader who
currently has no reliable source:

1. **What is this project for, and how do we know it still does that?** The reader is an agent
   editing a project it did not build. Today the answer lives in chat history, which is lost.
2. **What keeps this project alive, and what would kill it?** The reader is the same agent, plus
   the `doctor` and `portfolio` commands. Today the answer lives in comments in verify configs and
   the manifest.
3. **What has gone wrong before, why, and what catches it now?** The readers are every skill and
   the evolution loop. Today the answer lives in commit messages, issues and blog posts.
4. **What is true about each free tier right now?** The readers are kickoff and accounting. Today
   the answer lives partly in provider skills and partly in people's heads.

The wiki is **not** framework documentation. `docs/` and `greenlight-v2.md` remain the description
of how the framework works. Section 7 defines the boundary between them.

## 2. Two wikis, one schema

| | framework wiki | project wiki |
|---|---|---|
| location | `wiki/` in `RTrentJones/greenlight` | `wiki/` in a wrapper |
| holds | `pattern`, `fact`, `decision`, `incident`, `contract` true for any user | `intent`, `liveness`, `tool-decisions` per tool; project `pattern`/`incident`/`decision` |
| written by | maintainer pass + human PR review | the owner's agents, through skills; maintainer pass |
| ships | inside the npm package, version-locked to the CLI (ADR-04) | committed in the wrapper |
| materialized | `agent sync` → `.greenlight/wiki/framework/` (read-only, gitignored) | in place |
| ledger | yes — framework skills | yes — project skills, if any |

Both wikis use the page schemas in 08 §3, the index and log formats in 08 §4, and the lint rules in
section 5.

### 2.1 Framework wiki layout

```
wiki/
  index.md                 # generated (08 §4); sharded by cell past 60 lines
  log.md                   # append-only
  ledger.jsonl             # harness-only (08 §8)
  skill-impact.md          # rendered from ledger.jsonl
  patterns/<slug>.md
  facts/<provider>-<tier>.md       # e.g. facts/neon-free.md, facts/workers-free.md
  decisions/<slug>.md
  incidents/<yyyy-mm>-<slug>.md
  contract/c1-identity.md … contract/c7-env-invariant.md
  archive/<original path>          # archived pages keep their path under archive/
```

The page `id` is the path without `wiki/` and without `.md`, for example
`patterns/keepalive-probe-cached`. In references the folder name is singularized, as in
`pattern/keepalive-probe-cached`. Lint normalizes both forms.

### 2.2 Project wiki layout

```
wiki/
  index.md  log.md  ledger.jsonl  skill-impact.md
  portfolio.md                       # generated summary: one line per tool (cell, liveness, intent one-liner)
  patterns/  incidents/  decisions/  # project-scoped, same schemas
  tools/<name>/
    intent.md                        # IntentPage — criteria ↔ verify check ids
    liveness.md                      # LivenessPage — MUST match manifest liveness
    decisions.md                     # ToolDecisionsPage — append-only dated entries
    incidents/<yyyy-mm>-<slug>.md
  proposals/                         # drafts from `wiki propose --draft`, deleted when resolved
```

**Placement (ADR-03).** The wrapper holds the project wiki, because the wrapper is the home of the
portfolio and already owns each tool's verify config and infra. A tool repo mounted as a submodule
gets a generated pointer block in its `CLAUDE.md` (and in its `AGENTS.md` once P7 lands):

```
<!-- greenlight:wiki -->
This project is managed by Greenlight from <wrapper repo>. Before changing it, read
<wrapper>/wiki/tools/<name>/intent.md and liveness.md. Verify config and infra live in the wrapper.
<!-- /greenlight:wiki -->
```

`agent sync <name>` writes this block, and `adopt` writes it at onboarding.

## 3. Page types

The schemas are in 08 §3. This section covers what each type is for and the rules about who reads
it.

| type | one page holds | length | read by building agents? |
|---|---|---|---|
| `pattern` | one failure mode or strategy | 10–30 body lines | yes, but only `confirmed` pages, only via hooks (05 §3) |
| `fact` | one provider tier's properties and quotas | ≤ 40 lines | yes (linked from kickoff and build) |
| `decision` | one locked choice and its reason | ≤ 20 lines | yes, so they do not relitigate it |
| `incident` | a timeline, with evidence | unbounded | **no**: maintainer and humans only |
| `contract` | one app-contract clause | ≤ 30 lines | yes (build skill) |
| `intent` | a tool's purpose and acceptance criteria | ≤ 80 lines | yes, on every start (05 §3) |
| `liveness` | a tool's liveness model | ≤ 25 lines | yes, on every start |
| `tool-decisions` | dated decisions for a tool | unbounded, newest first | yes (first 40 lines) |

**Why incidents are hidden from building agents.** The paper's ablation found that giving the
working agent raw narrative lowered results (63.7 → 60.9). Incidents are where the narrative
lives. Patterns are the distilled form, and they are what agents receive.

**Why `intent` is primary.** In vibe coding, the owner's intent exists only in conversation. If it
is not written down, the next session cannot honour it, and the verify config holds checks with no
recorded reason. Every criterion maps to at least one verify check id (08 §6), so intent is
executable rather than aspirational.

## 4. Status lifecycle

```
hypothesis ──(evidence + catches + red→green)──▶ confirmed ──(new root cause)──▶ superseded
     │                                                │
     └────────────(no evidence in 180 days)───────────┴──(applies excludes current, no citing skill)──▶ archived
```

- **`hypothesis`** is the initial status of any maintainer-created or contributed pattern. A
  hypothesis is never surfaced by `wiki lookup` to building agents, and it may not be cited from
  `PURPOSE.md` (LR-11).
- **`confirmed`** requires at least one `evidence` ref and, for failures, a `catches`. At least one
  `remediation` must have `verified: true`, meaning red-to-green on a deployed artifact or an
  accepted bench delta. This status encodes the keepalive lesson that a merged fix is not a working
  fix (15 §2.1).
- **`superseded`** means the page stays, with `supersededBy` set. Agents following an old link are
  redirected by `wiki lookup`. The wiki is never rolled back (from the paper), but a wrong root
  cause can be retired.
- **`archived`** pages move to `archive/` and drop out of the index. They are not deleted.

Only the maintainer or a human may change status. A move to `confirmed` MUST be recorded in
`log.md` with the evidence that justified it.

## 5. Lint rules

`greenlight wiki lint` runs these rules, and `greenlight doctor` runs `wiki lint` as part of its own
checks. Severity is **E** (error, fails `doctor`) or **W** (warning, fails only under
`doctor --strict`). `--fix` applies the fixes marked as automatic.

| id | rule | sev | auto-fix |
|---|---|---|---|
| LR-01 | frontmatter parses and validates against its type schema (08 §3) | E | — |
| LR-02 | `id` equals the file path | E | yes |
| LR-03 | every relative link resolves; every `EvidenceRef` is well-formed (resolution is checked only with `--online`) | E | — |
| LR-04 | pattern body is 10–30 lines; fact ≤ 40; decision ≤ 20; contract ≤ 30; liveness ≤ 25; intent ≤ 80 | W | — |
| LR-05 | a `confirmed` failure pattern has `catches` and ≥1 `evidence`, and ≥1 `remediation.verified` | E | — |
| LR-06 | `superseded` has `supersededBy` pointing to an existing non-archived page | E | — |
| LR-07 | `class` is in the known set | W | — |
| LR-08 | every non-archived page is in the index; every index line points to a page | E | yes (regenerate) |
| LR-09 | the framework index is sharded by cell when it exceeds 60 lines | W | yes |
| LR-10 | no orphan pages: each pattern is linked from the index and is either cited by a skill, linked from an incident, or `hypothesis` | W | — |
| LR-11 | every `PURPOSE.md` `cites[].id` exists, is `confirmed`, and lists the skill in its `skills[]` | E | back-link yes |
| LR-12 | `PURPOSE.md` version equals `SKILL.md` version | E | — |
| LR-13 | every rule-bearing heading in `SKILL.md` is cited or marked `uncited: true` | W | — |
| LR-14 | every ledger line validates and has `writer: harness`; `skill-impact.md` matches the ledger render | E | render yes |
| LR-15 | every intent criterion has ≥1 check id, and each id exists in the tool's verify config | W | — |
| LR-16 | `liveness.md` model equals the manifest `liveness.model` | E | — |
| LR-17 | a `fact` with `verified` more than 90 days old | W | — |
| LR-18 | a `pattern` whose only verified remediation is `skill`, while its `class` is `proxy-check`, `artifact-identity`, `spec-validity` or `iac-hazard` (instruction where a mechanism would do) | W | — |
| LR-19 | `check-seam` passes on framework wiki pages: no personal domain, email, or tool name of the owner | E | — |
| LR-20 | no secret-shaped strings anywhere in either wiki (same detector as raw redaction, 11 §6) | E | — |
| LR-21 | each manifest tool has `wiki/tools/<name>/intent.md` and `liveness.md` | W (E for tools added after P0) | stub yes |

## 6. Versioning

The framework wiki is versioned **with the CLI**. It is copied into the npm package by
`cli/scripts/copy-assets.mjs`, next to the skills, and `check-plugin-sync` is extended to cover it
(ADR-04). Pattern `applies` ranges are evaluated against the installed `@rtrentjones/greenlight`
version from the wrapper's `node_modules`:

- `wiki lookup` hides patterns whose `applies` excludes the installed version.
- `doctor` reports any **open** pattern that applies to the installed version but is fixed in a
  newer one. The report reads: "pattern X is fixed in 0.9.0; you run 0.8.4". This would have
  surfaced the caret-range trap that left HeistMind on 0.8 (15 §2.1).
- DR-12 fails when `.greenlight/wiki/framework/VERSION` differs from the installed CLI version.

## 7. One home per statement

Each statement has exactly one home, and the other places link to it.

| statement kind | home | example |
|---|---|---|
| what an agent should do | `SKILL.md` | "write the verify check before the feature" |
| why, with evidence | wiki `pattern`/`decision` | why the probe must reach Postgres |
| what is true of a provider tier | wiki `fact` | Neon free compute allowance |
| how the framework works | `docs/`, `greenlight-v2.md` | how `ship` rolls back |
| what this project is for | project wiki `intent` | BAMCP's newcomer demo path |

When a pattern is seeded from a provider skill's "footguns" section, that section shrinks to a
one-line rule plus a link (15 §1). Reviewers enforce this, because lint cannot reliably detect
duplicated meaning.

## 8. Growth and pruning

At this scale the risk is stale authority, not size. A page that was true at 0.8 should not be
surfaced at 0.12. The controls are:

- `applies` ranges, which hide version-irrelevant patterns without deleting them;
- archival by maintainer pass: a pattern with no evidence newer than 180 days, no citing skill, and
  an `applies` range that excludes the current version moves to `archive/`;
- duplicate detection: `wiki lint --similar` lists page pairs whose `atRisk` and `cells` match and
  whose bodies share most of their tokens, as candidates for a merge pass. This is advisory only;
- `fact` expiry (LR-17), with a refresh procedure in the `greenlight-wiki` skill (05 §5.5).
