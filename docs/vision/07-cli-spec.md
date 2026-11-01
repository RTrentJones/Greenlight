# 07 — CLI specification

This document specifies every new or changed `greenlight` command. Commands that this pack does
not change (`lanes`, `config`, `deploy`, `adopt`, `migrations scan`, `bump`) keep their current
behavior, and they are listed in section 1 only for completeness.

## 0. Rules for every command

- **Parsing.** Flags are declared through `parseFlags(command, args, { value, boolean })`
  (`cli/src/args.ts`), as the existing commands do. An unknown flag is an error, and it exits with
  code 2.
- **Exit codes.** Every command uses these codes:

  | code | meaning |
  |---|---|
  | 0 | success |
  | 1 | the command ran and its gate or check failed |
  | 2 | usage error |
  | 3 | missing prerequisite (token, tool, file); the message names the fix |
  | 4 | refused by policy (promotion policy, ledger writer, lint error that blocks the write) |

- **JSON output.** A command with `--json` prints exactly one JSON document to **stdout**, and
  human output goes to **stderr**. This is the convention `verify --json` already follows
  (`packages/verify/src/export.ts`), so `… --json | jq` stays clean.
- **No secret values in output.** No command prints a secret value, writes one to disk, or passes
  one in argv. This extends the existing `secrets gather` guarantee to every command.
- **Idempotency.** Every write is idempotent. Running a command twice with the same inputs leaves
  the same files. The exceptions are append-only artifacts (`log.md`, raw records,
  `ledger.jsonl`), and those append exactly one entry per logical event, keyed by an id.
- **Environment variables.** Every command honours these:

  | variable | effect |
  |---|---|
  | `GREENLIGHT_AGENT` | `claude`, `codex` or `other`; stamped into stage events and raw records (08 §5, §7) |
  | `GREENLIGHT_MODEL` | the agent's model id; stamped likewise, and used as the maintainer actor in `log.md` |
  | `GREENLIGHT_SESSION` | proxy session id (set by `agent run`); recorded as `agent.sessionRef` |
  | `GREENLIGHT_RAW=off` | disables raw capture everywhere (`preview`, `ship`, `promote`, `wiki capture` becomes a no-op that exits 0) |
  | `GREENLIGHT_WIKI=off` | disables every wiki hook: no `wiki:` block in failure reports, and `wiki context`/`wiki lookup` print nothing and exit 0. **The bench runner sets it for every rollout** (06 §4.2) |
  | `GREENLIGHT_SECRET_SINK` | overrides `secrets.sink` (`infisical` or `github`) |
  | `GREENLIGHT_INGEST_URL` | Tracer (or any OTel-shaped) ingest endpoint for raw records and stage events; with `GREENLIGHT_INGEST_TOKEN`. Replaces the per-command ingest wiring |
  | `GREENLIGHT_SKILL_VERSION` / `GREENLIGHT_SKILL_VERSIONS` | override the skill version stamp(s) (08 §7) |
  | `GREENLIGHT_CAPTURE=1` | makes a standalone `verify` write a raw record |

  Nothing requires any of them.

## 1. Command inventory

| command | status | phase | serves |
|---|---|---|---|
| `init` | changed (no-domain) | P2 | FR-KICK-04 |
| `add` | changed (liveness, intent stub, contract templates) | P0, P1 | FR-KICK, FR-BUILD, FR-WIKI |
| `adopt` | changed (wiki pointer block, liveness prompt) | P0 | FR-WIKI |
| `preview` | changed (raw capture, skills map) | P5 | FR-LOOP, FR-WIKI |
| `ship` | changed (raw capture, skills map) | P5 | FR-LOOP |
| `verify` | changed (check ids, wiki links, `eval.check_id`) | P0, P5 | FR-LOOP, FR-WIKI |
| `promote` | changed (policy, approval, `promote` stage) | P3, P4 | FR-LOOP, FR-PORT, FR-SEC |
| `status` | changed (beta/prod sha pair) | P3 | FR-PORT |
| `doctor` | changed (rules DR-12…DR-33) | P0–P5 | all |
| `secrets gather / check` | changed (`--sink`) | P4 | FR-SEC |
| `secrets proxy-config` | new | P4 | FR-SEC |
| `agent sync` | changed (framework wiki, PURPOSE.md, pointer, `.agents`) | P0, P7 | FR-SKILL, FR-AGENT |
| `agent run` | new | P4 | FR-SEC, FR-AGENT |
| `accounts` | new | P2 | FR-KICK, FR-PORT |
| `portfolio` | new | P3 | FR-PORT |
| `retire` | new | P3 | FR-PORT |
| `wiki lint / render` | new | P0 | FR-WIKI |
| `wiki context` (alias `wiki lookup --tool <t> --start`) | new | P0 | FR-WIKI, FR-SKILL |
| `wiki lookup` | new | P5 | FR-WIKI, FR-LOOP |
| `wiki read` | new | P0 | FR-WIKI |
| `wiki incident open` | new | P5 | FR-WIKI |
| `wiki traces` | new | P6 | FR-EVO |
| `wiki stats` (alias `wiki metrics`) | new | P5 | FR-EVO, FR-SKILL |
| `wiki capture` | new | P5 | FR-WIKI |
| `wiki ingest` | new | P5 | FR-WIKI, FR-EVO |
| `wiki propose / remediate` | new | P5, P6 | FR-EVO |
| `wiki contribute` | new | P5 | FR-WIKI |
| `bench run / gate / check-graders / monitor / report` | new | P6 | FR-EVO |
| `lanes`, `config`, `deploy`, `migrations scan`, `bump` | unchanged | — | — |

## 2. Changed commands

### 2.1 `init`

```
greenlight init [--domain <domain> | --no-domain] [--cf-subdomain <sub>] [--repo o/r]
                [--sink infisical|github] [--force] [--no-push] [--no-tokens] [--no-verify]
```

**Changes from the current command** (`cli/src/commands/init.ts`, which today requires
`--domain`, or a TTY prompt for it):

1. **No-domain mode** is selected by `--no-domain`, or by running `init` without `--domain` when
   there is no TTY to prompt, or when the operator answers the domain prompt with an empty line.
   The explicit flag exists so that scripts and skills can state intent. In this mode `init` writes
   a manifest without `domain` and with `cloudflareAccountSubdomain: <sub>`
   (08 §1.2). If `--cf-subdomain` is absent and a Cloudflare token is available, `init` reads the
   account's workers.dev subdomain from the Cloudflare API
   (`GET /accounts/{id}/workers/subdomain`). If neither is available, it exits 3 with the message
   `no-domain mode needs the account's workers.dev subdomain: pass --cf-subdomain or provide CLOUDFLARE_API_TOKEN`.
2. With no domain, the base-token gathering skips the zone id. The emitted `infra.yml` omits DNS
   resources, because the workers.dev and vercel.app hosts need none.
3. `--sink` chooses where `secrets gather` writes (§2.10). The default is `github` until P4 ships,
   and `infisical` after that (ADR-06). The choice is recorded in `greenlight.config.ts` as a
   comment-free field `secrets: { sink }`. This is an additive ConfigSchema field, which 08 does
   not list because it has no effect beyond the CLI.
4. `init` writes `wiki/index.md`, `wiki/log.md` and `wiki/portfolio.md` stubs (04 §2.2) when they
   are absent.

It still never clobbers existing files unless `--force` is given. That is unchanged.

**Exit codes:** 0, 2 (both `--domain` and `--no-domain` given), 3.

### 2.2 `add`

```
greenlight add <name> --lane <l> --target <t> [--data <d>] [--auth <a>] [--envs beta,prod]
               [--liveness needs-traffic|needs-silence|needs-heal|always-on] [--probe <path>]
               [--promotion human|auto-on-green] [--accept-headroom] [--no-tokens]
```

**Changes:**

1. **Liveness.** `--liveness` defaults from the data/target decision table (10 §1.2). `--probe`
   is required for `needs-traffic` and `needs-heal`. For `needs-traffic` (Supabase) the probe is a
   table name, which is written both to `liveness.probe` and to the keepalive target's
   `probeTable`. The entry is validated by the 08 §1.2 rules before anything is written.
2. **Templates carry the contract (P1).** The scaffold copies the lane template, which now
   implements C1, C2 and C7 for every lane (09 §3). The generated `verify.config.ts` already
   contains checks with ids `identity`, `live` and `ready` (09 §2).
3. **Project wiki stubs.** `add` writes `wiki/tools/<name>/intent.md` with an empty `criteria`
   list and a `TODO: confirm with the owner` line. It also writes `liveness.md`, filled from the
   flags, and `decisions.md`, with a dated entry recording the cell choice. It appends a `log.md`
   entry with actor `harness`.
4. **Headroom warning (P3).** Before writing anything, `add` runs the quota projection in 10 §3.3
   for the quotas the new tool would draw on. If any quota would exceed 80%, it prints the warning
   and asks for confirmation on a TTY. Without a TTY it requires `--accept-headroom`, and otherwise
   exits 4.
5. **No domain.** When the manifest has no domain, `add` refuses targets other than `workers` and
   `vercel` and exits 2, naming FR-KICK-04.

**Idempotency:** re-running `add` for an existing name exits 2. That is unchanged.

### 2.3 `adopt`

This command keeps all its current flags. Two things are added:

1. It prompts for `--liveness` and `--probe`, or takes them as flags, with the same defaults as
   `add`.
2. It writes the wiki pointer block (04 §2.2) into the tool repo's `CLAUDE.md`, between the
   `<!-- greenlight:wiki -->` markers, and replaces any existing block. In wrapper-centric mode
   this lands in the submodule, and the operator commits it there. The wrapper-side stubs are
   written as in `add`.

### 2.4 `preview`

```
greenlight preview <name> [--no-build] [--port <p>] [--config <path>] [--events <file>] [--no-capture]
```

`--config <path>` runs the local gate with a verify config other than the tool's own. The bench
uses it to run a task's hidden grader (`bench/tasks/<id>/grader.verify.config.ts`) against the
agent's build, without the grader ever being placed in the sandbox the agent can read.

The existing behavior is kept: spin up, verify, write the receipt `.greenlight/preview-<sha>`, emit
a `preview` stage event. The additions:

1. A raw record (08 §5) with `kind: 'preview'` is written to `.greenlight/raw/` after every run,
   pass or fail, unless `--no-capture` is given. The record contains the stage events, the verify
   JSON document, the redacted excerpt (11 §6) and the `skills` map from `skillVersions()`
   (08 §7).
2. On failure, the human report ends with a `wiki:` block: up to three `confirmed` patterns whose
   `catches.checkSignature` matches a failing check id or name (§3.6). Each line carries the
   pattern's title and its path in `.greenlight/wiki/framework/` or `wiki/`.
3. `--events` is accepted with the same semantics as `ship`.

### 2.5 `ship`

```
greenlight ship <name> --env <beta|prod> [--expect-sha <sha>] [--events <file>] [--no-rollback] [--no-capture]
```

The changes are the same as for `preview`, steps 1 and 2. The raw record has `kind: 'ship'`, and
its `stages` are the full build → deploy → verify → rollback chain. `StageEvent.skills`,
`StageEvent.agent` and `StageEvent.rawId` are populated (08 §7). `skillVersion`, the version of
`deploy-verify-promote`, is still populated for compatibility. In CI the raw record is also
uploaded as a workflow artifact named `greenlight-raw-<rawId>`, and its `refs` include
`run:<owner>/<repo>/<runId>` from `GITHUB_RUN_ID`.

### 2.6 `verify`

```
greenlight verify <name> [--env <env> | --url <url>] [--spec <path>] [--wait <ms>] [--expect-sha <sha>]
                         [--json] [--no-wiki]
```

1. **Check ids** are accepted and reported (08 §6). A duplicate id within one tool's config fails
   spec validation as `spec is valid — duplicate check id "<id>"`.
2. **Wiki links** on failure are the same as in `preview` step 2. `--no-wiki` suppresses them.
   This matters in bench rollouts, where wiki access is forbidden (06 §4.2), and the bench runner
   sets it.
3. **JSON.** Each check entry in the `--json` export carries `eval.check_id` when the check has an
   id. A run-level `greenlight.wiki_hits` attribute lists the pattern ids that were surfaced.
4. `verify` does not write raw records. Its callers (`preview`, `ship`, CI) do. A standalone
   `verify` writes one only when `GREENLIGHT_CAPTURE=1` is set.

### 2.7 `promote`

```
greenlight promote <name> [--commit <sha>] [--perform] [--push] [--approval <token>]
greenlight promote <name> --commit <sha> --approve        # mint an approval record (TTY only; 11 §4.4)
```

**Current behavior** (`packages/loop/src/promote.ts`) is kept: a gated `develop → main`
fast-forward, pinned with `--commit`, which refuses if develop has moved. The additions:

1. **Policy.** The effective policy is `tool.promotion ?? config.promotion ?? 'human'`.
2. **`human`.** `--perform` requires one of two things. Either the command runs inside the
   `promote.yml` workflow (`GITHUB_WORKFLOW` equals the promote workflow's name, and
   `GITHUB_EVENT_NAME` is `workflow_dispatch`, with `GITHUB_ACTOR` not a bot), or `--approval`
   carries an approval record (11 §4.4). Otherwise it exits 4 with
   `promotion of <name> is human-only (policy: human); dispatch promote.yml or pass --approval`.
3. **`auto-on-green`.** `--perform` is allowed when the beta verify for `--commit` passed. That
   verify is read from the latest `ship` raw record for `(name, beta, sha)`, or from the
   `verify --expect-sha` run in the same workflow. The schema already restricts this policy to
   low-stakes tools (ADR-07).
4. **Stage event.** A `promote` stage event is emitted (08 §7) with `passed` and the promoted sha.
   Raw capture works as in `ship`.

**Exit codes:** 0; 1 (fast-forward refused, develop moved, or beta unverified); 4 (policy).

### 2.8 `status`

```
greenlight status <name> [--json]
```

This keeps the current run-chain output (`cli/src/commands/status.ts`). It adds a header line:
`beta <sha7> (verified|unverified|unknown) · prod <sha7> (…) · <n> commit(s) waiting`. The values
are computed exactly as in `portfolio` (§3.2), for one tool. `--json` prints that tool's entry in
the `PortfolioReport.tools[]` shape (08 §11.2).

### 2.9 `doctor`

```
greenlight doctor [--live] [--strict] [--json]
```

This keeps the current semantics: failures always exit 1, warnings exit 1 under `--strict`, and
`--live` adds network probes. It adds the rules in section 4 and `--json`, which prints
`{ checks: { id, name, status, detail }[] }`. Every check now carries its `DR-*` id, both in the
output prefix and in the JSON.

### 2.10 `secrets gather` and `secrets check`

```
greenlight secrets gather <name> [--repo o/r] [--env e] [--sink infisical|github] [--oci-config <p>] [--oci-key <p>]
greenlight secrets check [<name>] [--sink …] [--json]
```

1. **Sink.** `--sink` overrides the manifest's `secrets.sink`.
   - `github` is the current path: hidden prompt → `verify()` → `gh secret set` with the value on
     stdin.
   - `infisical` keeps the hidden prompt and `verify()`, then writes the secret through the
     Infisical CLI or API, again with the value on stdin, under the path `/<tool>/<ENV_VAR>`. The
     project and environment come from `secrets.infisical` (11 §2.2). It then ensures the GitHub
     sync covers the secret (11 §2.3).
2. **`check`** with the `infisical` sink reads secret *names* and metadata from Infisical, and also
   checks that GitHub has the synced names. It reports three states per token: `missing`,
   `present`, and `present but not synced to GitHub`.
3. **Unchanged guarantees.** The same token list per tool comes from the provider packs plus
   manifest `tokens`. There is still no disk write and no argv value.

### 2.11 `agent sync`

```
greenlight agent sync [<name>] [--codex]
```

**Current behavior** (`cli/src/commands/agent.ts`): it copies `deploy-verify-promote` and the
applicable provider skills into `.claude/skills/`, merges `.mcp.json`, and appends the loop block
to `CLAUDE.md`. The additions:

1. **Every managed skill is copied with its `PURPOSE.md`** (05 §2). The skill set is chosen from
   the catalogue (05 §4): always the loop, kickoff, build, portfolio and wiki skills, plus each
   applicable provider skill.
2. **The framework wiki** is materialized from the installed package into
   `.greenlight/wiki/framework/`. Any previous copy is replaced, a `VERSION` file holding the CLI
   version is written, and the directory is made read-only (chmod a-w). `.greenlight/` is already
   gitignored.
3. **The `CLAUDE.md` block** gains one line: `Project knowledge: wiki/ (read
   wiki/tools/<name>/intent.md and liveness.md before changing a tool).`
4. **With `<name>` for an adopted tool**, it also writes the pointer block into the submodule's
   `CLAUDE.md` (§2.3).
5. **`--codex` (P7)** also writes `.agents/skills/<skill>/` (byte-identical to `.claude/skills/`)
   and an `AGENTS.md` block with the same content as the `CLAUDE.md` block. Before P7 the flag
   exits 2 with `codex parity is a P7 stretch item`.

### 2.12 `agent run` (new, P4)

```
greenlight agent run [--proxy infisical|worker] [--ttl 8h] [--allow-promote] -- <agent command…>
```

This command launches an agent CLI (for example `claude`) as a child process behind the credential
proxy (11 §3).

1. It resolves the proxy from `secrets.proxy` in the manifest, or from `--proxy`.
2. It creates a proxy session (11 §3.3): a session identity with a TTL that defaults to 8h, and the
   allow-list rendered by `secrets proxy-config`. Without `--allow-promote`, the session's GitHub
   route denies workflow dispatch of `promote.yml` (11 §3.4).
3. It builds the child environment:
   - every `inject`-capable token's `envVar` set to a placeholder of the form
     `gl-placeholder-<ENV_VAR>`;
   - `HTTPS_PROXY`/`HTTP_PROXY` for the forward proxy, or `*_BASE_URL` overrides for the Worker
     proxy (11 §3.2);
   - `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS` (forward proxy only);
   - `GREENLIGHT_AGENT`, `GREENLIGHT_SESSION`.
4. It execs the child, forwards signals, and revokes the session on exit.
5. CI-only tokens (DR-30) are never placed in the child's environment.

**Exit code:** the child's exit code. If the proxy prerequisites are missing, it exits 3.

### 2.13 `secrets proxy-config` (new, P4)

```
greenlight secrets proxy-config [--format infisical|worker] [--out <dir>] [--check]
```

This renders the union of the configured tokens' `inject` specs (08 §12) into the proxy's format
(11 §4). `--format` defaults to `secrets.proxy` (`--proxy` is accepted as an alias). `--check` exits 1 if the rendered config differs from the deployed one, which makes it a
drift guard for CI. Output files contain host and route rules only, never values.

## 3. New commands

### 3.1 `accounts` (P2)

```
greenlight accounts [--json] [--offline] [--cell <lane/target/data>]
```

**Behavior:**

1. It loads the provider packs (`cli/src/providers.ts`) and the secret source (`secrets.sink`).
2. For each pack, `configured` means every non-optional token name exists in the source. The check
   is done by name only, and the GitHub sink uses `gh secret list`.
3. Unless `--offline` is given, it runs each pack's `verify()` in turn. This needs the value, so it
   runs only behind the credential proxy (`agent run`) or in an operator shell that holds the
   token. If the value is unavailable, `verified` is `null` and the output says why.
4. For each quota on each pack's `fact` page, it runs the pack's `usage()` function when one exists
   (08 §12), then computes headroom and consumers (10 §3).
5. It computes cell availability. A cell is available when every pack that the cell needs is
   configured. The packs a cell needs come from `mcpForTool`-style resolution: Cloudflare always,
   plus the target's pack, the data pack and HCP.
6. It prints a table to stderr, or the `AccountsReport` (08 §11.1) to stdout with `--json`.
   `--cell` narrows the report and exits 1 if that cell is unavailable. Kickoff uses this.

**Writes:** nothing. **Exit codes:** 0; 1 (with `--cell`, cell unavailable); 3 (no manifest).

### 3.2 `portfolio` (P3)

```
greenlight portfolio [--json] [--offline] [--write]
```

**Behavior.** For each tool in the manifest, plus the blog:

1. **`prod` and `beta` sha.** It GETs the resolved URL plus `/__version` (C1), with a 5s timeout.
   `verified` is true when the latest `ship` raw record or CI run for that environment at that sha
   passed. The CI run is found through `gh run list` on the deploy workflow, filtered by `headSha`.
2. **`waiting`.** `git rev-list --count origin/main..origin/develop`, after
   `git fetch origin main develop`. For a cross-repo tool, the command runs in the submodule. For a
   tool without beta (OCI, direct to prod), `waiting` is `null` and the cell reads `n/a (direct)`.
3. **`lastShip`.** The newest `ship` raw record, or the newest deploy-workflow run.
4. **`keepalive`.** The last sweep result from the keepalive Worker's status endpoint
   (`infra/modules/keepalive`), when one is exposed. Otherwise it is read from the keepalive's last
   alert-issue state.
5. **`alerts`.** Open issues carrying the alert sink's label, matched by tool name in the title.
6. **`quotas`.** As in `accounts`.

It prints one table, and `--json` emits `PortfolioReport` (08 §11.2). `--write` regenerates
`wiki/portfolio.md` from the report: one line per tool, carrying the cell, the liveness model, the
first criterion of `intent.md`, and the prod sha. `--offline` skips steps 1, 4 and 5.

**Exit code:** 0, even when some tools are unhealthy, because the command reports rather than
gates. It exits 3 when there is no manifest.

### 3.3 `retire` (P3)

```
greenlight retire <name> [--dry-run] [--yes] [--keep-wiki] [--data-waived]
```

This removes a tool from the portfolio (10 §5).

1. It prints what will happen. With `--dry-run` it stops after this step and writes nothing: the manifest entry, the `infra/<name>.tf` file and the resources it
   instantiates, the keepalive target, the workflows that mention the tool, and the quota that
   will be freed. Without a TTY and without `--yes`, it exits 2.
2. It removes the tool's entry from `greenlight.config.ts`, using the `config-io` writer that
   `add` uses.
3. It deletes `infra/<name>.tf` and removes the tool from the keepalive targets and the allow-list
   in `promote.yml`.
4. It moves `wiki/tools/<name>/` to `wiki/archive/tools/<name>/` (unless `--keep-wiki` is given),
   adds a `decisions.md` entry with the reason prompted from the operator, and appends a `log.md`
   entry.
5. It does **not** apply anything. The operator pushes the change, and `infra.yml` runs plan →
   destroy-guard → manual approval → apply. That is the existing gated apply from v0.10. The plan
   shows the destroys, and the guard requires approval, so a retirement cannot remove resources
   without a human seeing the plan.
6. It prints the follow-ups: delete the GitHub secrets that are now unused (it lists them), and
   archive the tool repo if one exists.

**Exit codes:** 0; 2; 3 (no such tool).

### 3.4 `wiki lint` and `wiki render` (P0)

```
greenlight wiki lint [--fix] [--strict] [--online] [--similar] [--json] [--framework]
greenlight wiki render
```

- **`lint`** runs LR-01…LR-21 (04 §5) over `wiki/`, or with `--framework` over the framework repo's
  `wiki/`.
  - It exits 1 on any error, and also on warnings with `--strict`.
  - `--fix` applies the automatic fixes: index regeneration, the id from the path, PURPOSE
    back-links, rendering the intent criteria table, rendering the ledger, and stubbing missing
    tool pages.
  - `--online` resolves each `EvidenceRef` through `gh api` (issues, PRs, commits, runs) and an
    HTTP HEAD (posts).
  - `--similar` prints the merge-candidate report (04 §8).
  - `--json` prints `{ findings: { rule, severity, page, message }[] }`.
- **`render`** regenerates `skill-impact.md` from `ledger.jsonl`, the index, and the criteria
  tables. `render` and `lint --fix` share an implementation.

### 3.5 `wiki capture` (P5)

```
greenlight wiki capture --kind <kind> --tool <name> --env <env> --passed <bool>
                        [--sha <sha>] [--ref <EvidenceRef>]… [--excerpt-file <path>] [--verify-json <path>]
greenlight wiki capture --from-issue <issue:o/r#n> [--tool <name>]
greenlight wiki capture --from-run <run:o/r/id> [--tool <name>]
```

`--from-issue` and `--from-run` build the record from GitHub through `gh`. For an issue, `kind` is
`alert` when the issue carries the alert label and `session` otherwise. `passed` is false while the
issue is open. The excerpt is the redacted body plus the last 5 comments. For a run, `kind` is
`ship` or `verify` from the workflow name, `gitSha` is `headSha`, `passed` is the conclusion, and
the excerpt is the redacted tail of the failing job log (`gh run view --log-failed`). `--tool` is
required when it cannot be inferred from the title or the workflow name.

This is the plumbing that `preview`, `ship` and `promote` call internally. It is also exposed so
that keepalive alerts, CI steps and bench runners can write raw records. It applies redaction
(11 §6) to the excerpt and truncates it to 15,000 characters, then writes
`.greenlight/raw/<rawId>.json` and prints the `rawId`. When Tracer is configured
(`TRACER_URL` plus an ingest token, the existing `stageEventToIngest` path), it also POSTs the
record. This is best-effort, with a 5s timeout, and never fails the command.

### 3.6 `wiki lookup` (P5)

```
greenlight wiki lookup [--check <id|name>]… [--class <class>] [--cell <lane/target/data>] [--tool <name>]
                       [--start] [--role maintainer|proposer] [--include-hypothesis] [--json]
```

**Selection:**

1. Candidates are the pages in both wikis with `type: pattern` and `status: confirmed` (plus
   `hypothesis` only if `--include-hypothesis` is given, which is never done in skills). Pages
   whose `applies` excludes the installed CLI version are dropped.
2. A page scores 3 for each `--check` that matches `catches.checkSignature` (regex, tested
   against the id first, then the name), 2 for a `--class` match, and 1 for a `--cell` glob match.
   Ties are broken by the most recent `updated`.
3. A `superseded` page that would match is replaced by the page its `supersededBy` points to.
4. The top 5 are output as title, id, path and the `## Fix / workaround` section. With `--json`,
   the output is `{ hits: { id, score, path, fix }[] }`.

Incident pages are never returned (ADR-10). `lookup` with `--tool` also prints that tool's
`liveness.md` summary line.

The `--role` form returns the reading set for an evolution role instead of patterns:

```
greenlight wiki lookup --role maintainer|proposer [--skill <name>] [--json]
```

`maintainer` returns the paths of the full wiki, including incidents, plus the latest ingest bundle.
`proposer` returns `index.md`, `skill-impact.md`, the outcome summary from `wiki stats`, and the
target skill's files (06 §2, §3). These are the only invocations that may return incident pages.
They are used by the `greenlight-wiki` skill and never by building skills.

### 3.6a `wiki context` (P0) — the on-start hook

```
greenlight wiki context <name> [--json]
greenlight wiki lookup --tool <name> --start [--json]        # equivalent form
```

This prints the bundle that every managed skill's `on-start` hook loads (05 §3):

- `wiki/tools/<name>/intent.md`, in full;
- `liveness.md`, in full;
- the first 40 lines of `decisions.md`;
- the tool's manifest entry;
- the open alert issues for the tool, titles only.

It never includes incidents. With `--json` the output is
`{ intent, liveness, decisions, manifest, alerts }`. If the tool has no pages yet, it prints the
manifest entry and `no project wiki for <name>: run greenlight wiki lint --fix to stub it`, and
exits 0, so that a hook never blocks work.

### 3.6b `wiki read` (P0)

```
greenlight wiki read <page-id> [--json]
```

This prints one page from the project wiki, or from the materialized framework wiki when the id
is not found locally. A `superseded` id is followed to its replacement, with a notice. A
`hypothesis` page is printed with a banner reading `HYPOTHESIS — not guidance`. Incident ids are
refused (exit 4) unless `--role maintainer` is also given.

### 3.6c `wiki incident open` (P5) — the on-incident hook

```
greenlight wiki incident open --tool <name> --ref <EvidenceRef> [--title <t>]
greenlight wiki incident close <incident-id> --ref <EvidenceRef>
```

`open` creates `wiki/tools/<name>/incidents/<yyyy-mm>-<slug>.md` with `status: hypothesis` and the
first timeline entry. It also captures the ref as a raw record (`wiki capture --from-issue` or
`--from-run`) and appends a log entry. `close` sets `closed`. It does not mark anything
`confirmed`, because confirmation is a maintainer step that needs red-to-green evidence (04 §4).

### 3.6d `wiki traces` (P6)

```
greenlight wiki traces [--failing|--passing] [--tool <name>] [--skill <name>@<version>] [--limit 20]
greenlight wiki traces show <rawId>
```

This is the proposer's read-only trace access. It follows the paper: no pre-sampled traces; the
proposer reads them on demand (06 §3). The list form prints `rawId`, tool, kind, passed, skills and
age. `show` prints one redacted raw record. Neither form writes anything.

### 3.6e `wiki stats` (alias `wiki metrics`) (P5)

```
greenlight wiki stats [--metric first-pass|rollback|push-to-healthy|settle-retries|cold-edit] [--skill <name>]
                      [--since <date>] [--by version|agent|model] [--json]
```

This computes field metrics from the raw store (and from Tracer when `GREENLIGHT_INGEST_URL` is
set):

- **`first-pass`** is the share of `(tool, sha)` pairs whose first `preview` or `ship` passed;
- **`rollback`** is the share of ships that rolled back;
- **`push-to-healthy`** is the median time from the first stage event to a passing prod verify;
- **`settle-retries`** is the mean of `attempts − 1` on api checks;
- **`cold-edit`** is the first-pass rate restricted to sessions whose agent had not touched the
  tool in the previous 30 days.

Metrics are grouped by `--by`, defaulting to the skill version. These numbers are the field
monitor (ADR-05). The evolution monitor workflow `evo-monitor.yml` uses them to raise a
`greenlight-evo-alarm` issue (06 §7). They never gate a change.

### 3.7 `wiki ingest` (P5)

```
greenlight wiki ingest [--sample 5:3] [--since <date>] [--tool <name>] [--incident <incident-id|EvidenceRef>]   # prepare
greenlight wiki ingest --apply <maintainer-output.json> [--dry-run]                                # apply
```

**Prepare mode** writes a bundle to `.greenlight/ingest/<id>/`:

- `wiki.tar` (the full current wiki);
- the sampled raw records: up to 5 failing and 3 passing by default, newest first, filtered by
  `--tool` and `--since`;
- for `--incident`, the incident page together with every issue or PR thread in its `evidence`
  (or the referenced thread, when a ref is given instead of a page id), fetched through `gh` with
  redaction applied;
- `prompt.md`, the maintainer prompt (06 §2.2) with the paths filled in.

It prints the bundle path. The maintainer agent, running the `greenlight-wiki` skill, reads the
bundle and writes `maintainer-output.json` (08 §9.1).

**Apply mode:**

1. It validates the output strictly. Every `update_pages` op is checked for exactly one occurrence
   of its target. Every created page must pass LR-01, LR-02, LR-19 and LR-20, and must have
   `status: hypothesis`, because a maintainer cannot create confirmed pages.
2. Status changes go in `update_pages` ops on the frontmatter. A move to `confirmed` must pass
   LR-05 against the evidence present.
3. It compares `update_index` with the generated index. A mismatch is a warning, and the generated
   index wins.
4. It applies every change atomically: all of them are staged in a temporary copy and moved into
   place only if all succeed. Then it appends the `append_log` entry with actor
   `maintainer:<GREENLIGHT_MODEL>`.
5. `--dry-run` prints the diff instead.

**Exit codes:** 0; 1 (validation failed, nothing written); 4 (an attempt to write `ledger.jsonl` or
`skill-impact.md`).

### 3.8 `wiki propose` and `wiki remediate` (P5 issue path, P6 skill path)

```
greenlight wiki propose [--skill <name>] [--pattern <id>]…                    # prepare proposer bundle
greenlight wiki propose --apply <proposer-output.json> [--draft]              # stage the proposal
greenlight wiki remediate --proposal <proposalId> --evidence <before-ref> <after-ref> --check <id>
greenlight wiki remediate --manual --pattern <id> --outlet mechanism|doctor|template|verify --ref <change-ref>
                          --evidence <before-ref> <after-ref> --check <id>
```

**`propose`**, in prepare mode, writes a bundle containing:

- `index.md`;
- `skill-impact.md`;
- an outcome summary (pass rates per skill version from the raw store);
- the target skill's `SKILL.md` and `PURPOSE.md`;
- a read-only manifest of the available trace paths, which the proposer reads on demand. This
  follows the paper: no pre-sampled traces;
- `prompt.md` (06 §3.2).

**`propose --apply`** validates the `ProposerOutput` (08 §9.2), then acts by action:

- **`create` or `patch`, outlet `skill`:** it applies the change on a new branch
  `wiki/prop-<id>` in a worktree. It bumps neither version, because that is the gate's job. It
  records the proposal in `.greenlight/proposals/<id>.json`, and the next step is `bench gate`.
- **`patch`, outlet `template`:** the same as `skill`, against `tools/_template-*` in the framework
  repo.
- **`issue`:** it opens a GitHub issue (on the framework repo for `mechanism`/`doctor`, on the
  wrapper for `verify`) whose body cites the patterns. It ends with the attribution footer
  required for GitHub posts. With `--draft`, it writes `wiki/proposals/<id>.md` instead. It writes
  a ledger row with `outcome: 'pending-human'` through the harness.
- **`no_action`:** it writes a ledger row with outcome `rejected` and the reason.

**`remediate --manual`** covers a remediation made outside the proposer, for example a human
fixing the framework directly as with the keepalive probe. It creates the proposal record on the
fly, then proceeds as below.

**`remediate`** records field evidence for the outlets that cannot be benched (`mechanism`,
`doctor` and `verify`). It requires a before ref that is a failing run of check `<id>` and an
after ref that is a passing run of the same check on a **deployed** artifact, both resolvable
through `gh` or Tracer. Given those, it writes a ledger row (`FieldEvidence`, `accepted`). It
also sets `remediation.verified: true` on the cited patterns through the same atomic write path
as ingest.

Ledger writes happen only inside these commands and `bench gate`. Those code paths are what
"harness" means in LR-14.

### 3.9 `wiki contribute` (P5)

```
greenlight wiki contribute <page-id> [--repo RTrentJones/greenlight]
```

This copies a project-wiki pattern or fact into a fork-and-PR against the framework wiki. Before
opening anything, it runs LR-19 (`check-seam`), LR-20 (secret detector) and LR-03 `--online`, and
any failure exits 1. It forces `status: hypothesis` on the copy (12 T-02). The PR body lists the
evidence refs, and the PR goes through normal human review. Nothing in this command merges.

### 3.10 `bench` (P6)

```
greenlight bench run [--split val] [--tasks <glob>] [--model <id>]… [--runs 3] [--skills-ref <git-ref>] [--json]
greenlight bench gate <proposalId> [--models <a>,<b>] [--runs 3] [--alpha 0.05]
greenlight bench check-graders [--tasks <glob>]          # alias: bench mutants
greenlight bench monitor [--since <date>]
greenlight bench report [--proposal <id>] [--json]
```

- **`run`** executes the selected tasks (08 §10). The run proceeds as follows:
  - Each task gets a throwaway sandbox: a copy of `fixture/` or an empty dir, the skills at
    `--skills-ref`, and **no** wiki (both wikis are absent and `--no-wiki` is set on verify).
  - Each task gets a fake-upstream proxy (11 §3.5).
  - The agent runs headless with the brief (`claude -p` driving the plugin). The agent command is
    configurable through `GREENLIGHT_BENCH_AGENT` for P7.
  - The hidden grader runs through `greenlight preview` in the sandbox.
  - Each rollout produces a `bench` raw record.
  - It prints pass rates per task and per split.
- **`gate`** implements 06 §5: the replay hard constraint, the capability strict improvement with a
  paired bootstrap, two models, and blast-radius strictness. It then writes exactly one ledger
  row. On acceptance, it bumps the target skill's `version` in both `SKILL.md` and `PURPOSE.md`,
  commits on the proposal branch, and opens a PR for human merge. The gate accepts into a release
  candidate, and a human releases.
  - **Exit codes:** 0 accepted; 1 rejected; 4 the proposal touches files outside its declared
    target.
- **`check-graders`** (alias `mutants`) runs every grader against every mutant and exits 1 if any
  grader passes a mutant (06 §4.3). CI runs it whenever `bench/` changes.
- **`monitor`** runs the scheduled test-split re-run against the models in `bench/models.json`. It
  compares the result with the last accepted baseline and opens or updates a `greenlight-evo-alarm`
  issue when any model regresses beyond the threshold in `bench/gate.json`. It refuses to start if
  the month's spend recorded against `bench/budget.json` would exceed the cap, and exits 4. It is
  invoked by `evo-monitor.yml`.
- **`report`** renders a proposal's gate evidence (replay table, capability deltas per model,
  p-values) as markdown for the PR body, or the latest `monitor` result. `evo.yml` uses it.

**Configuration files** (06 §5):

- `bench/models.json` lists the gate models: the frontier and the small model, with their agent
  commands;
- `bench/gate.json` holds `alpha`, `runs`, the blast-radius strictness table and the monitor
  regression threshold;
- `bench/budget.json` holds the monthly token or dollar cap and the per-proposal cap.

`bench run`, `gate` and `monitor` read these files and record their spend in
`.greenlight/bench-spend.jsonl`. The workflows are:

- `evo.yml`, dispatched with a proposal id, runs `bench gate` and posts `bench report`. It runs on
  issues labelled `greenlight-evo`;
- `evo-monitor.yml`, scheduled monthly, runs `bench monitor`.

## 4. Doctor rules

`doctor` prints each check prefixed with its id. **Severity** is what the rule emits today, or will
emit: **E** means fail, which always exits 1. **W** means warn, which exits 1 only under
`--strict`. **S** means skip, which is informational. **L** means the rule runs only under `--live`.

### 4.1 Existing checks, catalogued (`cli/src/commands/doctor.ts`)

| id | check name in output | condition | sev |
|---|---|---|---|
| DR-01 | `<tool>: directory` / `dir present` / `external (registry)` | the tool's dir exists (or the external tool is registered) | E |
| DR-02 | `<tool>: in the verify loop` | a verify spec exists at the matrix-aware location | W |
| DR-03 | `<tool>: local preview gate` | the tool can run `greenlight preview` (preview script or `preview` descriptor) | W |
| DR-04 | `<tool>: token scoping` | no generic same-provider secret name that would collide in the shared wrapper | W |
| DR-05 | `<tool>: pnpm workspace member` | local package tools are workspace members | W |
| DR-06 | `<tool>: vercel.json framework` | vercel tools declare their framework | W |
| DR-07 | `<tool>: migrations gate` / `migration approval` | a migrations dir has `migrations scan` wired, and approval when `requireMigrationApproval` | W |
| DR-08 | `keepalive coverage` | lists the tools needing keepalive (`data: supabase`, `target: oci\|docker`) | S/ok |
| DR-09 | version-ref drift | infra `?ref=` pins are uniform and equal to the installed CLI version | W |
| DR-10 | submodule drift | submodules match their recorded commit | W |
| DR-11 | preview receipt | `.greenlight/preview-<HEAD>` exists (skipped in CI) | W |
| DR-15 | `<name>: DNS` | prod host resolves | E, L |
| DR-16 | `<name>: live` | prod URL reachable (5xx → warn) | E/W, L |

DR-08 is superseded by DR-22 and DR-23 once `liveness` lands. It keeps printing for tools without
a `liveness` field. DR-15 and DR-16 skip tools without DNS when the manifest has no domain, and
they probe the workers.dev or vercel.app URL instead.

### 4.2 New rules

| id | title | condition (fails or warns when…) | sev | phase |
|---|---|---|---|---|
| DR-12 | framework wiki version | `.greenlight/wiki/framework/VERSION` ≠ installed CLI version, or the dir is missing | W | P0 |
| DR-13 | skill version vs CLI | an installed managed skill's `version` ≠ the version shipped in the installed package (stale `agent sync`) | W | P0 |
| DR-14 | skill copy sync | `.claude/skills/<s>` ≠ package copy; in P7 also ≠ `.agents/skills/<s>` | W (E in the framework repo, as `check-plugin-sync`) | P0/P7 |
| DR-20 | liveness declared | a tool has no `liveness` (E for tools added after P0; W for existing tools until migrated) | E/W | P1 |
| DR-21 | liveness consistent | `liveness.model` contradicts data/target (beyond what the schema can see: e.g. a Neon project wired directly in `infra/<tool>.tf` with `liveness: always-on`), or a `needs-silence` tool's keepalive probe or container healthcheck path reaches a route that queries the store (the probe path equals the tool's readiness route `ready` (C2), or the compose healthcheck targets `/health`) | E | P1 |
| DR-22 | needs-traffic keepalive | a `needs-traffic` tool has no keepalive target with `probeTable` (or an explicit store-reaching `probePath`) | E | P1 |
| DR-23 | needs-heal keepalive | a `needs-heal` tool has no keepalive target probing `liveness.probe`, or (oci) no `greenlight-remediate-<tool>.yml` | E | P1 |
| DR-24 | identity check | the tool's verify config has no check with id `identity` / no `requireIdentity: true` on the prod branch of the spec | W (E for tools added after P1) | P1 |
| DR-25 | freshness checks | an `agent`-lane tool, or a tool whose intent or liveness declares a producer, has no `maxAgeHours` assertion per producer (C4) | W | P1 |
| DR-26 | env-invariant marking | a function-shaped verify config does not export `invariant` ids (C7), so preview passes cannot be distinguished from prod guarantees | W | P1 |
| DR-27 | quota headroom | any quota consumed by the portfolio is ≥ 80% (warn) or ≥ 95% (fail) | W/E, L | P3 |
| DR-28 | wiki lint | runs `wiki lint` on the project wiki; any LR error → E, any LR warning → W (so LR-15 intent coverage, LR-16 liveness match and LR-21 missing tool pages surface here) | E/W | P0 |
| DR-30 | CI-only tokens | lists tokens without `inject` (OCI signing, docker SSH, dispatch token, …), always informational; fails if one is configured in the agent proxy | S / E | P4 |
| DR-31 | proxy environment | with `secrets.proxy` set: Node ≥ 24 without `NODE_USE_ENV_PROXY=1` in the agent-run env, or the proxy CA is not trusted (forward proxy) | W | P4 |
| DR-32 | promotion policy guard | `auto-on-green` on a tool the schema would reject (stale manifest), or `promote.yml` lacks the policy check step, or the proxy allow-list permits dispatching `promote.yml` without approval | E | P3/P4 |
| DR-33 | fixed upstream | an open pattern applies to the installed CLI and a newer published CLI fixes it (`remediation.ref` is `greenlight@X` with X > installed). Prints "pattern <id> is fixed in X; you run Y" | W | P0 |

IDs DR-17–DR-19 and DR-29 are reserved and unused. `--strict` in CI turns every W above into a failing
exit, which is the existing CI quality gate in the wrapper (`pnpm greenlight doctor --strict`).
