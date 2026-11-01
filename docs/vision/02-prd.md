# 02 — Product requirements

This document turns the business requirements in 01 into user journeys and functional
requirements that can be tested. Every functional requirement (FR) has an ID, the milestone that
delivers it (`M0`–`M7`, 14), and acceptance criteria. Data shapes are defined in 08, commands in 07, the skill
model in 05, the evolution loop in 06 and release authority in 18. This document says *what* must
happen, and those documents say *how*.

**How requirements get built.** The WikiSkill cycle (06 §0, ADR-14) is the method that drives
every improvement. It begins at M2. Requirements from M3 onward are the *expected* outlets of that
cycle. Each item enters the work when a confirmed pattern or an evaluated proposal calls for it.
A cycle may show that an item is unnecessary, and the ledger records that as a valid result. The
acceptance criteria below are the tests an item must pass once it is built. They never require
that a proposal be accepted.

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
2. The agent asks the owner to approve the release of `abc1234`. The owner creates an approval
   artifact bound to `bookclub` and `abc1234` through the protected path (18). The agent has no
   credential that can create one.
3. The protected execution identity's job checks the artifact. It verifies beta at that sha,
   fast-forwards `develop` to `main` pinned to it, checks out the commit and ships prod with
   `--expect-sha`. [FR-LOOP-06]
4. The agent reports the prod URL and the prod verify result.

If the owner has not approved, every production channel the agent could reach refuses: a dispatch
by name or numeric id, a direct push to `main`, a provider deploy, or an infra apply. The agent
reports that release is waiting for the owner. [FR-SEC-05]

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
2. The owner chooses a data disposition for the D1 database (export, then delete). The agent runs
   `greenlight retire bookclub`, and the tool becomes `retiring`. On a branch, the command:
   - removes the declarations;
   - writes a deletion authorization naming exactly the planned addresses and the plan hash;
   - records the inventory in `wiki/tools/bookclub/retirement.md`.

   [FR-PORT-04]
3. The owner approves the authorization through the protected path. `infra.yml` plans. Its guard
   permits the deletes only because they equal the authorized set, and any other delete is still
   refused. It then applies.
4. Wrangler-managed and adopted resources are handled by the commands the inventory names. When
   every inventory item is confirmed gone, the tool becomes `retired`, and the wiki folder moves to
   `wiki/archive/tools/bookclub/`.

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

### J8. One WikiSkill iteration ends in acceptance, rejection or no action

The maintainer has compiled several failing raw records into a pattern saying that agents forget to
add new MCP tools to `expectTools`.

1. The proposer reads the index, the ledger (`skill-impact.md`), the pattern and at least four
   traces. It confirms the mechanism already exists, because `exactTools` fails the gate, so the
   real gap is in the skill's wording. It returns a `patch` to `deploy-verify-promote`.
2. The owner runs `greenlight bench gate prop-<id>`. The harness:
   - checks the baseline identity and re-baselines if any input changed (FR-EVO-11);
   - applies the patch on a branch;
   - runs every replay task and the validation split three times on two models, in both modes;
   - computes the deltas and a paired bootstrap.

   [FR-EVO-05]
3. **If any baseline-passing replay task fails 3 of 3 on either model or mode**, the result is a
   `candidate-rejected` event, and the skill branch is discarded. The ledger records why, and the
   wiki keeps the pattern. This is a successful iteration.
4. **If safety holds and capability strictly improves** on both models, the result is a
   `candidate-accepted` event. `deploy-verify-promote` has `blast-radius: high` (ADR-12), so a
   human must merge the branch (`merged`). The next release must also pass the held-out test check
   (`released`). [FR-EVO-08, FR-EVO-16]
5. **If the proposer finds nothing worth changing**, it returns `no_action` with a reason. The
   ledger records `no-action`, and that is also a successful iteration (ADR-14).

## 2. Functional requirements

Each FR shows its phase, the BRs it serves and its acceptance criteria. "AC" in this section means
acceptance criteria for the requirement, not intent criteria.

### 2.1 Kickoff (`FR-KICK`)

| id | title | milestone | BR |
|---|---|---|---|
| FR-KICK-01 | `greenlight accounts` reports providers, verification, quotas and available cells | M4 | BR-04 |
| FR-KICK-02 | Cell proposal is limited to available cells and states free-tier consequences | M4 | BR-04 |
| FR-KICK-03 | Intent is captured and confirmed before scaffolding | M4 | BR-01, BR-02 |
| FR-KICK-04 | No-domain mode | M4 | BR-03 |
| FR-KICK-05 | Prerequisites are checked by verifiable done-states | M4 | BR-03 |
| FR-KICK-06 | `add` requires a liveness model and produces a contract-complete tool | M4 (astro), M6 (other lanes) | BR-05, BR-06 |
| FR-KICK-07 | Headroom warning before a new tool would push a quota past 80% | M6 | BR-04 |
| FR-KICK-08 | The first beta URL is handed to the owner | M4 | BR-03 |

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
  (13 §3, M4 drill).
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
- The projection method is defined in 10 §3.3.

**FR-KICK-08.**
- After a successful beta ship, the kickoff skill prints the beta URL taken from `resolveUrl`, or
  from the adapter for vercel.
- It states that prod is unchanged until the owner releases.

### 2.2 Build (`FR-BUILD`)

| id | title | milestone | BR |
|---|---|---|---|
| FR-BUILD-01 | Verify-first: each criterion's check is written and seen failing before the feature | M4 | BR-02 |
| FR-BUILD-02 | Lane templates implement contract clauses C1, C2 and C7 | M4 (astro), M6 (other lanes) | BR-05 |
| FR-BUILD-03 | Verify specs and checks carry stable `id`s | M0 | BR-02 |
| FR-BUILD-04 | Every owner complaint becomes a criterion and a check | M3 (criteria tooling), M4 (skill) | BR-02 |
| FR-BUILD-05 | The build skill selects verify modes per lane and per criterion | M4 | BR-05 |
| FR-BUILD-06 | Clauses C3–C6 are taught by the build skill and checked by doctor where possible | M4 (astro), M6 | BR-05, BR-06 |

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
- This lands in M0, because the first cycle's graders, intent criteria and pattern `catches` all
  refer to check ids. Today `validate.ts` rejects an `id` with `unsupported field "id"`.
- `packages/verify` accepts `id` on specs and api checks as defined in 08 §6. It rejects duplicates
  within a config with a strict-spec error.
- The verify-config loader preserves the named `meta` export (08 §6) alongside the default export,
  so that C7 environment-invariant markings reach the report. A function-form default export is
  inspected by calling it once per context (`preview`, `beta`, `prod`).
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

| id | title | milestone | BR |
|---|---|---|---|
| FR-LOOP-01 | `on-start` hook: `wiki context <name>` before any change | M3 | BR-01, BR-11 |
| FR-LOOP-02 | `on-failure` hook: `wiki lookup` keyed to failing check ids | M3 | BR-13 |
| FR-LOOP-03 | `on-complete` hook: raw capture and intent update | M3 (minimal redacted capture), M6 (automatic sinks) | BR-12, BR-01 |
| FR-LOOP-04 | `on-incident` hook: record an incident reference for the maintainer | M3 | BR-13 |
| FR-LOOP-05 | StageEvents carry every skill version, the agent, a raw id and a `promote` stage | M0 (schema), M3 (emitted) | BR-12 |
| FR-LOOP-06 | Every production mutation requires an owner approval artifact bound to the tool and sha (18) | M0 (blocking issue recorded), M5 (enforced) | BR-08 |
| FR-LOOP-07 | `auto-on-green` for eligible low-stakes tools, itself an owner-approved policy | M5 | BR-08 |
| FR-LOOP-08 | Verify failure reports link matching confirmed patterns | M3 | BR-13 |

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
- With `promotion: human`, no agent action can cause a production mutation. Every production
  channel in the release authorization matrix (18) runs only in a protected execution identity's
  job. That job proceeds only for a commit carrying an owner approval artifact bound to the tool
  name and sha (18).
- An approval is never inferred from the GitHub actor type, a TTY, or a workflow's environment name.
  A workflow naming an environment proves nothing about whether reviewers are configured on it.
- DR-34 fails when a production-mutating workflow is not bound to the protected approval.
- Until M5 enforces this, the gap is recorded as a blocking issue on every deployment-related item
  (M0).

**FR-LOOP-07.**
- `promotion: auto-on-green` is valid only under the 08 §1.2 restrictions. Setting it, or changing
  it, is itself a policy edit that requires owner approval through the same protected path. An
  agent's commit that changes `promotion` grants no authority until the owner has approved that
  commit.
- With the policy approved, a green beta ship dispatches promotion automatically, and the approval
  artifact names the approved policy commit as its source.

**FR-LOOP-08.**
- The human report and the `--json` export both carry the links.
- The links appear within the same run's output, with no extra command required.

### 2.4 Portfolio (`FR-PORT`)

| id | title | milestone | BR |
|---|---|---|---|
| FR-PORT-01 | `greenlight portfolio` summarizes every tool | M6 | BR-07 |
| FR-PORT-02 | Manifest `liveness` declaration with consistency validation | M4 | BR-06 |
| FR-PORT-03 | Doctor liveness rules DR-20 to DR-23 | M4 | BR-06 |
| FR-PORT-04 | Retirement lifecycle (`active → retiring → retired`) with plan-bound deletion authorization | M5 | BR-09 |
| FR-PORT-05 | Quota accounting via provider usage functions | M6 | BR-04, BR-07 |
| FR-PORT-06 | Generated `wiki/portfolio.md` | M6 | BR-07 |

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
- **The current guard cannot do this.** The guard emitted by `init` (`cli/src/commands/init.ts`)
  exits 1 when a plan deletes a Supabase, Neon, D1 or R2 store. Approval cannot resume a failed plan
  job, so retirement needs its own lifecycle (18, 10). Removing the general guard is never part of
  that lifecycle.
- `retire <name> --dry-run` produces an **inventory** of every resource the tool owns:
  - Terraform addresses;
  - Wrangler-managed resources;
  - adopted provider projects;
  - DNS records, keepalive targets and secrets.

  Each resource gets an ownership verdict: `owned`, `shared` (`dataShareWith`, or used by another
  tool) or `adopted`.
- Without `--dry-run`, the tool moves to `retiring`. A branch `retire/<name>` removes the
  declarations. It also writes a deletion authorization that lists exactly the planned resource
  addresses and the plan's hash, and records the data disposition (export, keep or delete) for
  each store.
- The guard permits deletion only when the plan's delete set equals the authorized set, and the
  owner has approved that authorization through the protected path. Any other delete is refused, as
  today. A shared store is never authorized.
- Wrangler-managed and adopted resources have explicit outcomes in the inventory, either deleted by
  a named command or detached and left in place. The inventory stays in
  `wiki/tools/<name>/retirement.md` until every item is confirmed gone. Only then does the tool
  become `retired`.
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

| id | title | milestone | BR |
|---|---|---|---|
| FR-WIKI-01 | Page schemas and `wiki lint` with LR-01 to LR-21 | M1 (subset), M3 (full) | BR-01, BR-11 |
| FR-WIKI-02 | Framework wiki packaged with the CLI and materialized by `agent sync` | M3 | BR-15 |
| FR-WIKI-03 | Project wiki layout and tool-repo pointer block | M3 | BR-01 |
| FR-WIKI-04 | Status lifecycle enforced | M1 | BR-13 |
| FR-WIKI-05 | `wiki lookup` and `wiki context` | M3 | BR-01, BR-13 |
| FR-WIKI-06 | `wiki ingest`: maintainer bundle, validation and atomic patch application | M1 | BR-13 |
| FR-WIKI-07 | `wiki contribute`: upstream a project pattern by PR | M6 | BR-17 |
| FR-WIKI-08 | Filtering by `affects` and `relevance`; fixed-in-newer report from local knowledge or an opt-in advisory feed | M3 (local), M6 (advisory feed) | BR-15 |
| FR-WIKI-09 | Raw store with Tracer as an optional sink | M1 (local), M6 (Tracer) | BR-12 |
| FR-WIKI-10 | Seed content for both wikis | M1 (cycle seeds), M3 (project wikis) | BR-01, BR-13 |

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
- Patterns carry `affects` (the framework versions with the defect) and `relevance`
  (`framework-version`, `app-code` or `both`) in place of `applies` (08 §3.1).
- A pattern whose relevance includes `app-code` is surfaced on a matching app-level recurrence even
  on a fixed framework version.
- DR-33 reports only what the installed wiki knows, unless the owner opts into
  `greenlight advisories`. That command fetches the wiki index of the newest published version, so
  that an older client can learn about later fixes. The command and its source are named in the
  report.

**FR-WIKI-09.**
- Raw records are written locally.
- When `GREENLIGHT_INGEST_URL` is set, they are also posted best-effort, matching the current
  `ship` ingest behavior.
- Tracer accepts them as a new mode of run.
- The absence of Tracer changes nothing else.

**FR-WIKI-10.**
- The seed inventory in 15 is present, and every seeded page passes the **actual** `wiki lint`,
  not a review by eye. A pattern without a verified remediation is `hypothesis`, never
  `confirmed`.
- Framework seeds use generalized prose. Evidence links to the owner's repos are kept through the
  LR-19 evidence exception.
- Each of the six live tools has `intent.md` and `liveness.md`.

### 2.6 Managed skills (`FR-SKILL`)

| id | title | milestone | BR |
|---|---|---|---|
| FR-SKILL-01 | Every Greenlight skill has a `PURPOSE.md` citing confirmed pages | M3 | BR-11 |
| FR-SKILL-02 | Skills declare hooks, and hook commands exist | M3 | BR-11 |
| FR-SKILL-03 | Only the harness bumps a managed skill's `version` | M1 (lint), M2 (harness) | BR-14 |
| FR-SKILL-04 | New skills: `greenlight-kickoff`, `greenlight-build`, `greenlight-wiki`, `greenlight-portfolio` | M1 (wiki), M4 (kickoff, build), M6 (portfolio) | BR-03, BR-07, BR-13 |
| FR-SKILL-05 | `skillVersions()` covers every managed skill | M3 | BR-12 |
| FR-SKILL-06 | Each skill declares a blast radius that sets gate strictness | M1 | BR-14 |
| FR-SKILL-07 | Provider skills' footgun sections become rules plus links | M3 | BR-11 |

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
- A bump without a `candidate-accepted` event followed by a `merged` event fails.
- **Temporary path until a skill's bench slice exists (M1–M3).** A human-reviewed PR may change a
  skill and bump its version. The PR must carry a ledger event with `path: "neutral"` or
  `path: "safety-fix"`, the reviewer's reason and the evidence refs that motivated it. Once the
  skill's bench slice is active, this path closes for that skill (05 §4).
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

| id | title | milestone | BR |
|---|---|---|---|
| FR-EVO-01 | Bench task format and runner with isolated rollout and grading | M1 | BR-14 |
| FR-EVO-02 | Mutation checks for every grader | M1 | BR-14 |
| FR-EVO-03 | Proposer bundle and output validation | M1 | BR-13 |
| FR-EVO-04 | Outlet routing: strongest available outlet first | M1 | BR-13 |
| FR-EVO-05 | Gate under one policy table: safety before efficacy, per model and mode | M1 (gate), M2 (first run) | BR-14 |
| FR-EVO-06 | Harness-only ledger and the rendered `skill-impact.md` | M1 | BR-13, BR-14 |
| FR-EVO-07 | Field monitor raises an alarm on first-pass or rollback regression per skill version | M6 | BR-14 |
| FR-EVO-08 | The loop skill is evolved under the same gate at the highest blast radius | M1 (policy), M3 (loop slice) | BR-14 |
| FR-EVO-09 | Training rollouts are generated under the accepted skill set and refreshed | M1 | BR-14 |
| FR-EVO-10 | Training, validation and test evidence are separated by mechanism | M1 | BR-14 |
| FR-EVO-11 | Baseline identity is content-addressed and invalidates on any input change | M0 (schema), M1 | BR-14 |
| FR-EVO-12 | Behaviour graders: `app`, `trajectory`, `maintainer`, `routing`, `repro` | M1 (app, trajectory, maintainer), M3 (routing, repro) | BR-14 |
| FR-EVO-13 | Isolation and production evaluation modes | M1 (isolation), M3 (production) | BR-14 |
| FR-EVO-14 | Acceptance rule per outlet | M2 | BR-13, BR-14 |
| FR-EVO-15 | Ledger stages recorded separately | M0 (schema), M1 | BR-13, BR-14 |
| FR-EVO-16 | Release check on the held-out test split | M3 | BR-14 |
| FR-EVO-17 | Content-addressed evaluation records and `bench gate --recompute` | M1 | BR-14 |
| FR-EVO-18 | Budgets in one schema, persisted as ledger spend events, serialized | M1 (per-gate caps), M6 (monthly, scheduled) | NFR-02 |
| FR-EVO-19 | The first iteration runs with a control arm | M2 | BR-14 |

**FR-EVO-01.**
- `greenlight bench run [--split train|val|test] [--model m] [--runs n] [--tasks glob] [--mode
  isolation|production]` executes tasks in the 08 §10 format.
- Each rollout runs as an unprivileged user in a rollout container with only `brief.md` and the
  fixture visible. Graders and mutants are never mounted into that container (06 §4.2).
- When the rollout ends, the runner kills its process tree. It grades in a separate container over
  a read-only mount of the final tree.
- Results are raw records of kind `bench`, carrying task, split, model, mode, skill-set hash and
  run identity (08 §5).

**FR-EVO-02.**
- `greenlight bench check-graders` applies each mutant and runs the grader. It fails when any
  mutant passes.
- CI runs it on any change under `bench/`.

**FR-EVO-03.**
- `wiki propose` prints a bundle with the proposer prompt (06 §3), the index, the ledger and an
  outcome summary built from training evidence and aggregate validation scores only (06 §1.4).
  It grants read-only access to training traces.
- A `patch` may carry edits to several files, each edit naming its `file` (`SKILL.md`,
  `PURPOSE.md` or a template path), so that a skill and its citations change atomically.
- `wiki propose --apply` validates a `ProposerOutput` (08 §9.2).
- The proposer prompt requires at least four traces read before a non-`no_action` output.

**FR-EVO-04.**
- The proposer prompt includes the outlet ranking (ADR-01).
- A `skill` outlet for a pattern whose class has a mechanical remedy triggers LR-18, and the bundle
  states the remedy.

**FR-EVO-05.**
- `bench gate <proposalId>` implements 06 §5.1 with the thresholds of the single policy table in
  06 §5.4:
  - **Safety.** Replay non-regression on both models and both modes at every blast radius, with 3
    of 3 required at high radius.
  - **Efficacy.** Strict capability improvement in isolation mode, per radius.
  - **Production mode.** Must not regress.
- The safety-fix and neutral-prerequisite paths replace efficacy, never safety. They are
  human-reviewed and labelled in the ledger.
- Policy boundary vectors, a fixture set of evidence at each threshold edge, each produce exactly
  one documented result (13 §2).
- Three runs are made per model and mode, with early stop when R = 1.0 on every model.

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
- Proposals targeting `deploy-verify-promote` are high blast radius (06 §5.4): every
  baseline-passing replay task passes 3 of 3 on both models in both modes, and capability strictly
  improves on both models.
- Its bench slice includes `trajectory` tasks (06 §4.6). These tasks distinguish two rollouts that
  produce byte-identical apps but differ in release behaviour.
- A candidate reaching `candidate-accepted` still needs a human merge and a release that passes the
  held-out test check (FR-EVO-16).
- Their release notes quote the ledger events.

**FR-EVO-09.**
- `ITERATE` (06 §1.3) runs train rollouts under the accepted skill set before the maintainer pass,
  whenever the cached train rollouts' baseline identity differs from the current one.
- A merged skill or template change invalidates the cache, and the next iteration regenerates it.
- Field raw records supplement the controlled train rollouts. They never replace them.

**FR-EVO-10.**
- Proposer and maintainer run in a sandbox that holds only their bundle (06 §1.4).
- `wiki read raw:` and `wiki traces` refuse val and test records for the proposer role.
- A unit test asserts that no val or test task id, grader path or mutant path appears in any
  generated bundle.

**FR-EVO-11.**
- Every evaluation stores a `BaselineIdentity` (08 §10.3). Changing any of the following
  invalidates the stored baseline before the next comparison:
  - a task, its fixture or its split;
  - a grader or mutant;
  - a runner dependency;
  - the sandbox image;
  - the agent runtime;
  - a model;
  - the proxy policy;
  - the wiki snapshot in production mode.
- A comparison across mismatched identities is a harness error.

**FR-EVO-12.**
- `TaskSpec.graders` (08 §10) selects the grader kinds. A task passes only if every one of them
  passes.
- Trajectory shims write through a channel the agent cannot edit (06 §4.6).
- Every grader kind has mutants, and `bench check-graders` fails when any mutant passes.

**FR-EVO-13.**
- `--mode isolation` sets `GREENLIGHT_WIKI=off` and removes the wiki.
- `--mode production` runs the hooks against a pinned wiki snapshot.
- Ledger evidence carries one result per model and mode.

**FR-EVO-14.**
- Each outlet uses the acceptance rule in 06 §5.6:
  - skill: controlled rollouts;
  - template: generated-app tests plus template mutants;
  - mechanism and doctor: a trusted reproduction that fails before the change and passes after;
  - verify: rejection of the faulty artifact.
- A mechanism or doctor fix is never required to raise capability scores.

**FR-EVO-15.**
- The ledger records `no-action`, `candidate-rejected`, `candidate-accepted`, `merged`,
  `released`, `verified-in-production` and `withdrawn` as separate append-only events (06 §6.1).
- A pattern's remediation becomes `verified` only at the stage 06 §6.1 allows.

**FR-EVO-16.**
- A release carrying skill or template changes runs the test split against the previous release on
  both models and modes (06 §5.7).
- Any test replay regression, or a capability drop of more than one task-mean, blocks the release
  unless a recorded human override applies to a non-high-radius skill.

**FR-EVO-17.**
- Every evaluation writes an `EvaluationRecord` (08 §10.4). It holds per-task, per-run, per-model
  and per-mode outcomes, seeds and costs.
- `bench gate --recompute <hash>` reproduces the decision from the record alone, with no new
  rollouts.

**FR-EVO-18.**
- `bench/budget.json` uses the schema `{monthlyUsd, perGateMaxUsd, perGateMaxRollouts}` in every
  command and workflow.
- Spend is persisted as harness-written ledger `spend` events.
- `evo.yml` runs in the concurrency group `greenlight-evo`.
- A gate whose expected cost exceeds a cap is refused before any rollout.

**FR-EVO-19.**
- The first iteration (06 §10) also evaluates a hand-written overgeneralized control proposal. That
  proposal is labelled `control` and is never merged.
- The iteration passes its own check only if the control is rejected.

### 2.8 Secrets (`FR-SEC`)

| id | title | milestone | BR |
|---|---|---|---|
| FR-SEC-01 | One readable secret source: Infisical by default | M5 | BR-10 |
| FR-SEC-02 | `--sink github` fallback preserves today's model | M5 | BR-10 |
| FR-SEC-03 | Provider-registry `inject` field and `secrets proxy-config` | M5 | BR-10 |
| FR-SEC-04 | Agents run under a declared trust model (A isolated, B local convenience) | M5 | BR-10 |
| FR-SEC-05 | Release authority holds over every production-mutation channel (18) | M5 | BR-08 |
| FR-SEC-06 | Redaction at raw capture and LR-20 in the wikis | M1 (lint), M3 (capture) | BR-10 |
| FR-SEC-07 | CI-only tokens listed explicitly (DR-30) | M5 | BR-10 |
| FR-SEC-08 | Proxy response scrubbing for declared paths | M5 | BR-10 |

**FR-SEC-01.**
- `secrets gather` writes to Infisical when `GREENLIGHT_SECRET_SINK=infisical`. This is the
  default for new `init` once M5 ships.
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
- Two trust models are supported and named in the output of `agent run` and `doctor` (18, ADR-17).
  - **Trust model A (isolated).** The agent runs in a separate sandbox: a container, VM, cloud
    session or separate OS user. That sandbox holds no operator credentials, key files, credential
    helpers, agent sockets or parent-process credentials. Its egress is enforced by network policy
    that allows only the proxy and the declared registries. Approval signing is outside the
    sandbox's reachable authority.
  - **Trust model B (local convenience).** `agent run -- <cmd>` replaces environment values and
    sets `HTTPS_PROXY`. It is documented as routing configuration, with no adversarial guarantee.
- The M5 drill, run under model A, shows that the agent cannot:
  - read a planted operator credential;
  - mint an approval through a pseudoterminal;
  - inherit a credential helper;
  - complete a denied provider operation through another route.

**FR-SEC-05.**
- The release authorization matrix (18) lists every target × channel that can change production:
  - Git pushes to production-triggering refs, through any Git API;
  - workflow dispatches, by file name or numeric workflow id;
  - direct provider deployments (Cloudflare script PUTs, Vercel production deployments and
    promotions);
  - infrastructure apply;
  - OCI's direct-to-prod path;
  - recovery.
- Agents hold only beta-scoped capabilities. For Cloudflare this means a separate free account for
  beta (18). Production mutation belongs to the protected execution identity.
- Recovery may redeploy only the last approved immutable artifact (DR-36).
- Acceptance: an unapproved attempt through every channel fails; an approved artifact succeeds; a
  policy edit cannot grant the agent new authority (13 §4, M5).

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

| id | title | milestone | BR |
|---|---|---|---|
| FR-AGENT-01 | Portable skills: `SKILL.md` uses only standard frontmatter plus `version` | M1 onward | BR-16 |
| FR-AGENT-02 | Anything an agent queries is a CLI command | M1 onward | BR-16 |
| FR-AGENT-03 | Gates are enforced in CI and the CLI, never only in skill text | M0 onward | BR-08, BR-16 |
| FR-AGENT-04 | `agent sync` writes `.agents/skills` and `AGENTS.md` (stretch) | M7 | BR-16 |
| FR-AGENT-05 | Codex cloud secrets path documented and tested (stretch) | M7 | BR-16 |

**FR-AGENT-01.**
- Lint rejects any `SKILL.md` frontmatter key other than `name`, `description` and `version`.
- Claude-specific body hints are allowed only when the drill shows the skill still works for an
  agent that ignores them. Until M7 this is reviewed by hand, and in M7 it is tested with Codex.

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
- The M7 drill passes.

## 3. Non-functional requirements

| id | requirement | measure |
|---|---|---|
| NFR-01 | **Security.** No raw credential is ever written to the repo, the wiki or a raw record, and none is reachable from an agent running under trust model A after M5. | Planted-secret test; LR-20; the M5 isolation drill |
| NFR-02 | **Cost.** The default path, including bench scoring, costs $0 in infrastructure; the LLM spend of one `bench gate` is bounded and reported. | `bench gate` prints the token totals from `VerifyReport.tokensIn/Out/costUsd`; the drills run on free accounts |
| NFR-03 | **Latency.** `wiki context` and `wiki lookup` return in under 1 s on a wiki of 500 pages; `accounts` returns within 15 s online, or 1 s with a warm cache or `--offline`. | Benchmarked in CI with a generated fixture wiki |
| NFR-04 | **Determinism.** Given the same inputs, `wiki lint --fix`, the index render, the ledger render and `proxy-config` produce byte-identical output. | Golden-file tests |
| NFR-05 | **Strictness.** Every machine-written artifact is validated before it is trusted, unknown fields are errors, and a rejected write changes nothing. | Contract tests (13 §2.3) |
| NFR-06 | **Portability.** Skills work for an agent that reads only standard SKILL.md frontmatter and command output. | FR-AGENT-01 lint; M7 drill |
| NFR-07 | **Compatibility.** Existing wrappers keep working through every milestone without manifest edits; new requirements arrive as doctor warnings first. | `RTrentJones.dev` CI stays green at each release |
| NFR-08 | **Readable output.** Human CLI output stays readable at 100 columns and without colour; every human report has a `--json` equivalent; nothing essential is conveyed by colour alone. | Snapshot tests with `NO_COLOR=1` |
| NFR-09 | **Bounded review load.** The evolution loop produces at most one proposal per invocation and never opens more than three open `skill-alarm` or proposal issues at once. | Harness counter, enforced in code |
| NFR-10 | **Offline operation.** Lint, context, lookup and the renders work without network access. | CI runs them with networking disabled |

## 4. Traceability

| BR | FR | milestone |
|---|---|---|
| BR-01 | FR-WIKI-01, FR-WIKI-03, FR-WIKI-05, FR-WIKI-10, FR-KICK-03, FR-LOOP-01, FR-LOOP-03 | M1, M3, M4 |
| BR-02 | FR-KICK-03, FR-BUILD-01, FR-BUILD-03, FR-BUILD-04 | M0, M3, M4 |
| BR-03 | FR-KICK-04, FR-KICK-05, FR-KICK-08, FR-SKILL-04 | M4 |
| BR-04 | FR-KICK-01, FR-KICK-02, FR-KICK-07, FR-PORT-05 | M4, M6 |
| BR-05 | FR-KICK-06, FR-BUILD-02, FR-BUILD-05, FR-BUILD-06 | M4, M6 |
| BR-06 | FR-KICK-06, FR-PORT-02, FR-PORT-03, FR-BUILD-06 | M4 |
| BR-07 | FR-PORT-01, FR-PORT-05, FR-PORT-06, FR-SKILL-04 | M6 |
| BR-08 | FR-LOOP-06, FR-LOOP-07, FR-SEC-05, FR-AGENT-03 | M0 (recorded), M5 |
| BR-09 | FR-PORT-04 | M5 |
| BR-10 | FR-SEC-01 to FR-SEC-08 | M1, M3, M5 |
| BR-11 | FR-SKILL-01, FR-SKILL-02, FR-SKILL-07, FR-LOOP-01, FR-WIKI-01 | M1, M3 |
| BR-12 | FR-LOOP-03, FR-LOOP-05, FR-WIKI-09, FR-SKILL-05 | M0, M1, M3 |
| BR-13 | FR-LOOP-02, FR-LOOP-04, FR-LOOP-08, FR-WIKI-04, FR-WIKI-06, FR-EVO-03, FR-EVO-04, FR-EVO-06, FR-EVO-14, FR-EVO-15 | M1, M2, M3 |
| BR-14 | FR-SKILL-03, FR-SKILL-06, FR-EVO-01, FR-EVO-02, FR-EVO-05, FR-EVO-07 to FR-EVO-19 | M0, M1, M2, M3, M6 |
| BR-15 | FR-WIKI-02, FR-WIKI-08 | M3, M6 |
| BR-16 | FR-AGENT-01 to FR-AGENT-05 | M0 onward, M7 |
| BR-17 | FR-WIKI-07, FR-WIKI-04 | M1, M6 |
