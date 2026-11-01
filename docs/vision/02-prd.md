# 02 — Product requirements

This document turns the business requirements in 01 into user journeys and functional
requirements that can be tested. Every functional requirement (FR) has an ID, the phase that
delivers it, and acceptance criteria. Data shapes are defined in 08, commands in 07, the skill
model in 05 and the evolution loop in 06. This document says *what* must happen, and those
documents say *how*.

## 1. User journeys

Each journey is written end to end from the user's side, followed by the system behavior it
requires. The FR IDs in brackets are defined in section 2.

### J1. Kickoff: from an idea to a beta URL

The owner opens a Claude Code session in an empty directory, or in their existing wrapper, and
says *"I want a site where my book club can vote on next month's pick."*

1. The agent loads `greenlight-kickoff` and checks the prerequisites in order:

   | prerequisite | check |
   |---|---|
   | GitHub | `gh auth status` |
   | Cloudflare | `secrets check` |
   | HCP Terraform | `secrets check` |

   For each one that is missing, the agent prints the signup link, says whether a card is required
   and waits for the owner. Tokens go through `greenlight secrets gather`, which hidden-prompts and
   writes to the secret source, so the owner never pastes a token into chat. [FR-KICK-05,
   FR-SEC-01]
2. The agent runs `greenlight accounts`. The report lists each configured provider, whether its
   token passed verification, the remaining headroom on each quota across the whole portfolio, and
   which lane × target × data cells the owner can deploy right now. [FR-KICK-01]
3. The agent proposes one cell, for example `astro/workers/d1`, choosing only from the available
   cells. It explains the free-tier consequences in two sentences taken from the fact pages, such
   as *"D1 does not pause when idle, and this adds a few hundred requests a day to your Workers
   allowance, which is at 3%."* If the owner has no domain, it says the app will be served at
   `bookclub.<sub>.workers.dev`. [FR-KICK-02, FR-KICK-04]
4. The agent drafts the acceptance criteria in the owner's words:
   - members can vote once;
   - results are hidden until the deadline;
   - the page works on a phone.

   The owner confirms or edits the list, and the agent writes `wiki/tools/bookclub/intent.md`.
   [FR-KICK-03]
5. The agent runs `greenlight add bookclub --lane astro --target workers --data d1 --liveness
   always-on`. The template already serves `/__version`, `/health/live` and `/health`, and its
   verify config already asserts identity and liveness. [FR-KICK-06, FR-BUILD-02]
6. For each criterion, the agent writes a verify check with an `id` and records that id against the
   criterion. It runs `greenlight preview` and confirms the new checks fail. It then writes the
   feature until `preview` is green. [FR-BUILD-01, FR-BUILD-03]
7. The agent commits and pushes to `develop`. CI runs `greenlight ship bookclub --env beta`, and the
   agent gives the owner the beta URL. [FR-KICK-08]

**Done-state:**
- The manifest has the tool, with `liveness` and `promotion: human`.
- `wiki/tools/bookclub/` exists and passes lint.
- The beta ship StageEvent is `passed: true`.
- Prod does not exist yet.

### J2. Feedback in beta becomes a check

The owner tries the beta URL and says *"I could vote twice if I opened it in another browser."*

1. The agent records the complaint as a new criterion, `AC-4`, with `source: feedback` in
   `intent.md`. [FR-BUILD-04]
2. The agent writes a verify check that reproduces the complaint, for example a second POST with a
   fresh session asserting `409`. It runs `preview` and confirms the check fails.
3. The agent fixes the code until `preview` passes, then pushes. Beta ships again.
4. The agent tells the owner the fix is in beta and names the check that now guards it.

**Done-state:** `AC-4.checks` lists the new check id. The check fails on the old commit and passes
on the new one.

### J3. Release decision

The owner says *"Ship it."*

1. The agent runs `greenlight portfolio`. It shows that `bookclub` beta is at sha `abc1234`, that
   beta is verified, and that there are three commits waiting.
2. The agent asks the owner to approve the release of `abc1234`. Approval is recorded as an
   approval record (11 §4.4), which in the default flow is the owner dispatching `promote.yml` or
   approving the `production` environment in GitHub.
3. `promote.yml` verifies beta at that sha, fast-forwards `develop` to `main` pinned to it, checks
   out the commit and ships prod with `--expect-sha`. [FR-LOOP-06]
4. The agent reports the prod URL and the prod verify result.

If the owner has not approved, the agent's attempt to dispatch `promote.yml` through the credential
proxy is refused, and the agent reports that release is waiting for the owner. [FR-SEC-05]

### J4. Cold edit by a new session

Three months later, a fresh session is asked *"add a check that BAMCP's demo BAM still loads."*

1. The agent loads `deploy-verify-promote`. Its `on-start` hook runs `greenlight wiki context
   bamcp`, which prints the project's `intent.md`, `liveness.md`, the first 40 lines of
   `decisions.md` and the confirmed patterns whose `cells` match `mcp/oci/*`. [FR-LOOP-01]
2. From `liveness.md`, the agent learns that BAMCP is `needs-heal` with direct-to-prod, so the local
   gate is mandatory. From `intent.md`, it learns that the demo path is criterion `AC-2`.
3. The agent adds the check to `verify/bamcp.config.ts` with an `id`, links it from `AC-2.checks`,
   runs `greenlight preview bamcp`, and pushes.

**Done-state:**
- The first `preview` after the change passes.
- The agent did not need any information that is absent from the wiki, the repo or command output.
- The raw record carries the session ref, so the cold-edit metric counts it.

### J5. An incident becomes a pattern

A keepalive sweep fails, and an alert issue opens.

1. The keepalive's raw record, of kind `keepalive`, references the issue.
2. The owner, or a scheduled maintainer session, runs `greenlight wiki ingest --incident
   issue:<repo>#<n>`. The maintainer reads the incident's raw records and the current wiki. It
   returns a `MaintainerOutput` (08 §9.1) that creates an `incident` page and creates or updates a
   `pattern` with `status: hypothesis`, an `atRisk`, a `probed` and a proposed `catches`.
   [FR-WIKI-06]
3. The proposer runs `greenlight wiki propose`. It chooses the strongest outlet. For a proxy check,
   that is a mechanism or doctor issue on the framework, or a verify check in the wrapper. It
   returns the proposal. [FR-EVO-03, FR-EVO-04]
4. A human merges the fix. The distinguishing check is shown to go red to green on the deployed
   artifact, and `greenlight wiki remediate` writes a ledger row with `FieldEvidence`. The pattern
   moves to `confirmed`. [FR-EVO-06, FR-WIKI-04]

### J6. Retiring a project

The owner says *"I'm done with bookclub."*

1. The agent runs `greenlight retire bookclub --dry-run`. The output lists the manifest entry, the
   infra file, the DNS records, the keepalive target, the secrets that only this tool uses, and the
   quota it releases.
2. The owner confirms. The agent runs `greenlight retire bookclub`. This removes the manifest entry
   and the `infra/bookclub.tf` file, moves `wiki/tools/bookclub/` to `wiki/archive/tools/bookclub/`,
   and pushes on a branch. [FR-PORT-04]
3. `infra.yml` plans the destroy, and its destroy guard requires manual approval. On approval, it
   applies.

**Done-state:**
- `portfolio` no longer lists the tool.
- `accounts` shows the freed headroom.
- The wiki pages remain readable in the archive.

### J7. Portfolio review

The owner asks *"what's the state of everything?"*

1. The agent runs `greenlight portfolio` and summarizes it in four parts:
   - tools with beta ahead of prod and verified, which are waiting for a release decision;
   - tools with a failing last ship or open alerts;
   - keepalive status;
   - any quota above 80%.

   [FR-PORT-01]
2. For each problem, the agent names the next action, such as *"Tracer beta is 4 commits ahead and
   verified"* or *"Neon compute is at 86%, driven by polyphony and tracer."*

### J8. A skill improvement is accepted or rejected

The maintainer has compiled several failing raw records into a pattern saying that agents forget to
add new MCP tools to `expectTools`.

1. The proposer reads the index, the ledger (`skill-impact.md`), the pattern and at least four
   traces. It confirms the mechanism already exists, because `exactTools` fails the gate, so the
   real gap is in the skill's wording. It returns a `patch` to `deploy-verify-promote`.
2. The owner runs `greenlight bench gate prop-<id>`. The harness:
   - applies the patch in a sandbox;
   - runs every replay task and the validation split three times on two models;
   - computes the deltas and a paired bootstrap.

   [FR-EVO-05]
3. **If any replay task regresses on either model**, the outcome is `rejected`, the skill is
   reverted, and a ledger row records why. The wiki keeps the pattern.
4. **If no replay task regresses and capability strictly improves** with p < 0.05 on both models,
   the outcome is `pending-human`, because `deploy-verify-promote` has `blast-radius: high`
   (ADR-12). The harness bumps `version` to the next integer on a release-candidate branch. A human
   reviews and merges, and the next CLI release ships it. [FR-EVO-08]

## 2. Functional requirements

Each FR shows its phase, the BRs it serves and its acceptance criteria. "AC" in this section means
acceptance criteria for the requirement, not intent criteria.

### 2.1 Kickoff (`FR-KICK`)

| id | title | phase | BR |
|---|---|---|---|
| FR-KICK-01 | `greenlight accounts` reports providers, verification, quotas and available cells | P2 | BR-04 |
| FR-KICK-02 | Cell proposal is limited to available cells and states free-tier consequences | P2 | BR-04 |
| FR-KICK-03 | Intent is captured and confirmed before scaffolding | P2 | BR-01, BR-02 |
| FR-KICK-04 | No-domain mode | P2 | BR-03 |
| FR-KICK-05 | Prerequisites are checked by verifiable done-states | P2 | BR-03 |
| FR-KICK-06 | `add` requires a liveness model and produces a contract-complete tool | P1–P2 | BR-05, BR-06 |
| FR-KICK-07 | Headroom warning before a new tool would push a quota past 80% | P3 | BR-04 |
| FR-KICK-08 | The first beta URL is handed to the owner | P2 | BR-03 |

**FR-KICK-01.**
- Given configured tokens, `greenlight accounts --json` emits an `AccountsReport` (08 §11.1) that
  validates against its schema.
- `configured` is true only when every non-optional `TokenSpec` of the provider is present in the
  secret source.
- `verified` reflects that provider's existing `verify()` result. With `--offline` it is null, and
  no network calls are made.
- `quotas[].used` is null, never guessed, when the provider has no `usage` function.
- `cells[]` lists exactly the matrix cells from `packages/shared/src/schema.ts` `MATRIX` whose
  providers are all configured. Each unavailable cell names the missing providers.

**FR-KICK-02.**
- The kickoff skill instructs the agent to choose only from `cells[].available`.
- The skill's proposal text cites the `fact` page ids it took consequences from.
- Supabase is proposed only when the owner asks for bundled auth plus storage plus realtime.
- OCI is proposed only with its `cardRequired` and `idle: reclaimed` facts stated.
- Bench task `cap/kickoff-cell-choice` passes. It gives a brief whose only available store is KV
  and fails any output that proposes D1.

**FR-KICK-03.**
- `wiki/tools/<name>/intent.md` exists before `greenlight add` runs.
- Each criterion has `source: kickoff`.
- The kickoff skill requires an explicit confirmation step, and the drill transcript shows the
  owner confirming.

**FR-KICK-04 (no-domain mode).**
- `domain` is optional in `ConfigSchema`. When it is absent, the validation rules in 08 §1.2 hold.
- `resolveUrl` returns the URLs in 08 §1.3. The beta Worker is named `<name>-beta`.
- `init` without `--domain` succeeds and does not request a zone id.
- `doctor` skips apex-only checks and reports that it is skipping them.
- `ship --env beta` and `promote` work end to end on a fresh Cloudflare account without a zone
  (13 §3, P2 drill).
- Unit tests cover every row of the 08 §1.3 table.

**FR-KICK-05.**
- Each prerequisite step in the kickoff skill names the command whose output proves it is done:
  `gh auth status`, `greenlight secrets check <provider>` and `greenlight doctor`.
- The skill forbids the agent from proceeding on the owner's assertion alone.
- Bench task `cap/kickoff-missing-hcp` gives a fixture without an HCP token. The grader passes only
  if the agent stops and reports the missing token rather than continuing.

**FR-KICK-06.**
- `greenlight add` accepts `--liveness <model> [--probe <path>]`. Without the flag it fails with
  the list of models valid for the cell.
- The written manifest entry validates against the 08 §1.2 consistency rules.
- For every lane, the scaffolded tool's first `preview` passes C1, C2 and C7 checks with no edits.

**FR-KICK-07.**
- `add` computes the projected quota use for each quota in the cell's fact pages. It warns, and
  requires `--accept-headroom`, when any projection exceeds 80%.
- The projection method is defined in 10 §3.

**FR-KICK-08.**
- After a successful beta ship, the kickoff skill prints the beta URL taken from `resolveUrl`, or
  from the adapter for vercel.
- It states that prod is unchanged until the owner releases.

### 2.2 Build (`FR-BUILD`)

| id | title | phase | BR |
|---|---|---|---|
| FR-BUILD-01 | Verify-first: each criterion's check is written and seen failing before the feature | P2 | BR-02 |
| FR-BUILD-02 | Lane templates implement contract clauses C1, C2 and C7 | P1 | BR-05 |
| FR-BUILD-03 | Verify specs and checks carry stable `id`s | P0 | BR-02 |
| FR-BUILD-04 | Every owner complaint becomes a criterion and a check | P2 | BR-02 |
| FR-BUILD-05 | The build skill selects verify modes per lane and per criterion | P2 | BR-05 |
| FR-BUILD-06 | Clauses C3–C6 are taught by the build skill and checked by doctor where possible | P1–P2 | BR-05, BR-06 |

**FR-BUILD-01.**
- The build skill's procedure orders the steps as: write the check, run `preview`, observe a
  failing result for that check id, implement, run `preview`, observe it passing.
- The raw records for the two `preview` runs show the check id failing and then passing at
  different `gitSha` values, or within the same uncommitted session, as recorded by `--events`.
- Bench capability tasks grade this through `mutants/`: the grader fails on the unimplemented
  fixture.

**FR-BUILD-02.**
- `tools/_template-astro`, `_template-next` and `_template-mcp/{workers,oci}` each serve the
  following, as specified per lane in 09:
  - `/__version`, returning `{ "sha": "<40 hex>" }` from `GREENLIGHT_SHA`, or from
    `VERCEL_GIT_COMMIT_SHA` on Vercel;
  - `/health/live`, which never touches a store;
  - `/health`, which returns per-dependency JSON.
- Each template's `verify.config.ts` exports a function form that marks environment-invariant
  checks.
- `_template-agent` already does most of this, and it is brought to the same contract.

**FR-BUILD-03.**
- `packages/verify` accepts `id` on specs and api checks as defined in 08 §6. It rejects duplicates
  within a config with a strict-spec error.
- The id appears on `VerifyCheck` and in the `--json` export as `eval.check_id`.
- Existing configs without ids still validate.

**FR-BUILD-04.**
- The build skill instructs the agent to record each complaint verbatim as a criterion with
  `source: feedback`, to add a check that reproduces it, and to confirm the check fails before the
  fix.
- LR-15 fails when a feedback criterion has no checks.

**FR-BUILD-05.**
- The build skill contains a table mapping criterion shapes to modes:
  - an HTTP behavior maps to `api`;
  - a UI flow maps to `playwright`;
  - an MCP capability maps to `mcp` with `expectTools`;
  - subjective quality maps to `eval`.
- Bench capability tasks include at least one criterion per mode.

**FR-BUILD-06.**
- The build skill covers C3–C6 with a rule and a citation each.
- DR-24 and DR-25 enforce C1 and C4 structurally, and DR-21 enforces C6 for `needs-silence`.

### 2.3 The loop skill and gates (`FR-LOOP`)

| id | title | phase | BR |
|---|---|---|---|
| FR-LOOP-01 | `on-start` hook: `wiki context <name>` before any change | P0 | BR-01, BR-11 |
| FR-LOOP-02 | `on-failure` hook: `wiki lookup` keyed to failing check ids | P5 | BR-13 |
| FR-LOOP-03 | `on-complete` hook: raw capture and intent update | P5 (capture), P0 (intent) | BR-12, BR-01 |
| FR-LOOP-04 | `on-incident` hook: record an incident reference for the maintainer | P5 | BR-13 |
| FR-LOOP-05 | StageEvents carry every skill version, the agent, a raw id and a `promote` stage | P5 | BR-12 |
| FR-LOOP-06 | Promotion requires an approval record unless the tool opts into `auto-on-green` | P4 (enforced), P0 (documented) | BR-08 |
| FR-LOOP-07 | `auto-on-green` promotion for eligible low-stakes tools | P4 | BR-08 |
| FR-LOOP-08 | Verify failure reports link matching confirmed patterns | P5 | BR-13 |

**FR-LOOP-01.**
- `greenlight wiki context <name>` prints, in order:
  1. `intent.md`;
  2. `liveness.md`;
  3. the first 40 lines of `decisions.md`;
  4. `confirmed` decisions and patterns from both wikis whose `cells` match the tool's cell and
     whose `applies` includes the installed version, as titles and index lines only;
  5. open alert issues for the tool.
- It never prints incident pages (ADR-10).
- `deploy-verify-promote` step 1 runs it, and its `PURPOSE.md` declares `on-start`.

**FR-LOOP-02.**
- On any failing `verify`, `preview` or `ship`, the CLI appends `see: <page id>` lines for each
  `confirmed` pattern whose `catches.checkSignature` matches a failing check's id or name.
- The skill's failure step instructs the agent to read those pages before changing anything.
- Matching hypothesis pages are never printed.

**FR-LOOP-03.**
- Every `preview`, `ship` and `verify` run writes one `RawRecord` (08 §5) unless
  `GREENLIGHT_RAW=off`.
- The excerpt is redacted and at most 15,000 characters.
- The skill's completion step requires updating `intent.md` when criteria changed, and lint
  catches drift (LR-15).

**FR-LOOP-04.**
- `greenlight wiki incident open --tool <name> --ref <EvidenceRef>` creates an incident stub with
  `status: hypothesis` and links the latest raw records for that tool.
- The keepalive alert workflow calls this command when it opens an issue.

**FR-LOOP-05.**
- `StageEvent` gains `skills`, `agent`, `rawId` and the `promote` stage (08 §7).
  `skillVersion` remains.
- `agent` is populated from `GREENLIGHT_AGENT` and `GREENLIGHT_MODEL` when set. The skill tells the
  agent to export them.
- The Tracer ingest accepts the new fields without breaking older events.

**FR-LOOP-06.**
- With `promotion: human`, the agent cannot cause a prod ship. The workflow requires the GitHub
  `production` environment's required reviewer, or a `workflow_dispatch` by a human actor, and the
  credential proxy denies the agent's dispatch call (FR-SEC-05).
- DR-32 fails when `promote.yml` lacks the environment protection.

**FR-LOOP-07.**
- With `promotion: auto-on-green`, valid only under the 08 §1.2 restrictions, a green beta ship
  dispatches promotion automatically.
- The approval record names the policy as the approver.

**FR-LOOP-08.**
- The human report and the `--json` export both carry the links.
- The links appear within the same run's output, with no extra command required.

### 2.4 Portfolio (`FR-PORT`)

| id | title | phase | BR |
|---|---|---|---|
| FR-PORT-01 | `greenlight portfolio` summarizes every tool | P3 | BR-07 |
| FR-PORT-02 | Manifest `liveness` declaration with consistency validation | P1 | BR-06 |
| FR-PORT-03 | Doctor liveness rules DR-20 to DR-23 | P1 | BR-06 |
| FR-PORT-04 | `greenlight retire` with guarded destroy | P3 | BR-09 |
| FR-PORT-05 | Quota accounting via provider usage functions | P3 | BR-04, BR-07 |
| FR-PORT-06 | Generated `wiki/portfolio.md` | P3 | BR-07 |

**FR-PORT-01.**
- `portfolio --json` emits a `PortfolioReport` (08 §11.2).
- `waiting` is the count from `git rev-list --count origin/main..origin/develop`, scoped to the
  tool's paths for monorepo tools, or to the submodule pointer for adopted tools.
- `beta.verified` and `prod.verified` come from the latest raw record or the latest ship run.
- When a source is unreachable, the field is null and the report says why. It never fails as a
  whole.

**FR-PORT-02.**
- The schema implements 08 §1.2.
- Existing manifests without `liveness` still load. DR-20 warns and fails under `--strict`.

**FR-PORT-03.**
- DR-20 to DR-23 are implemented as specified in 07. Each one has a unit test with a passing and a
  failing manifest fixture.

**FR-PORT-04.**
- `retire <name> --dry-run` lists every artifact it would remove or archive.
- Without `--dry-run`, it creates a branch `retire/<name>`, makes the removals, and pushes.
- It never applies infra. The destroy goes through `infra.yml`'s existing plan, destroy-guard and
  approval sequence.
- Secrets used only by the retired tool are listed for manual deletion and are not deleted
  automatically.

**FR-PORT-05.**
- The Cloudflare and Neon provider packs implement `usage()` (08 §12).
- The Vercel, Supabase, Gemini and OCI packs implement it where a free-tier API exists, and
  otherwise return nothing so that headroom shows unknown.
- Values are cached for one hour in `.greenlight/cache/usage.json`.

**FR-PORT-06.**
- `wiki lint --fix` regenerates `portfolio.md` with one line per tool: name, cell, liveness model
  and the first sentence of `intent.md`.

### 2.5 Wiki (`FR-WIKI`)

| id | title | phase | BR |
|---|---|---|---|
| FR-WIKI-01 | Page schemas and `wiki lint` with LR-01 to LR-21 | P0 | BR-01, BR-11 |
| FR-WIKI-02 | Framework wiki packaged with the CLI and materialized by `agent sync` | P0 | BR-15 |
| FR-WIKI-03 | Project wiki layout and tool-repo pointer block | P0 | BR-01 |
| FR-WIKI-04 | Status lifecycle enforced | P0 (schema), P5 (transitions) | BR-13 |
| FR-WIKI-05 | `wiki lookup` and `wiki context` | P0 (context), P5 (lookup) | BR-01, BR-13 |
| FR-WIKI-06 | `wiki ingest`: maintainer bundle, validation and atomic patch application | P5 | BR-13 |
| FR-WIKI-07 | `wiki contribute`: upstream a project pattern by PR | P5 | BR-17 |
| FR-WIKI-08 | Version filtering by `applies` and the fixed-in-newer report | P0 | BR-15 |
| FR-WIKI-09 | Raw store with Tracer as an optional sink | P5 | BR-12 |
| FR-WIKI-10 | Seed content for both wikis | P0 | BR-01, BR-13 |

**FR-WIKI-01.**
- Every schema in 08 §3–4 is implemented in zod.
- `wiki lint` returns exit 0 on a clean wiki, 1 on errors, and 2 on warnings when `--strict` is
  set.
- Each rule has a fixture that triggers it and a fixture that passes it.
- `--fix` applies only the automatic fixes listed in 04 §5.

**FR-WIKI-02.**
- `cli/scripts/copy-assets.mjs` copies `wiki/` into the package.
- `check-plugin-sync` covers `plugin/wiki`.
- `agent sync` writes `.greenlight/wiki/framework/` with a `VERSION` file equal to the CLI version.
- DR-12 detects drift.

**FR-WIKI-03.**
- `agent sync <name>` and `adopt` write the pointer block (04 §2.2) idempotently, between its
  markers.
- `greenlight add` creates stub `intent.md` and `liveness.md`.

**FR-WIKI-04.**
- A move to `confirmed` that lacks the evidence required by LR-05 fails lint.
- Every status change appears in `log.md`.

**FR-WIKI-05.**
- `wiki lookup <check-id|class|cell|text>` prints matching confirmed pattern index lines and
  paths.
- It respects `applies` and status.
- It reads both wikis.
- It is used by FR-LOOP-01 and FR-LOOP-02.

**FR-WIKI-06.**
- `wiki ingest [--incident <ref>] [--sample 5:3]` prints a bundle. The bundle contains the
  maintainer prompt (06 §2.2), the current index, the sampled raw excerpts and the relevant pages.
- `wiki ingest --apply <file>` validates a `MaintainerOutput` and applies it atomically. An op
  whose target occurs zero or several times rejects the whole output.
- A rejected output changes no file.

**FR-WIKI-07.**
- `wiki contribute <page-id>` runs `check-seam` and LR-20 on the page and opens a PR to the
  framework repo with the page's evidence links in the body.
- It never merges.
- Merged pages land as `hypothesis` unless the reviewer changes the status.

**FR-WIKI-08.**
- Pattern visibility follows `applies` against the installed version.
- DR-33 lists open patterns fixed in a newer version.

**FR-WIKI-09.**
- Raw records are written locally.
- When `GREENLIGHT_INGEST_URL` is set, they are also posted best-effort, matching the current
  `ship` ingest behavior.
- Tracer accepts them as a new mode of run.
- The absence of Tracer changes nothing else.

**FR-WIKI-10.**
- The seed inventory in 15 is present, and every seeded page passes lint.
- Each of the six live tools has `intent.md` and `liveness.md`.

### 2.6 Managed skills (`FR-SKILL`)

| id | title | phase | BR |
|---|---|---|---|
| FR-SKILL-01 | Every Greenlight skill has a `PURPOSE.md` citing confirmed pages | P0 | BR-11 |
| FR-SKILL-02 | Skills declare hooks, and hook commands exist | P0 | BR-11 |
| FR-SKILL-03 | Only the harness bumps a managed skill's `version` | P6 (gate), P0 (lint rule) | BR-14 |
| FR-SKILL-04 | New skills: `greenlight-kickoff`, `greenlight-build`, `greenlight-wiki`, `greenlight-portfolio` | P2–P5 | BR-03, BR-07, BR-13 |
| FR-SKILL-05 | `skillVersions()` covers every managed skill | P5 | BR-12 |
| FR-SKILL-06 | Each skill declares a blast radius that sets gate strictness | P0 | BR-14 |
| FR-SKILL-07 | Provider skills' footgun sections become rules plus links | P0 | BR-11 |

**FR-SKILL-01.**
- The following skills each have a `PURPOSE.md` that validates (08 §2.2) and passes LR-11 to
  LR-13:
  - `deploy-verify-promote`;
  - the nine `provider-*` skills;
  - each new skill as it is added.

**FR-SKILL-02.**
- Each hook named in `hooks` maps to the CLI command in 05 §3.
- `doctor` verifies that each declared hook's command is available in the installed CLI.

**FR-SKILL-03.**
- A CI check in the framework repo compares each changed `SKILL.md` `version` against the ledger.
- A bump without an `accepted` or `pending-human`→merged ledger row fails.
- Text changes without a version bump are allowed only for typo-class edits, marked `[no-bump]` in
  the commit message. The ledger records them as `outlet: skill, change.kind: patch` with `evidence`
  omitted, and the next gate run measures them.

**FR-SKILL-04.**
- Each new skill exists with `SKILL.md`, `PURPOSE.md` and bench coverage (`bench-slice`) by the end
  of its phase, as specified in 05 §5.

**FR-SKILL-05.**
- Implements 08 §7.
- Unit-tested with fixtures containing several skills and an override environment variable.

**FR-SKILL-06.**
- `blast-radius` is set on every skill.
- `deploy-verify-promote` is `high`, and the provider skills and `greenlight-wiki` are `medium` or
  `low` as listed in 05 §4.

**FR-SKILL-07.**
- For each fact or pattern seeded from a provider skill's footgun text, the skill section is
  reduced to a one-line rule and a link.
- A reviewer checklist item in the PR template enforces this.

### 2.7 Evolution loop (`FR-EVO`)

| id | title | phase | BR |
|---|---|---|---|
| FR-EVO-01 | Bench task format and runner | P6 | BR-14 |
| FR-EVO-02 | Mutation checks for every grader | P6 | BR-14 |
| FR-EVO-03 | Proposer bundle and output validation | P5 (issue/verify outlets), P6 (skill outlet) | BR-13 |
| FR-EVO-04 | Outlet routing: strongest available outlet first | P5 | BR-13 |
| FR-EVO-05 | Lexicographic two-model gate | P6 | BR-14 |
| FR-EVO-06 | Harness-only ledger and the rendered `skill-impact.md` | P5 | BR-13, BR-14 |
| FR-EVO-07 | Field monitor raises an alarm on first-pass or rollback regression per skill version | P6 | BR-14 |
| FR-EVO-08 | The loop skill is evolved under the same gate at the highest blast radius | P6 | BR-14 |

**FR-EVO-01.**
- `greenlight bench run [--split val] [--model m] [--runs n] [--tasks glob]` executes tasks in the
  08 §10 format.
- Each rollout runs in a throwaway sandbox (a git worktree plus a temporary directory) with only
  `brief.md` and the fixture visible.
- The harness grades through `greenlight preview` with the hidden grader.
- Results are raw records of kind `bench`.

**FR-EVO-02.**
- `greenlight bench check-graders` applies each mutant and runs the grader. It fails when any
  mutant passes.
- CI runs it on any change under `bench/`.

**FR-EVO-03.**
- `wiki propose` prints a bundle with the proposer prompt (06 §3), the index, the ledger and an
  outcome summary, and grants read-only trace access.
- `wiki propose --apply` validates a `ProposerOutput` (08 §9.2).
- The proposer prompt requires at least four traces read before a non-`no_action` output.

**FR-EVO-04.**
- The proposer prompt includes the outlet ranking (ADR-01).
- A `skill` outlet for a pattern whose class has a mechanical remedy triggers LR-18, and the bundle
  states the remedy.

**FR-EVO-05.**
- `bench gate <proposalId>` implements 06 §5:
  1. replay tasks are a hard constraint on both models;
  2. the capability score must strictly improve with a paired bootstrap p < 0.05 on both models.
- Three runs per model are made, with early stop at R = 1.0.

**FR-EVO-06.**
- Only `bench gate` and `wiki remediate` append to `ledger.jsonl`.
- LR-14 enforces the schema and the writer.
- The rendered markdown matches.

**FR-EVO-07.**
- A scheduled job, or `greenlight bench monitor`, reads StageEvents grouped by `skills` version.
- When the first-pass or rollback rate for a new version is worse than the previous version by
  more than a configured margin over at least N events, it opens an issue labelled `skill-alarm`.
- It never reverts anything automatically.

**FR-EVO-08.**
- Proposals targeting `deploy-verify-promote` must pass every replay task, including the full
  test split, not only validation.
- They always end in `pending-human`.
- Their release notes quote the ledger row.

### 2.8 Secrets (`FR-SEC`)

| id | title | phase | BR |
|---|---|---|---|
| FR-SEC-01 | One readable secret source: Infisical by default | P4 | BR-10 |
| FR-SEC-02 | `--sink github` fallback preserves today's model | P4 | BR-10 |
| FR-SEC-03 | Provider-registry `inject` field and `secrets proxy-config` | P4 | BR-10 |
| FR-SEC-04 | Agents run behind the credential proxy with placeholders only | P4 | BR-10 |
| FR-SEC-05 | The proxy denies the promote dispatch without an approval record | P4 | BR-08 |
| FR-SEC-06 | Redaction at raw capture and LR-20 in the wikis | P5 (capture), P0 (lint) | BR-10 |
| FR-SEC-07 | CI-only tokens listed explicitly (DR-30) | P4 | BR-10 |
| FR-SEC-08 | Proxy response scrubbing for declared paths | P4 | BR-10 |

**FR-SEC-01.**
- `secrets gather` writes to Infisical when `GREENLIGHT_SECRET_SINK=infisical`. This is the
  default once P4 ships for new `init`.
- An Infisical sync writes the same names to GitHub Actions secrets.
- Existing workflows run unchanged.

**FR-SEC-02.**
- `--sink github` behaves exactly as `secrets gather` does today (the `gh secret set` path).

**FR-SEC-03.**
- `TokenSpec.inject` implements 08 §12.
- `greenlight secrets proxy-config --format infisical|worker` renders a configuration that the
  chosen proxy accepts.
- A unit test covers each provider pack.

**FR-SEC-04.**
- `greenlight agent run -- <cmd>` launches the command with placeholders in the environment,
  `HTTPS_PROXY` set, `NODE_USE_ENV_PROXY=1`, and the proxy CA trusted.
- The drill in 13 §3, P4 shows no raw credential in the agent's environment or transcript.

**FR-SEC-05.**
- The GitHub `inject` allow-list excludes `POST /repos/*/actions/workflows/promote.yml/dispatches`
  unless an approval record for that sha exists (11 §4.4).
- A mutation test shows the call is refused.

**FR-SEC-06.**
- The redactor removes every value whose name is declared in any provider pack or manifest
  `tokens`, plus known token shapes.
- The planted-secret test (13 §2.6) is a merge blocker.

**FR-SEC-07.**
- DR-30 lists every token without `inject` as CI-only.

**FR-SEC-08.**
- Declared `scrub` paths are removed from proxied responses.
- A test with a fixture Neon response containing a connection URI shows it redacted.

### 2.9 Agent neutrality (`FR-AGENT`)

| id | title | phase | BR |
|---|---|---|---|
| FR-AGENT-01 | Portable skills: `SKILL.md` uses only standard frontmatter plus `version` | P0 | BR-16 |
| FR-AGENT-02 | Anything an agent queries is a CLI command | P0 onward | BR-16 |
| FR-AGENT-03 | Gates are enforced in CI and the CLI, never only in skill text | P0 onward | BR-08, BR-16 |
| FR-AGENT-04 | `agent sync` writes `.agents/skills` and `AGENTS.md` (stretch) | P7 | BR-16 |
| FR-AGENT-05 | Codex cloud secrets path documented and tested (stretch) | P7 | BR-16 |

**FR-AGENT-01.**
- Lint rejects any `SKILL.md` frontmatter key other than `name`, `description` and `version`.
- Claude-specific body hints are allowed only when the drill shows the skill still works for an
  agent that ignores them. In P0 this is reviewed by hand, and in P7 it is tested with Codex.

**FR-AGENT-02.**
- The following are CLI commands with `--json` output: `accounts`, `portfolio`, `wiki context`,
  `wiki lookup`, `status` and `verify`.

**FR-AGENT-03.**
- Every MUST in a skill that concerns release, identity or secrets has a matching mechanism,
  listed in that skill's `PURPOSE.md` under `cites` with outlet `mechanism`.

**FR-AGENT-04.**
- `agent sync` writes both skill trees and both instruction blocks from one source.
- DR-14 fails when the copies differ.

**FR-AGENT-05.**
- The Codex skill path says that authenticated verification runs through CI `ship` or the proxy.
- The P7 drill passes.

## 3. Non-functional requirements

| id | requirement | measure |
|---|---|---|
| NFR-01 | **Security.** No raw credential is ever written to the repo, the wiki, a raw record or an agent's environment after P4. | Planted-secret test; LR-20; the P4 drill environment dump |
| NFR-02 | **Cost.** The default path, including bench scoring, costs $0 in infrastructure; the LLM spend of one `bench gate` is bounded and reported. | `bench gate` prints the token totals from `VerifyReport.tokensIn/Out/costUsd`; the drills run on free accounts |
| NFR-03 | **Latency.** `wiki context` and `wiki lookup` return in under 1 s on a wiki of 500 pages; `accounts` returns within 15 s online, or 1 s with a warm cache or `--offline`. | Benchmarked in CI with a generated fixture wiki |
| NFR-04 | **Determinism.** Given the same inputs, `wiki lint --fix`, the index render, the ledger render and `proxy-config` produce byte-identical output. | Golden-file tests |
| NFR-05 | **Strictness.** Every machine-written artifact is validated before it is trusted, unknown fields are errors, and a rejected write changes nothing. | Contract tests (13 §2.3) |
| NFR-06 | **Portability.** Skills work for an agent that reads only standard SKILL.md frontmatter and command output. | FR-AGENT-01 lint; P7 drill |
| NFR-07 | **Compatibility.** Existing wrappers keep working through every phase without manifest edits; new requirements arrive as doctor warnings first. | `RTrentJones.dev` CI stays green at each release |
| NFR-08 | **Readable output.** Human CLI output stays readable at 100 columns and without colour; every human report has a `--json` equivalent; nothing essential is conveyed by colour alone. | Snapshot tests with `NO_COLOR=1` |
| NFR-09 | **Bounded review load.** The evolution loop produces at most one proposal per invocation and never opens more than three open `skill-alarm` or proposal issues at once. | Harness counter, enforced in code |
| NFR-10 | **Offline operation.** Lint, context, lookup and the renders work without network access. | CI runs them with networking disabled |

## 4. Traceability

| BR | FR | phase |
|---|---|---|
| BR-01 | FR-WIKI-01, FR-WIKI-03, FR-WIKI-05, FR-WIKI-10, FR-KICK-03, FR-LOOP-01, FR-LOOP-03 | P0, P2 |
| BR-02 | FR-KICK-03, FR-BUILD-01, FR-BUILD-03, FR-BUILD-04 | P0, P2 |
| BR-03 | FR-KICK-04, FR-KICK-05, FR-KICK-08, FR-SKILL-04 | P2 |
| BR-04 | FR-KICK-01, FR-KICK-02, FR-KICK-07, FR-PORT-05 | P2, P3 |
| BR-05 | FR-KICK-06, FR-BUILD-02, FR-BUILD-05, FR-BUILD-06 | P1, P2 |
| BR-06 | FR-KICK-06, FR-PORT-02, FR-PORT-03, FR-BUILD-06 | P1 |
| BR-07 | FR-PORT-01, FR-PORT-05, FR-PORT-06, FR-SKILL-04 | P3 |
| BR-08 | FR-LOOP-06, FR-LOOP-07, FR-SEC-05, FR-AGENT-03 | P4 |
| BR-09 | FR-PORT-04 | P3 |
| BR-10 | FR-SEC-01 to FR-SEC-08 | P4, P5 |
| BR-11 | FR-SKILL-01, FR-SKILL-02, FR-SKILL-07, FR-LOOP-01, FR-WIKI-01 | P0 |
| BR-12 | FR-LOOP-03, FR-LOOP-05, FR-WIKI-09, FR-SKILL-05 | P5 |
| BR-13 | FR-LOOP-02, FR-LOOP-04, FR-LOOP-08, FR-WIKI-04, FR-WIKI-06, FR-EVO-03, FR-EVO-04, FR-EVO-06 | P5 |
| BR-14 | FR-SKILL-03, FR-SKILL-06, FR-EVO-01, FR-EVO-02, FR-EVO-05, FR-EVO-07, FR-EVO-08 | P6 |
| BR-15 | FR-WIKI-02, FR-WIKI-08 | P0 |
| BR-16 | FR-AGENT-01 to FR-AGENT-05 | P0, P7 |
| BR-17 | FR-WIKI-07, FR-WIKI-04 | P5 |
