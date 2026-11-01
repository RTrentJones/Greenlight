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

Milestones are defined in 14. They are not versions: a command ships in whichever release
completes the milestone that needs it.

| command | status | milestone | serves |
|---|---|---|---|
| `verify` | changed (check ids, wiki links, `eval.check_id`) | M0 (ids), M3 (links) | FR-LOOP, FR-WIKI |
| `wiki lint / render` | new | M1 | FR-WIKI |
| `wiki read` | new | M1 | FR-WIKI |
| `wiki ingest` | new | M1 (manual bundles), M3 | FR-WIKI, FR-EVO |
| `wiki propose / remediate` (incl. `remediate --manual`) | new | M1–M2 | FR-EVO |
| `wiki traces` | new | M2 | FR-EVO |
| `bench run / gate / check-graders / report` (incl. `gate --recompute`) | new | M1–M2 | FR-EVO |
| `wiki context` (alias `wiki lookup --tool <t> --start`) | new | M3 | FR-WIKI, FR-SKILL |
| `wiki lookup` | new | M3 | FR-WIKI, FR-LOOP |
| `wiki capture` (incl. `--manual`, `--retain`, `--export`) | new | M1 (`--manual`), M3 | FR-WIKI |
| `wiki incident open` | new | M3 | FR-WIKI |
| `wiki stats` (alias `wiki metrics`) | new | M3 | FR-EVO, FR-SKILL |
| `preview` / `ship` | changed (raw capture, skills map) | M3 | FR-LOOP, FR-WIKI |
| `adopt` | changed (wiki pointer block, liveness prompt) | M3 | FR-WIKI |
| `agent sync` | changed (framework wiki, PURPOSE.md, pointer, `.agents`) | M3, M7 | FR-SKILL, FR-AGENT |
| `init` | changed (no-domain, beta account) | M4 | FR-KICK-04 |
| `add` | changed (liveness, intent stub, contract templates) | M4 (astro), M6 (other lanes) | FR-KICK, FR-BUILD, FR-WIKI |
| `accounts` | new | M4 (minimal), M6 | FR-KICK, FR-PORT |
| `approve` | new | M5 | FR-LOOP, FR-SEC |
| `promote` | changed (policy, approval verification, `promote` stage) | M5 | FR-LOOP, FR-SEC |
| `retire` | new (lifecycle) | M5 | FR-PORT |
| `secrets gather / check` | changed (`--sink`) | M5 | FR-SEC |
| `secrets proxy-config` | new | M5 | FR-SEC |
| `agent run` | new (`--isolated`, `--local`) | M5 | FR-SEC, FR-AGENT |
| `status` | changed (beta/prod sha and artifact pair) | M6 | FR-PORT |
| `portfolio` | new | M6 | FR-PORT |
| `advisories`, `doctor --advisories` | new | M6 | FR-WIKI |
| `bench monitor` | new | M6 | FR-EVO |
| `wiki contribute` | new | M6 | FR-WIKI |
| `doctor` | changed (rules DR-12…DR-36) | M0 onward, by rule | all |
| `lanes`, `config`, `deploy`, `migrations scan`, `bump` | unchanged | — | — |

## 2. Changed commands

### 2.1 `init`

```
greenlight init [--domain <domain> | --no-domain] [--cf-subdomain <sub>] [--cf-beta-subdomain <sub>] [--repo o/r]
                [--sink infisical|github] [--force] [--no-push] [--no-tokens] [--no-verify]
```

**Changes from the current command** (`cli/src/commands/init.ts`, which today requires
`--domain`, or a TTY prompt for it):

1. **No-domain mode** is selected by `--no-domain`, or by running `init` without `--domain` when
   there is no TTY to prompt, or when the operator answers the domain prompt with an empty line.
   The explicit flag exists so that scripts and skills can state intent. In this mode `init` writes
   a manifest without `domain` and with `cloudflare.prod.accountSubdomain: <sub>` and `cloudflare.beta.accountSubdomain`
   (08 §1.2). If `--cf-subdomain` is absent and a Cloudflare token is available, `init` reads the
   account's workers.dev subdomain from the Cloudflare API
   (`GET /accounts/{id}/workers/subdomain`). If neither is available, it exits 3 with the message
   `no-domain mode needs the account's workers.dev subdomain: pass --cf-subdomain or provide CLOUDFLARE_API_TOKEN`.
2. **Beta account.** Beta always runs in a separate free Cloudflare account (18 §4). That holds with
   or without a domain. `init` gathers the beta account's token as `CLOUDFLARE_API_TOKEN_BETA`,
   available to beta jobs and agent sessions, separately from the production token, which is
   stored for the `production` environment only. It writes
   `cloudflare.beta.accountSubdomain`, taken from `--cf-beta-subdomain` or from the beta account's
   `GET /accounts/{id}/workers/subdomain`. If neither is available it exits 3 and names the flag.
   With no domain, the base-token gathering skips the zone id. The emitted `infra.yml` omits DNS
   resources, because the workers.dev and vercel.app hosts need none.
3. `--sink` chooses where `secrets gather` writes (§2.10). The default is `github` until M5 ships,
   and `infisical` after that (ADR-06). The choice is recorded in `greenlight.config.ts` as a
   comment-free field `secrets: { sink }`, part of `SecretsSettings` (08 §13).
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
2. **Templates carry the contract (M4 for astro, M6 for other lanes).** The scaffold copies the lane template, which now
   implements C1, C2 and C7 for every lane (09 §3). The generated `verify.config.ts` already
   contains checks with ids `identity`, `live` and `ready` (09 §2).
3. **Project wiki stubs.** `add` writes `wiki/tools/<name>/intent.md` with an empty `criteria`
   list and a `TODO: confirm with the owner` line. It also writes `liveness.md`, filled from the
   flags, and `decisions.md`, with a dated entry recording the cell choice. It appends a `log.md`
   entry with actor `harness`.
4. **Headroom (M4 minimal, M6 full).** Before writing anything, `add` runs the projection in 10
   §3.3 for the quotas the new tool would draw on.
   - **Warning.** When any projection reaches 80%, `add` prints it with its basis, and it lists
     every `unknown` quota with the reason.
   - **Block.** When an *observed* projection reaches 100%, `add` exits 4 unless
     `--accept-headroom` is given.
   - **Unknown.** An unknown or estimate-only projection never blocks, and it never prints as
     "ok".
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
greenlight promote <name> [--commit <sha>] [--perform] [--push]
```

**Current behavior** (`packages/loop/src/promote.ts`) is kept: a gated `develop → main`
fast-forward, pinned with `--commit`, which refuses if develop has moved. Under 18, moving `main`
no longer deploys anything by itself, so the fast-forward is a bookkeeping step. Production changes
come only from the protected job. The additions:

1. **Policy.** The effective policy is the owner-approved one: `tool.promotion ?? config.promotion
   ?? 'human'`, **as of the commit of the last consumed approval** (18 §7). A policy edited since
   then is reported as `pending` (08 §11.3) and does not take effect until a release carrying
   `policyChange: true` is approved.
2. **`human`.** `--perform` runs only inside a protected production job whose verification step
   accepted an owner-signed approval for `(name, sha)` (18 §3.1), which it checks through
   `GREENLIGHT_RELEASE_AUTHORIZED` (18 §3.1a). Outside such a job it exits 4 with
   `promotion of <name> needs an owner-signed approval; run 'greenlight approve <name> --sha <sha>'
   and have the owner sign it`. The command never accepts a GitHub actor, a TTY, or a flag as
   evidence of approval.
3. **`auto-on-green`.** `--perform` is allowed in the protected job when the beta verify for
   `--commit` passed at that sha, and when the effective policy is `auto-on-green` and the release
   changes no authority-bearing field (18 §7).
4. **Stage event.** A `promote` stage event is emitted (08 §7) with `passed`, the promoted sha, the
   artifact id and the approval nonce.

**Exit codes:** 0; 1 (fast-forward refused, develop moved, or beta unverified); 4 (no valid
approval, or policy).

### 2.7a `approve` (new, M5)

```
greenlight approve <name> --sha <sha> [--artifact <id>] [--retire] [--policy-change] [--expires 24h] [--json]
```

This command **prepares** an approval. It never signs one, and it holds no key.

1. It resolves the tool and the commit, and checks that a passing beta verify exists at `sha`. For
   direct-to-prod tools (oci and docker) it checks for a passing local-gate receipt and the image
   digest pushed by the tool repo's CI, which becomes `artifact`.
2. It compares authority-bearing fields at `sha` with those at the last consumed approval (18 §7).
   If they differ and `--policy-change` was not given, it exits 4 and lists the changed fields.
3. With `--retire`, it adds the hash of the committed `retire/<name>.json` (10 §5.4).
4. It prints the `ReleaseApproval` payload (18 §3.1) and the exact command for the **owner** to
   run on a machine holding the signing key:
   `git tag -s release/<name>/<sha12>-<nonce> <sha> -F <payload file> && git push origin
   release/<name>/<sha12>-<nonce>`.
5. Where the plan supports environment reviewers (18 §3.2), it also prints the link to the pending
   deployment review.

Running `approve` from an agent session is allowed and useful. The agent prepares the request, and
only the owner can complete it.

**Exit codes:** 0; 1 (beta or local gate not passed at `sha`); 4 (policy change not declared).

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
5. **`--codex` (M7)** also writes `.agents/skills/<skill>/` (byte-identical to `.claude/skills/`)
   and an `AGENTS.md` block with the same content as the `CLAUDE.md` block. Before M7 the flag
   exits 2 with `codex parity is an M7 stretch item`.

### 2.12 `agent run` (new, M5)

```
greenlight agent run [--isolated | --local] [--proxy infisical|worker] [--ttl 8h] -- <agent command…>
```

This command launches an agent CLI (for example `claude`) behind the credential proxy (11 §3), in
one of the two trust models of 11 §1.1.

- **`--isolated` (model A, default where available).** The agent runs in a container, or as a
  separate OS user, created for the session.
  - **Mounted:** the workspace only. The home directory, `~/.ssh`, `~/.config/gh`, git credential
    helpers, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, the Docker socket and the parent environment are
    not mounted or inherited.
  - **Network:** egress is allowed only to the proxy and the package registries. The rule is
    enforced with the container's network policy or an nftables rule for the session user.
  - **Missing runtime:** if no container runtime and no separate user is available, the command
    exits 3. It never falls back to `--local` silently.
- **`--local` (model B).** The agent runs as a child process of the operator's shell, with its
  environment replaced. The command prints, every time:
  `local mode: environment values are replaced, but the agent can still reach your credentials,
  credential helpers and network. This prevents accidental leakage only.` The session records
  `trustModel: B`.

In both modes:

1. The command resolves the proxy from `secrets.proxy`, or from `--proxy`.
2. It creates a proxy session (11 §3.3) for the **agent identity** (18 §2). It refuses with exit 4
   if the configured GitHub credential belongs to the owner's account.
3. It builds the child environment:
   - each agent-eligible credential's `envVar` holds a placeholder, `gl-placeholder-<ENV_VAR>`;
   - `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY` are set for split routing with the forward proxy,
     or `baseUrlEnv` overrides for the Worker proxy;
   - `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS` are set for the forward proxy;
   - `GREENLIGHT_AGENT`, `GREENLIGHT_SESSION` and `GREENLIGHT_TRUST_MODEL` are set.
4. It starts the child, forwards signals, and revokes the session on exit. In `--isolated` mode it
   also kills the session's process tree.
5. CI-only tokens (DR-30), and every production credential, are never placed in the child's
   environment or in the proxy session.

There is no `--allow-promote` flag. Release does not go through the agent session (18).

**Exit code:** the child's exit code. It exits 3 when proxy or isolation prerequisites are
missing.

### 2.13 `secrets proxy-config` (new, M5)

```
greenlight secrets proxy-config [--format infisical|worker] [--out <dir>] [--check]
```

This renders the typed policy (11 §4.2, 08 §12) for every agent-eligible credential into the
selected proxy's format. `--format` defaults to `secrets.proxy`, and `--proxy` is accepted as an
alias.

`--check` exits 1 when any of these holds:
- the rendered policy differs from the deployed one;
- two credentials could match one request;
- a production credential would render;
- any request in the mutation set (11 §4.2) would be forwarded;
- a client in the support matrix (11 §4.6) lacks a passing test for the chosen format. That client
  is then reported as CI-only.

Output files contain rules only, never values.

## 3. New commands

### 3.1 `accounts` (M4 minimal, M6 full)

```
greenlight accounts [--json] [--offline] [--cell <lane/target/data>]
```

**Behavior:**

1. It loads the provider packs (`cli/src/providers.ts`) and the secret source (`secrets.sink`).
2. For each pack, `configured` means every non-optional token name exists in the source. The check
   is done by name only, and the GitHub sink uses `gh secret list`.
3. Unless `--offline` is given, it runs each pack's `verify()` in turn. This needs the value, so
   it runs only where the token is held: in an operator shell or in CI. Agent sessions hold no
   production credentials (18 §2), so in an agent session `verified` is `null`, and the command
   reads the last report written by `doctor --live` in CI (artifact `greenlight-accounts.json`)
   instead.
4. **Observations (10 §3.2).** It gathers `QuotaObservation`s (08 §11.1):
   - **observed**, from each pack's `usage()` per concrete account and resource, with history
     where the provider exposes it;
   - **declared**, from the manifest.

   It deduplicates by resource, so two tools sharing one store count once. It includes resources
   that exist in the account but no manifest maps (`outsideGreenlight`). It computes headroom
   only from observations whose unit matches the fact page. Everything else is `unknown`, with a
   reason, and an unknown is never shown as safe.
5. It computes cell availability. A cell is available when every pack that the cell needs is
   configured. The packs a cell needs come from `mcpForTool`-style resolution: Cloudflare always,
   plus the target's pack, the data pack and HCP.
6. It prints a table to stderr, or the `AccountsReport` (08 §11.2) to stdout with `--json`.
   Per-project quotas are listed per project, naming the project and its tools.
   `--cell` narrows the report and exits 1 if that cell is unavailable. Kickoff uses this.

**Writes:** nothing. **Exit codes:** 0; 1 (with `--cell`, cell unavailable); 3 (no manifest).

### 3.2 `portfolio` (M6)

```
greenlight portfolio [--json] [--offline] [--write]
```

**Behavior.** For each tool in the manifest, plus the blog:

1. **`prod` and `beta` sha and artifact.** It GETs the resolved URL plus `/__version` (C1), with a
   5s timeout, and reads `sha` and, where served, the artifact id.
   - **`verified`** is true when the latest `ship` raw record or CI run for that environment, at
     that sha **and** artifact, passed. The CI run is found through `gh run list` on the deploy
     workflow, filtered by `headSha`.
   - **`approvedBy`** comes from the consumed approval's deployment record (18 §3.1 step 5).
   - **Unknown evidence.** If the evidence cannot be fetched, `verified` is `null`, never `true`.
2. **`waiting`.** `git rev-list --count origin/main..origin/develop`, after
   `git fetch origin main develop`. For a cross-repo tool, the command runs in the submodule. For a
   tool without beta (OCI, direct to prod), `waiting` is `null` and the cell reads `n/a (direct)`.
3. **`lastShip`.** The newest `ship` raw record, or the newest deploy-workflow run.
4. **`keepalive`.** The last sweep result from the keepalive Worker's status endpoint
   (`infra/modules/keepalive`), when one is exposed. Otherwise it is read from the keepalive's last
   alert-issue state.
5. **`alerts`.** Open issues carrying the alert sink's label, matched by tool name in the title.
6. **`headroom`.** As in `accounts`.
7. **`lifecycle`** (`active`, `retiring` or `retired`, 10 §5.1) and **`promotion`** (`effective`
   and `pending`, §2.7).

It prints one table, and `--json` emits `PortfolioReport` (08 §11.3). `--write` regenerates
`wiki/portfolio.md` from the report: one line per tool, carrying the cell, the liveness model, the
first criterion of `intent.md`, and the prod sha. `--offline` skips steps 1, 4 and 5.

**Exit code:** 0, even when some tools are unhealthy, because the command reports rather than
gates. It exits 3 when there is no manifest.

### 3.3 `retire` (M5)

```
greenlight retire <name> --start   [--abort]
greenlight retire <name> --plan    [--dry-run]
greenlight retire <name> --confirm [--json]
```

This command implements the retirement lifecycle in 10 §5. Each step is separate, and none of them
applies infrastructure.

1. **`--start`** moves the tool to `retiring`. It writes `lifecycle: 'retiring'` to the manifest
   entry and stops the tool's deploys and keepalive target. It builds the inventory (10 §5.2):
   Terraform-owned, Wrangler-managed, adopted and shared resources, plus secrets. It writes the
   inventory to `wiki/tools/<name>/retirement.md` and asks for a data disposition for each store
   (10 §5.3).
   - Without a TTY, every disposition must be given as `--data <address>=export|keep|delete`.
   - It refuses to retire a store owner while any `dataShareWith` sharer remains, and exits 4.
   - `--abort` returns the tool to `active`, which is possible only before an authorized apply.
2. **`--plan`** removes the tool's Terraform declarations on a branch, pushes it, and waits for
   CI's read-only `terraform plan`. CI writes `retire/<name>.json` (`RetireAuthorization`, 10 §5.4)
   with the plan hash and the exact destroy set. The command checks that the destroy set holds no
   address outside the inventory and no shared store. A mismatch exits 1, with the unexpected
   addresses listed. It then prints the next step: `greenlight approve <name> --sha <sha>
   --retire`, signed by the owner. `--dry-run` prints the inventory and the expected destroy set
   without pushing.
3. **The authorized apply** runs in the protected job (18 §5 row 10). It is not part of this
   command.
4. **`--confirm`** checks every inventory item against state and the provider APIs (10 §5.5) and
   records outcomes. When every item has an outcome, it removes the manifest entry, moves
   `wiki/tools/<name>/` to `wiki/archive/tools/<name>/`, keeps `retirement.md` as the record, and
   lists the secrets that are safe to delete. Items it cannot check are reported as `unverified`,
   and the tool stays `retiring`.

**Exit codes:** 0; 1 (unexpected destroy set, or unverified items on `--confirm`); 2; 3 (no such
tool); 4 (shared store, or missing disposition).

### 3.4 `wiki lint` and `wiki render` (M1)

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

### 3.5 `wiki capture` (M1 `--manual`, M3)

```
greenlight wiki capture --kind <kind> --tool <name> --env <env> --passed <bool>
                        [--sha <sha>] [--ref <EvidenceRef>]… [--excerpt-file <path>] [--verify-json <path>]
greenlight wiki capture --from-issue <issue:o/r#n> [--tool <name>]
greenlight wiki capture --from-run <run:o/r/id> [--tool <name>]
greenlight wiki capture --manual --tool <name> --env <env> --passed <bool> --note <text> [--ref <EvidenceRef>]…
greenlight wiki capture --retain <rawId>
greenlight wiki capture --export <dir>
```

- **`--manual`** (M1) records evidence a human gathered by hand, such as a drill run before
  automatic capture exists. The record's `kind` is `session` and `excerpt` is the redacted note,
  and its identity fields (08 §5) are filled from the working tree. This is what milestone drills
  use until automatic capture lands in M3.
- **`--retain <rawId>`** copies a raw record to `wiki/evidence/<rawId>.json`, which is committed
  and immutable. Ledger events and confirmed pages must cite retained evidence or resolvable refs
  (08 §5.3).
- **`--export <dir>`** writes all retained evidence plus the ledger as a tarball, with a manifest of
  hashes (08 §5.3).

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

### 3.6 `wiki lookup` (M3)

```
greenlight wiki lookup [--check <id|name>]… [--class <class>] [--cell <lane/target/data>] [--tool <name>]
                       [--start] [--role maintainer|proposer] [--include-hypothesis] [--json]
```

**Selection:**

1. Candidates are the pages in both wikis with `type: pattern` and `status: confirmed` (plus
   `hypothesis` only if `--include-hypothesis` is given, which is never done in skills). Pages are
   filtered by `relevance` and `affects` (04 §6):
   - a `framework-version` lesson is dropped when the installed CLI is outside `affects`;
   - an `app-code` or `both` lesson is kept regardless of version, because the fault can recur in
     code the owner writes.
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

### 3.6a `wiki context` (M3) — the on-start hook

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

### 3.6b `wiki read` (M1)

```
greenlight wiki read <page-id> [--json]
```

This prints one page from the project wiki, or from the materialized framework wiki when the id
is not found locally. A `superseded` id is followed to its replacement, with a notice. A
`hypothesis` page is printed with a banner reading `HYPOTHESIS — not guidance`. Incident ids are
refused (exit 4) unless `--role maintainer` is also given.

### 3.6c `wiki incident open` (M3) — the on-incident hook

```
greenlight wiki incident open --tool <name> --ref <EvidenceRef> [--title <t>]
greenlight wiki incident close <incident-id> --ref <EvidenceRef>
```

`open` creates `wiki/tools/<name>/incidents/<yyyy-mm>-<slug>.md` with `status: hypothesis` and the
first timeline entry. It also captures the ref as a raw record (`wiki capture --from-issue` or
`--from-run`) and appends a log entry. `close` sets `closed`. It does not mark anything
`confirmed`, because confirmation is a maintainer step that needs red-to-green evidence (04 §4).

### 3.6d `wiki traces` (M2)

```
greenlight wiki traces [--failing|--passing] [--tool <name>] [--skill <name>@<version>] [--limit 20]
greenlight wiki traces show <rawId>
```

This is the proposer's read-only trace access. It follows the paper: no pre-sampled traces; the
proposer reads them on demand (06 §3). The list form prints `rawId`, tool, kind, passed, skills and
age. `show` prints one redacted raw record. Neither form writes anything.

### 3.6e `wiki stats` (alias `wiki metrics`) (M3)

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

### 3.7 `wiki ingest` (M1 manual bundles, M3)

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

### 3.8 `wiki propose` and `wiki remediate` (M1–M2)

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

**`remediate`** records evidence for the outlets that are not gated by rollouts (`mechanism`,
`doctor` and `verify`). It writes one ledger **event** per stage (06 §6.1), never a single
"accepted" row:

- **`candidate-accepted`.** The outlet's rule passed (06 §5.6): a reproduction that fails on the
  base commit and passes on the candidate, or an assertion shown failing on the faulty artifact
  and passing on the fixed one.
- **`merged`** and **`released`**, recorded from the PR merge and the release workflow.
- **`verified-in-production`.** This stage needs a before ref that is a failing run of check
  `<id>`, and an after ref that is a passing run of the same check on a **deployed** artifact.
  Both must resolve through `gh` or Tracer (08 §5.3). An unreachable ref yields `unknown`, never
  verified.

Only the `verified-in-production` stage sets `remediation.verified: true` on the cited patterns,
through the same atomic write path as ingest.

Ledger writes happen only inside these commands and `bench gate`. Those code paths are what
"harness" means in LR-14.

### 3.9 `wiki contribute` (M6)

```
greenlight wiki contribute <page-id> [--repo RTrentJones/greenlight]
```

This copies a project-wiki pattern or fact into a fork-and-PR against the framework wiki. Before
opening anything, it runs LR-19 (`check-seam`), LR-20 (secret detector) and LR-03 `--online`, and
any failure exits 1. It forces `status: hypothesis` on the copy (12 T-02). The PR body lists the
evidence refs, and the PR goes through normal human review. Nothing in this command merges.

### 3.10 `bench` (M1–M2; `monitor` M6)

```
greenlight bench run [--split train|val|test] [--tasks <glob>] [--model <id>]… [--runs 3] [--mode isolation|production|both] [--skills-ref <git-ref>] [--json]
greenlight bench gate <proposalId> [--models <a>,<b>] [--runs 3] [--alpha 0.05]
greenlight bench gate --recompute <evaluationRecordHash>
greenlight bench check-graders [--tasks <glob>]          # alias: bench mutants
greenlight bench monitor [--since <date>]
greenlight bench report [--proposal <id>] [--json]
```

- **`run`** executes the selected tasks (08 §10). The run proceeds as follows:
  - Each task gets a throwaway sandbox: a copy of `fixture/` or an empty dir, the skills at
    `--skills-ref`. In isolation mode no wiki is present and `GREENLIGHT_WIKI=off` is set. In
    production mode the hooks run against a pinned wiki snapshot (06 §4.7). The rollout runs under
    trust model A with the trajectory shims of 06 §4.6, and grading runs in a separate container
    after the rollout's process tree is killed (06 §4.2).
  - Each task gets a fake-upstream proxy (11 §3.5).
  - The agent runs headless with the brief (`claude -p` driving the plugin). The agent command is
    configurable through `GREENLIGHT_BENCH_AGENT` for M7.
  - The task's graders (06 §4.6) run from `bench/graders/<taskId>/` in the grading container,
    over a read-only copy of the final tree and the trajectory. An `app` grader runs `greenlight
    preview --config <grader>`.
  - `--mode isolation|production|both` selects the evaluation mode; the default is `isolation`.
  - Each rollout produces a `bench` raw record carrying its task, split, model, mode, skill-set
    hash and run id (08 §5).
  - It prints pass rates per task and per split.
- **`gate`** implements 06 §5: the single policy table (06 §5.4), the two models, and both
  evaluation modes. It writes a content-addressed `EvaluationRecord` (06 §5.8), and one
  `candidate-accepted` or `candidate-rejected` ledger event that references it. `--recompute
  <hash>` re-derives the decision from a stored record without new rollouts, and exits 1 if the
  recomputed decision differs from the recorded one. On acceptance, it bumps the target skill's `version` in both `SKILL.md` and `PURPOSE.md`,
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
- `bench/budget.json` is `{ "monthlyUsd": <n>, "perGateMaxUsd": <n>, "perGateMaxRollouts": <n> }`
  (08 §10.5). This is the only budget schema in the pack.

`bench run`, `gate` and `monitor` read these files. They record spend as harness-written `spend`
events in the ledger, never in a local file, so spend survives ephemeral CI runners. All three run
in the concurrency group `greenlight-evo`, so two gates cannot read the same remaining budget. The
workflows are:

- `evo.yml`, dispatched with a proposal id, runs `bench gate` and posts `bench report`. It runs on
  issues labelled `greenlight-evo`;
- `evo-monitor.yml`, scheduled monthly, runs `bench monitor`.

### 3.11 `advisories` (M6)

```
greenlight advisories [--json] [--offline]
greenlight doctor --advisories
```

This command is opt-in, because it reaches the network. It fetches the newest published
`@rtrentjones/greenlight` package's tarball from the npm registry without installing it, and reads
its `wiki/index.md` and pattern frontmatter (04 §6). It then reports every pattern whose `affects`
covers the installed version and whose remediation is released in a newer version. The result is
cached for 24 hours in `.greenlight/advisories.json`. With `--offline`, or when the registry cannot
be reached, it prints `advisories: not checked` and exits 0. It never prints "none" in that case.
`doctor --advisories` runs it and lists the results as DR-33 findings with the source `advisory`.

**Exit codes:** 0, including when advisories exist, because the command reports rather than gates;
3 when there is no manifest.

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
| DR-15 | `<name>: DNS` | prod host resolves; in no-domain mode, a `private` tool's beta `workers.dev` host is behind Cloudflare Access and `preview_urls` is disabled (10 §6) | E, L |
| DR-16 | `<name>: live` | prod URL reachable (5xx → warn) | E/W, L |

DR-08 is superseded by DR-22 and DR-23 once `liveness` lands. It keeps printing for tools without
a `liveness` field. DR-15 and DR-16 skip tools without DNS when the manifest has no domain, and
they probe the workers.dev or vercel.app URL instead.

### 4.2 New rules

| id | title | condition (fails or warns when…) | sev | milestone |
|---|---|---|---|---|
| DR-12 | framework wiki version | `.greenlight/wiki/framework/VERSION` ≠ installed CLI version, or the dir is missing | W | M1 |
| DR-13 | skill version vs CLI | an installed managed skill's `version` ≠ the version shipped in the installed package (stale `agent sync`) | W | M1 |
| DR-14 | skill copy sync | `.claude/skills/<s>` ≠ package copy; in M7 also ≠ `.agents/skills/<s>` | W (E in the framework repo, as `check-plugin-sync`) | M1/M7 |
| DR-20 | liveness declared | a tool has no `liveness` (E for tools added after M4; W for existing tools until migrated) | E/W | M4 |
| DR-21 | liveness consistent | `liveness.model` contradicts data/target (beyond what the schema can see: e.g. a Neon project wired directly in `infra/<tool>.tf` with `liveness: always-on`), or a `needs-silence` tool's keepalive probe or container healthcheck path reaches a route that queries the store (the probe path equals the tool's readiness route `ready` (C2), or the compose healthcheck targets `/health`) | E | M4 |
| DR-22 | needs-traffic keepalive | a `needs-traffic` tool has no keepalive target with `probeTable` (or an explicit store-reaching `probePath`) | E | M4 |
| DR-23 | needs-heal keepalive | a `needs-heal` tool has no keepalive target probing `liveness.probe`, or (oci) no `greenlight-remediate-<tool>.yml` | E | M4 |
| DR-24 | identity check | the tool's verify config has no check with id `identity` / no `requireIdentity: true` on the prod branch of the spec | W (E for tools added after M4) | M4 |
| DR-25 | freshness checks | an `agent`-lane tool, or a tool whose intent or liveness declares a producer, has no `maxAgeHours` assertion per producer (C4) | W | M4 |
| DR-26 | env-invariant marking | a function-shaped verify config does not export `invariant` ids (C7), so preview passes cannot be distinguished from prod guarantees | W | M4 |
| DR-27 | quota headroom | any quota consumed by the portfolio is ≥ 80% (warn) or ≥ 95% (fail) | W/E, L | M6 |
| DR-28 | wiki lint | runs `wiki lint` on the project wiki; any LR error → E, any LR warning → W (so LR-15 intent coverage, LR-16 liveness match and LR-21 missing tool pages surface here) | E/W | M1 |
| DR-30 | CI-only tokens | lists tokens without `inject` (OCI signing, docker SSH, dispatch token, …), always informational; fails if one is configured in the agent proxy | S / E | M5 |
| DR-31 | proxy environment | with `secrets.proxy` set: Node ≥ 24 without `NODE_USE_ENV_PROXY=1` in the agent-run env, or the proxy CA is not trusted (forward proxy) | W | M5 |
| DR-32 | promotion policy guard | `auto-on-green` on a tool the schema would reject; an effective policy that differs from the policy at the last consumed approval without a `policyChange` approval (18 §7); a production job that does not bind `GREENLIGHT_RELEASE_AUTHORIZED` to the tool and sha it deploys (18 §3.1a); or a proxy policy that would forward any workflow dispatch or `release/*` ref write | E | M5 |
| DR-33 | fixed in a newer version (local knowledge) | the **installed** wiki marks an open pattern as fixed in a CLI version newer than the installed one, which happens only when the synced wiki is newer than the CLI. With `--advisories`, it also lists the results of `greenlight advisories` (§3.11). Prints "pattern <id> is fixed in X; you run Y" | W | M3 / M6 |
| DR-34 | protected production jobs | a workflow that references a production credential, or that deploys, migrates, applies or restarts production, does not begin with the approval verification step that sets `GREENLIGHT_RELEASE_AUTHORIZED` (18 §3.1, §3.1a), or is triggered by `push` alone. Under `--live`, it also checks through the API that the `production` environment exists with required reviewers where the plan supports them (18 §3.2, §10) | E (L for the remote check) | M5 |
| DR-35 | agent identity | the GitHub credential configured for agent sessions belongs to the owner's account, or holds any of `workflows`, `secrets`, `administration`, `environments`, `actions: write` or `deployments: write` (18 §2). Checked with `gh api` on the token's own identity and permissions | E, L | M5 |
| DR-36 | recovery uses approved artifacts | a remediation, self-heal or rollback workflow restarts or deploys without first resolving the last approved immutable artifact (image digest or Worker version) from the consumed approval's deployment record (18 §6) | E | M5 |

IDs DR-17–DR-19 and DR-29 are reserved and unused. `--strict` in CI turns every W above into a failing
exit, which is the existing CI quality gate in the wrapper (`pnpm greenlight doctor --strict`).
