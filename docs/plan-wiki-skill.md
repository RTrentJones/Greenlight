# Plan — Greenlight as a wiki skill

Status: **PLAN** (not built). Design rationale, and the revisions it makes to the phases below, are in
[wiki-skill-design.md](wiki-skill-design.md); where the two differ, the design doc wins. Source: Tang et al., *WikiSkill: Compiling Agent Experience into
Persistent Knowledge for Skill Evolution* (arXiv:2608.27454, Aug 2026).

## Goal

Anyone should be able to point a coding agent at an empty directory and say "build me X on
Greenlight". The agent then kicks off a repo, wires it to free-tier providers only, and builds a web
app that can verify itself. The app ships through the deploy → verify → promote loop, and the agent
gets an objective pass/fail result at every step.

The skills that guide the agent should get better as they are used. Each failure in the field
should become a written pattern, and each pattern should be able to justify a measured skill edit.
That is the part this paper supplies.

## What the paper contributes, and what it does not

WikiSkill splits agent experience into three layers, which live as three directories:

- **`raw/`** holds immutable execution traces: reasoning, tool calls, tool outputs and answers.
- **`wiki/`** is compiled knowledge. It contains `patterns/*.md` (one failure mode or successful
  strategy per page, 10–30 lines, with root cause and workaround), `index.md` (a catalog with one
  line per pattern: problem, root cause, fix), `logs.md` (a chronological log) and `skill-impact.md`.
  The last file is an audit trail of every skill proposal, with its diff, validation score and
  whether it was accepted. **The harness writes this file, not the agent.**
- **`skills/<name>/`** holds `SKILL.md` and `PURPOSE.md`. `PURPOSE.md` maps the skill back to the
  wiki patterns that motivated it.

Four roles run the loop:

1. The **Inference Agent** does the tasks with the current skills.
2. The **Wiki Maintainer** reads the full wiki plus a sample of traces (at most 5 failing and 3
   passing, each truncated to 15k characters). It does root-cause analysis and emits a JSON edit
   set: `create_patterns`, `update_patterns` (exact-substring `append` / `replace` /
   `insert_after`), a full `update_index`, and `append_log`.
3. The **Skill Proposer** reads the index and `skill-impact.md` first, so it does not repeat a
   rejected idea. It then reads at least 4 traces through `read_file` and emits exactly one atomic
   change: create one skill, patch one skill, or `no_action`.
4. **Gating and Rollback** accepts a proposal only if the validation score strictly improves.
   **Skills roll back; the wiki never does.**

The results justify adopting this. Across five benchmarks and five models, WikiSkill beat the best
prior skill-evolution method by 3–12 points. Giving the proposer wiki access was worth +15 points on
Gemini-3.5-Flash. Two findings shape the design below:

- Letting the *inference* agent read the wiki during evolution rollouts **lowered** scores (63.7 →
  60.9). The likely cause is that the agent solves tasks from the wiki instead of the skills, which
  makes the traces less informative about the skills.
- Skills transfer across models, but not always in a good direction. One small model's spreadsheet
  skills cut a large model from 50.5 to 18.1.

The paper does not give us everything we need. Its setting is an offline benchmark with
train/validation/test splits and an automatic score. Greenlight has no benchmark, so **the main new
work is building one** (Phase 4). The paper also has no lint, query or pruning operations, and its
limitations section names pruning as missing. Those parts of this plan are our own additions, and
they are marked as such.

## The mapping onto Greenlight

Greenlight already has most of the substrate, which is why this fits well:

| WikiSkill | Greenlight today | Gap |
|---|---|---|
| raw traces | `ship`/`preview` emit `StageEvent` JSON lines (`--events <file>`, ingest POST); `verify --json` emits an OTel-shaped result; `logsOnFailure` captures telemetry | No single place a run lands, no secret redaction, and the agent's own transcript is not linked |
| validation score | `verify(baseUrl, spec)` pass/fail, `eval` 0..1 scores, local `preview` gate | No task suite to score *skills* against (only *tools*) |
| skill version in results | `skillVersion()` already stamps `deploy-verify-promote`'s `version:` on stage events "so skill-text changes can be compared against gate outcomes" | Covers only one skill; nothing reads it back |
| skills layer | `.claude/skills/*` mirrored to `plugin/skills` (`check-plugin-sync`) | No `PURPOSE.md`, no kickoff/build skills |
| wiki layer | Knowledge is scattered across `docs/`, provider skills' "footguns" and commit messages (e.g. #26 Gemini overload fallback, #27 replacement guard, #28 keepalive `cacheTtl`) | Nothing compiled, indexed or linked to skills |

## Target layout

The **framework wiki** is curated, lives in the Greenlight repo, and ships to everyone. A **project
wiki** is local to each consumer repo and feeds the framework wiki through reviewed PRs.

```
Greenlight/
  wiki/                                   # framework wiki (new; mirrored to plugin/wiki)
    index.md                              # one line per page: [name](path) — problem · root cause · fix
    log.md                                # append-only, one entry per maintainer pass
    skill-impact.md                       # HARNESS-WRITTEN: proposal, target, diff, score, outcome, model
    patterns/<slug>.md                    # 10–30 lines (paper rule)
    free-tier/<provider>.md               # [our addition] fact pages: limits, card?, idle behavior, verified-on date
  .claude/skills/
    greenlight-kickoff/{SKILL.md,PURPOSE.md}    # new
    greenlight-build/{SKILL.md,PURPOSE.md}      # new
    greenlight-wiki/{SKILL.md,PURPOSE.md}       # new — maintainer + proposer procedures
    deploy-verify-promote/{SKILL.md,PURPOSE.md} # existing + PURPOSE.md
    provider-*/{SKILL.md,PURPOSE.md}            # existing + PURPOSE.md
  bench/                                  # new — the validation suite (Phase 4)
    tasks/<task-id>/{brief.md, grader.verify.config.ts, cell.json}
    splits.json                           # train / val / test task ids

<consumer repo>/
  .greenlight/raw/<run-id>/               # gitignored, immutable: events.jsonl, verify.json, logs.txt, transcript ref
  wiki/                                   # committed project wiki, same schema; patterns can be upstreamed
```

**Pattern page schema.** The paper fixes only the length and content. The frontmatter is our
addition, and it exists so `wiki lint` can check pages mechanically.

```markdown
---
kind: failure | strategy
cells: [workers/d1, agent/workers/kv]     # lane/target/data cells it applies to
evidence: [raw:2026-11-01T1203-ab12, pr:RTrentJones/greenlight#28]
skills: [provider-cloudflare]             # skills whose PURPOSE.md cite it
verified: 2026-11-01
---
# keepalive-probe-cached
**Symptom** … **Root cause** … **Fix / workaround** … **How verify catches it** …
```

## The three new skills

### `greenlight-kickoff`: from an empty directory to a green first ship

This skill handles the "anyone, free tier" promise. It should get a user from an empty directory to
a verified first deploy with only free accounts. Its procedure would be:

1. **Choose a cell.** Ask what the user is building, then choose a lane × target × data cell. The
   choice comes from a free-tier decision table that the skill links from `wiki/free-tier/*`. It
   should not be restated inside the skill, because limits drift. The defaults:

   - A site or app: `astro`/`workers` with `d1` or `kv`.
   - An interactive app: `next`/`vercel` with `neon`.
   - A scheduled agent: `agent`/`workers`/`kv` with Gemini.
   - Tools for other agents: `mcp`/`workers`.

   Supabase is offered only when auth, storage and realtime are all needed together, with the pause
   trap stated up front. OCI is offered only with the warning that signup needs a card and idle
   instances are reclaimed.

2. **Check prerequisites in order:** GitHub, Cloudflare, HCP Terraform, then the cell's provider.
   The skill links each signup and says whether it needs a card. Tokens go only through `greenlight
   secrets gather`, never into chat.
3. **Scaffold and preview.** Run `greenlight init`, then `greenlight add <name> --lane --target
   --data`, then `greenlight preview <name>`. This gives a green local gate before any cloud
   resource exists.
4. **Push and ship.** Push to `develop` and watch the `greenlight ship` beta result. Promotion is a
   separate deliberate step that the user dispatches.

**Prerequisite gap in the framework.** `packages/shared` currently *requires* `domain`, and `init`
assumes a Cloudflare zone. A domain is the one non-free item on the default path. Phase 2 therefore
adds a **no-domain mode**: `domain` becomes optional, and when it is absent, workers tools are
served at `<name>.<account>.workers.dev` and Vercel tools at their `*.vercel.app` URL. Without this
mode the kickoff skill cannot honestly claim a $0 start.

### `greenlight-build`: making an app self-verifying

This skill turns "the loop exists" into "every app the agent builds is checkable". It is a
contract with five parts:

- **Write the verify spec first.** Write `verify.config.ts` from the user's acceptance criteria
  *before* the feature code. The spec must go red first, then green.
- **Expose identity and health.** Every app serves `/__version`, which turns on the SHA gate. It
  also serves a JSON health route that reports each dependency (`checks.database`, `lastRun`), so
  `api` checks can assert content rather than reachability (v2 §8, "depth over reachability").
- **Assert guards.** Every write route has a verify check that an unauthenticated request is
  rejected (`method: 'POST', status: 401`). Every cron has a freshness check (`maxAgeHours`).
- **Choose modes per lane.** Use `api` for everything, `playwright` for UI flows, `mcp` with
  `expectTools` for MCP servers, and `eval` only where quality is subjective.
- **Stay within the free tier.** Link the cell's free-tier page and design under its limits, for
  example batching D1 writes and keeping cron frequency below Gemini's RPD.

### `greenlight-wiki`: maintaining the wiki and proposing skill changes

This skill holds the procedures for two roles, Wiki Maintainer and Skill Proposer. They run in a
human-invoked session or in CI. A normal app-building session would not load them.

## Runtime rule: when the building agent may read the wiki

The paper's ablation applies to *evolution rollouts*, so the plan separates two modes:

- **Bench rollouts** (Phase 4): the inference agent has **no wiki access**, only skills. This keeps
  traces informative, as the paper recommends.
- **Normal use**: skills are primary. The agent may consult `wiki/index.md` **after a gate fails**,
  as a debugging lookup. This mirrors how `logsOnFailure` already works. The decision to allow this
  is ours, not the paper's. Phase 4 measures it by comparing the two policies on the val split.

## CLI surface

The `wiki` command family is new. The deterministic CLI parts check and apply what the agent
proposes, so the agent never writes wiki or skill files freehand. This is the same "mechanism, not
instruction" stance that `deploy-verify-promote` v2 takes.

- `greenlight wiki capture` runs inside `preview`, `ship` and `verify`. It writes
  `.greenlight/raw/<run-id>/`: the stage events, the `verify --json` result, `logsOnFailure`
  output, the git sha, the skill versions in use, and the agent model if known. **Secrets are
  redacted before the write.** Known token shapes are scrubbed, and so are values of every secret
  name in the manifest's provider packs. Each log is truncated to 15k characters, which is the
  paper's budget.
- `greenlight wiki ingest [--sample 5:3]` takes a sample of failing and passing raw runs and prints
  the maintainer prompt bundle. It then accepts the maintainer's JSON (`create_patterns`,
  `update_patterns`, `update_index`, `append_log`), validates it against the schema, applies the
  exact-substring patches, and refuses ambiguous or missing targets.
- `greenlight wiki propose` builds the proposer bundle (index, `skill-impact.md`, outcome summary)
  and exposes traces read-only. It accepts one `create` / `patch` / `no_action` and stages the
  change on a branch. **It does not accept anything; Phase 4's gate does.**
- `greenlight wiki lint` is our addition and runs inside `doctor`. It flags broken links, orphan
  pages (not in the index, or no inbound link), index lines that point nowhere, pattern pages over
  30 lines, `free-tier/*` pages whose `verified:` date is more than 90 days old, skills without a
  `PURPOSE.md`, and `PURPOSE.md` citations of pages that do not exist. With `doctor --strict`,
  these fail CI.
- `greenlight wiki contribute <slug>` opens a PR that upstreams a project-wiki pattern into the
  framework wiki. `check-seam` runs on the pattern, so personal domains and emails never leave the
  consumer.

## Phases

Each phase ships through the normal Greenlight release, and each has a test that shows it is done.

**Phase 0: seed the wiki, without automation.**
- Create `wiki/` with the schema above.
- Hand-compile 15–25 seed patterns from material that already exists:
  - provider-skill footguns;
  - `docs/oci-payg-runbook.md`;
  - the Supabase pause trap;
  - commit history (#26 Gemini overload fallback, #27 unplanned-replacement guard, #28 keepalive
    `cacheTtl`, the v0.8 SHA-gating motivation).
- Write `free-tier/` pages for Cloudflare (Workers, D1, KV, cron), Neon, Vercel Hobby, Gemini (AI
  Studio), HCP Terraform, GitHub Actions, OCI Always Free and Supabase Free. Each page records limits,
  whether a card is required, idle behavior and a `verified:` date.
- Add a `PURPOSE.md` to every existing skill.
- Extend `copy-assets` / `check-plugin-sync` to mirror `wiki/` into `plugin/wiki`.
- *Done when* `wiki lint` (still a script at this stage) passes in `check-all`, and the plugin ships
  the wiki.

**Phase 1: raw capture.**
- Add `wiki capture` and wire it into `preview`, `ship` and `verify`.
- Generalize `skillVersion()` so it stamps the versions of all loaded skills, not just
  `deploy-verify-promote`.
- *Done when* a failing `preview` produces a redacted, truncated run directory. A unit test plants
  every provider-pack secret name and asserts that none survive.

**Phase 2: the kickoff and build skills, plus no-domain mode.**
- Make `domain` optional in the schema, and add a `workers.dev` / `vercel.app` URL fallback to the
  `url()` adapter contract.
- Make `init` work without a zone, and teach `doctor` that apex-only checks are skipped without a
  domain.
- Write `greenlight-kickoff` and `greenlight-build`.
- *Done when* a fresh agent session, given only the plugin and the prompt "build a guestbook on
  Greenlight, free tier only", reaches a green `preview`. A fresh account then reaches a green beta
  `ship` with no domain. The ship is run by hand, once per supported cell.

**Phase 3: the Wiki Maintainer.**
- Add `wiki ingest` with JSON validation and patch application, plus the maintainer section of
  `greenlight-wiki`. The skill reuses the paper's instructions: deep root-cause analysis rather than
  symptoms, and `update_index` and `append_log` are always required.
- *Done when* ingesting the Phase 1 run directories produces lint-clean pattern edits, and a
  golden-file test covers patch application and refusals.

**Phase 4: the bench, the proposer and the gate.** This phase is the centre of the plan.
- Build `bench/` with about 30 app briefs spread across the free-tier cells. Examples: a guestbook
  on `astro`/`workers`/`d1`, a link shortener on workers with `kv`, a daily digest on
  `agent`/`workers`/`kv`, a todo app on `next`/`vercel`/`neon`, and a lookup tool on `mcp`/`workers`.
- Give each brief a **hidden grader** `verify.config.ts` that the agent never sees. The grader
  checks the brief's behavior *and* the `greenlight-build` contract: `/__version`, health JSON, a
  401 on unauthenticated writes, and an agent-authored verify spec that exists and passes.
- **Score every brief locally** through `greenlight preview` (wrangler/miniflare, local Postgres
  for Neon cells). The bench then needs no cloud credentials, costs nothing and is reproducible.
  Deploys are deliberately left out of the score.
- Rollouts run headless (`claude -p` with the plugin, no wiki access) in throwaway sandboxes.
- Add `wiki propose` and a `bench gate` that applies one proposal, runs the val split three times,
  and accepts only on a **strict improvement**, using the paper's paired bootstrap (1,000 resamples,
  p < 0.05).
- The harness, never the agent, appends the outcome to `skill-impact.md` and bumps the skill's
  `version:`. Stage events then let field pass rates be compared per skill version.
- *Done when* one full evolution run from the current skills finishes, the test split is reported
  against the starting skills, and at least one accepted change has an audit row whose
  `PURPOSE.md` cites a pattern.

**Phase 5: the field loop and pruning.**
- Add `wiki contribute` for consumer → framework PRs. A human reviews every PR, and nothing merges
  automatically.
- Add pruning, which is our addition and covers the paper's stated gap. Lint proposes merging
  near-duplicate patterns. Pages with no evidence newer than 180 days and no citing skill move to
  `wiki/archive/` through a maintainer pass, so they are archived, not deleted.
- Add a monthly scheduled job that re-runs the test split on the current default model, which
  catches regressions caused by the model changing underneath the skills.

## Risks and how the plan handles them

- **Secret leakage through traces.** This risk is the most serious, because raw traces of deploys
  naturally contain tokens. The plan redacts at capture, keeps `.greenlight/` gitignored, and
  upstreams patterns, never raw runs. The Phase 1 test is a merge blocker.
- **Overfitting to the bench.** The test split is held out, and briefs are written so the hidden
  grader checks behavior, not file layout. The bench gets new briefs as field patterns reveal gaps.
- **Negative cross-model transfer.** The paper showed this can be severe. Every `skill-impact.md`
  row therefore records the model, and Phase 4 gates on two models (a frontier one and a cheaper
  one). A proposal must not regress either model.
- **Strict gating rejects neutral proposals.** The paper notes this costs later gains. We keep
  strict gating for now. One optional tie-breaker, our addition: accept a non-regressing proposal if
  it *shortens* the skill.
- **Free-tier facts drift.** Facts live in dated `free-tier/*` pages that lint expires. Skills link
  to them and do not copy them.
- **Bench cost.** Thirty briefs × three runs × two models per proposal is real token spend. Phase 4
  starts with a 10-brief val split. Every rollout is `preview`-only, so there is no cloud cost.

## Decisions for you

1. **No-domain mode (Phase 2).** It changes the manifest schema, which is a framework change, and
   without it the "$0 start" claim is false. Recommended.
2. **Wiki access during normal use.** The options are skills-only, which is the paper's evolution
   setting, or skills plus an index lookup after a failure, which is recommended and measured in
   Phase 4.
3. **The bench runner's model and budget.** This sets how often evolution runs. The recommendation
   is to run it on demand, not on every push.
4. **Whether `greenlight-wiki` ships in the public plugin** or stays a maintainer-only skill in this
   repo. The recommendation is to ship `kickoff` and `build` publicly and keep `wiki` repo-local
   until Phase 4 has produced accepted changes.
