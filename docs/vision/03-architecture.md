# 03 — Architecture

This document describes the components of the system, where each one lives, and how data moves
between them. Schemas are in [08](08-data-contracts.md). Commands are in [07](07-cli-spec.md).

## 1. Three planes over one spine

Greenlight today has two planes (`greenlight-v2.md` §3). This stage adds a third.

| plane | job | as built | added by this pack |
|---|---|---|---|
| **1. Infra editor** | turn manifest entries into Terraform, workflows and wired kits | `cli/src/commands/{init,add,adopt,bump}.ts`, `cli/src/providers.ts`, `cli/src/tf-emit.ts`, `infra/modules/*` | `liveness` and `promotion` fields, no-domain mode, `retire`, `inject` on tokens |
| **2. Validation gate** | prove a deployed artifact does what it should | `packages/verify`, `packages/loop` (`ship.ts`, `promote.ts`), `cli/src/commands/{preview,verify,ship,promote,doctor}.ts` | check ids, wiki links in failure reports, `promote` stage events, the bench gate |
| **3. Knowledge** (new) | remember what each project is for, what has gone wrong and why, and improve skills on evidence | — | `packages/wiki`, the framework and project wikis, raw capture, the managed-skill model, the evolution loop |

The spine all three share is unchanged: the manifest (`greenlight.config.ts`) is the single source
of truth, GitHub Actions is the only CI, and the CLI edits files while CI applies them. Plane 3
follows the same stance. The CLI validates and writes wiki and skill files, agents propose content,
and nothing in the knowledge plane can deploy, promote or apply infrastructure.

## 2. Component diagram

```
                         ┌──────────────────────── owner ────────────────────────┐
                         │  describes apps, tries beta, approves release          │
                         └───────────────▲───────────────────────┬────────────────┘
                                         │ beta URL, portfolio   │ "ship it"
┌────────────────────────────────────────┴───────────────────────▼──────────────────────────┐
│ coding agent (Claude Code; Codex in P7)                                                   │
│   loads managed skills: deploy-verify-promote · kickoff · build · portfolio · wiki ·      │
│   provider-*  ── each runs hooks (05 §3) ──▶ greenlight CLI                               │
└───────┬───────────────────────────────┬─────────────────────────────────┬────────────────┘
        │ HTTPS via credential proxy     │ CLI calls                       │ git push
        ▼ (P4, 11)                       ▼                                 ▼
┌───────────────┐   ┌──────────────────────────────────────────┐   ┌─────────────────────────┐
│ provider APIs │   │ greenlight CLI (@rtrentjones/greenlight)  │   │ GitHub (wrapper + tool  │
│ Cloudflare,   │◀──│  plane 1: init add adopt retire bump      │   │ repos)                  │
│ Vercel, Neon, │   │  plane 2: preview verify ship promote     │   │  Actions = only CI      │
│ Supabase, OCI,│   │           doctor status portfolio accounts│   │  secrets (synced from   │
│ Gemini, HCP   │   │  plane 3: wiki {capture ingest propose    │   │   Infisical in P4)      │
└───────▲───────┘   │           lint lookup contribute remediate│   │  infra.yml deploy.yml   │
        │           │           } bench {run gate}              │   │  promote.yml (human)    │
        │           └──────┬──────────────┬──────────────┬──────┘   └───────────┬─────────────┘
        │                  │              │              │                      │ ship / apply
        │        ┌─────────▼───┐  ┌───────▼──────┐ ┌─────▼──────────────┐       │
        │        │packages/    │  │packages/     │ │packages/wiki (new) │       │
        │        │verify, loop │  │adapters,     │ │schemas lint patch  │       │
        │        │             │  │keepalive     │ │lookup ledger raw   │       │
        │        └─────────────┘  └──────────────┘ └─────┬──────────────┘       │
        │                                                │ reads/writes          │
        │        ┌───────────────────────────────────────▼────────────────────┐ │
        │        │ files in git: framework wiki (npm asset, read-only copy)    │ │
        │        │ project wiki (wrapper wiki/), skills (.claude/skills),      │ │
        │        │ ledger.jsonl, bench/ (framework repo)                       │ │
        │        └─────────────────────────────────────────────────────────────┘ │
        │        ┌─────────────────────────────┐   ┌─────────────────────────────▼┐
        └────────│ keepalive Worker (cron)     │   │ Tracer (optional run store)  │
                 │ probes per liveness model,  │──▶│ ingest: verify --json, stage │
                 │ opens alert issues          │   │ events, bench runs           │
                 └─────────────────────────────┘   └──────────────────────────────┘
```

## 3. `packages/wiki` (new)

`packages/wiki` is a private workspace package. Like `shared`, `verify`, `adapters` and `loop`, it
is bundled into the CLI by tsup `noExternal`. It has no network code except in `lookup.ts`, which
calls nothing remote, and `raw.ts`, which may POST to Tracer. Its modules:

| module | exports | notes |
|---|---|---|
| `schema.ts` | zod schemas for every page type, `LedgerRow`, `RawRecord`, `MaintainerOutput`, `ProposerOutput`, `TaskSpec` (08 §3–§10) | strict: unknown keys are errors |
| `parse.ts` | `parsePage(path, text) → Page`, `serializePage(page) → string` | YAML frontmatter via `yaml`; preserves body bytes exactly so patches stay stable |
| `load.ts` | `loadWiki(root) → Wiki` (pages by id, index, log, ledger), `resolveId` | normalizes `pattern/x` ↔ `patterns/x` (04 §2.1) |
| `patch.ts` | `applyOps(text, ops) → text`, `applyMaintainerOutput(wiki, out) → Changeset` | exact-substring, exactly-once targets; whole output atomic (08 §9.1) |
| `index-gen.ts` | `generateIndex(wiki) → string`, `diffIndex(submitted, generated)` | sharding by cell past 60 lines (LR-09) |
| `lint.ts` | `lint(wiki, ctx) → LintResult[]`, `fix(wiki) → Changeset` | rules LR-01…LR-21 (04 §5); `ctx` carries manifest, installed version, verify check ids, skills |
| `lookup.ts` | `lookup(wiki, query) → PatternHit[]` | query by check id/name, class, cell; filters `confirmed` + `applies` (05 §3) |
| `ledger.ts` | `appendLedger(root, row)` (harness only), `renderSkillImpact(rows) → string` | refuses rows without `writer: 'harness'` |
| `raw.ts` | `writeRaw(root, rec)`, `redact(text, secretNames) → text`, `truncate(text, 15000)`, `postTracer(rec)` | redaction rules in 11 §6 |
| `skills.ts` | `loadSkills(dir) → ManagedSkill[]`, `skillVersions(cwd)`, `checkPurpose(skill, wiki)` | replaces `skillVersion()` in `cli/src/commands/ship.ts` (08 §7) |
| `sample.ts` | `sampleRaw(records, {fail:5, pass:3}) → RawRecord[]` | deterministic with `--seed` (06 §3.2) |

**Boundaries.** `pnpm check-boundaries` (dependency-cruiser) gains these rules:

- `packages/wiki` MAY import `packages/shared` and MUST NOT import `packages/verify`,
  `packages/loop`, `packages/adapters` or `cli`. It consumes verify output as data, not as code.
- `packages/loop` and `packages/verify` MUST NOT import `packages/wiki`. The gate never depends on
  the knowledge plane, so a broken wiki cannot break a deploy.
- `cli` is the only package that wires `wiki` to `verify`/`loop`: lookup links in failure reports,
  and capture after a ship.
- `pnpm check-seam` runs over `wiki/` in the framework repo (LR-19).

## 4. Repo topology: where every artifact lives

| artifact | framework repo | wrapper | tool repo |
|---|---|---|---|
| framework wiki (source) | `wiki/` | — | — |
| framework wiki (copy) | `cli/assets/wiki/` (built), `plugin/wiki/` (mirror) | `.greenlight/wiki/framework/` (gitignored, `agent sync`) | — |
| project wiki | — | `wiki/` (committed) | pointer block in `CLAUDE.md` (04 §2.2) |
| managed skills (source) | `.claude/skills/<name>/{SKILL.md,PURPOSE.md}` | — | — |
| managed skills (copy) | `plugin/skills/`, `cli/assets/skills/` | `.claude/skills/` via `agent sync`; `.agents/skills/` in P7 | `.claude/skills/` via `agent sync <name>` |
| project skills (optional) | — | `.claude/skills/<name>/` with `owner: project` | — |
| ledger | `wiki/ledger.jsonl` (framework skills) | `wiki/ledger.jsonl` (project skills, project patterns' field remediations) | — |
| bench | `bench/tasks/`, `bench/splits.json` | — | — |
| raw store | CI artifacts for bench runs | `.greenlight/raw/` (gitignored) + Tracer | — |
| verify configs | `tools/_template-*/verify.config.ts` | `apps/blog/verify.config.ts`, `verify/<tool>.config.ts`, local tools' own | adopted tools' deep suites |
| secrets | — | Infisical project (P4) → synced Actions secrets | `GREENLIGHT_DISPATCH_TOKEN` only |

The rule behind the layout is that the framework repo holds what is true for every user, the
wrapper holds what is true for this owner's portfolio, and a tool repo holds only its code plus
pointers. This is the same split the current code already follows for verify configs and infra
(`docs/architecture.md`).

## 5. The join key and data flows

Every piece of evidence is joined on **`(tool, gitSha)`**. The name is a manifest tool name or
`blog`. The sha is the commit that was built, deployed, verified or probed. `StageEvent.gitSha`
already carries it (`packages/loop/src/ship.ts`), `/__version` exposes it at runtime (C1), and
`verify --expect-sha` asserts it. Incident pages, portfolio rows and ledger field evidence are all
views over this key.

Evidence arrives at three time scales. Each has a producer, a record kind (08 §5) and a consumer.

| time scale | producers | raw `kind` | durable refs | consumers |
|---|---|---|---|---|
| **build time**: minutes, inside an agent session | `greenlight preview`, `verify --url`, bench rollouts, agent session | `preview`, `verify`, `bench`, `session` | preview receipt `.greenlight/preview-<sha>`, bench CI artifact | on-failure hook, maintainer, bench gate |
| **deploy time**: minutes, in CI | `greenlight ship` (build → deploy → verify → rollback), `promote` | `ship` | Actions run id, Tracer run id | portfolio, field monitor, maintainer |
| **run time**: days to weeks, unattended | keepalive Worker sweeps, cron freshness checks, alert issues | `keepalive`, `alert` | issue number, Tracer run id | portfolio, on-incident hook, maintainer |

**Flow rules:**

1. **Raw records are written by the CLI, never by agents.** `preview`, `verify`, `ship`, `promote`
   and `bench run` call `writeRaw` at the end of each run. Keepalive and alert evidence enters
   through `greenlight wiki capture --from-issue <n>` and `--from-tracer <id>`, run by the
   on-incident hook or by a scheduled workflow.
2. **Raw records hold references, not copies** (ADR-08). An excerpt of at most 15,000 characters
   is redacted before the write (11 §6).
3. **Tracer is optional.** When `GREENLIGHT_INGEST_URL` is set, records are also POSTed in the
   existing ingest shape (`tools/tracer` `POST /api/ingest`, OTel/OpenInference), and the record's
   `refs` gain `tracer:<id>`.
4. **The wiki is downstream of raw, and skills are downstream of the wiki.** Skills never read
   raw records except through the proposer's tool interface (06 §3.4).

## 6. Runtime sequences

### 6.1 A loop turn with hooks (deploy-verify-promote)

```
agent                       CLI                         CI / providers            wiki
  │ on-start ───────────────▶ wiki lookup --tool X --start
  │◀──── intent.md, liveness.md, decisions (≤40 lines), confirmed patterns for X's cell
  │ edit code + add verify check (id) for the change; add criterion→check mapping
  │ preview X ─────────────▶ build, serve, verify ──────────────────────────────▶ writeRaw(preview)
  │◀──── report (pass) + receipt
  │ git push develop ───────────────────────────────▶ ship X --env beta
  │                                                    build→deploy→verify(sha)
  │                                                    ──────────────────────────▶ writeRaw(ship)
  │ status X ──────────────▶ run chain
  │ on-complete ───────────▶ wiki: update intent.md criteria, decisions.md entry
  │ tell owner: beta URL, what changed, which checks prove it
  │ … owner: "ship it" …
  │ dispatch promote (approved) ────────────────────▶ verify beta --expect-sha → FF → ship prod
```

### 6.2 Vibe-code kickoff (greenlight-kickoff then greenlight-build)

```
owner: "I want X"
agent ── accounts --json ──▶ configured providers, quota headroom, available cells
agent: propose cell + one-paragraph free-tier consequences (from fact pages)  ── owner confirms
agent: write wiki/tools/<n>/intent.md (criteria AC-1..n, owner's words)       ── owner confirms
agent ── add <n> --lane --target --data --liveness <model> ──▶ manifest, infra/<n>.tf, template
agent: write verify checks for each AC (ids), run preview → red
agent: implement until preview green
agent ── secrets gather <n> (only missing ones; hidden prompts, owner types) ──▶ secret source
agent: git push → CI infra.yml (plan → guard → approval → apply) → deploy.yml ship beta
agent: hand owner the beta URL
```

### 6.3 Failure → lookup (on-failure hook)

```
verify/preview/ship fails
  CLI: for each failing VerifyCheck c: lookup(wiki, {checkId: c.id, name: c.name, cell})
  CLI: append to report:  "see: .greenlight/wiki/framework/patterns/<slug>.md (confirmed)"
  CLI: writeRaw(..., wikiHits=[ids])
agent: reads only the linked confirmed patterns (never incidents, never hypotheses)
agent: fixes; re-runs the same gate
```

### 6.4 Incident → maintainer → proposer → gate → release

```
alert issue opened (keepalive) / ship rollback / repeated preview failure
  on-incident hook: wiki capture --from-issue N  → raw records
  owner or schedule: wiki ingest --incident N → maintainer bundle
  maintainer agent → MaintainerOutput JSON → wiki ingest --apply → patterns (hypothesis), incident page
  fix lands, distinguishing check goes red→green on deployed artifact
  wiki remediate --pattern P --field-evidence → status confirmed, ledger row (field)
  wiki propose → ProposerOutput:
     issue (mechanism/doctor/verify)  → GitHub issue; human PR; ledger on merge+evidence
     patch/create (skill/template)    → bench gate (06 §5) → ledger row → accepted change on branch
  release: human merges; next CLI release ships skills + wiki in lockstep (ADR-04)
```

### 6.5 Secrets through the proxy (P4)

```
agent env: CLOUDFLARE_API_TOKEN=gl-placeholder-cloudflare, HTTPS_PROXY=<proxy>, NODE_USE_ENV_PROXY=1
agent ── wrangler / fetch api.cloudflare.com ──▶ proxy
proxy: host ∈ inject.hosts? method+path ∈ allow? → swap Authorization → upstream
proxy: scrub response per inject.scrub → agent
proxy: audit (session, host, method, path, status) → raw record kind 'session'
not allowed → 403 from proxy, logged; the agent never sees the real value
```

## 7. Failure isolation

- A wiki that fails lint degrades lookup to "no hits". It never fails `preview`, `verify`, `ship`
  or `promote`. Lint failures surface through `doctor` (DR-28).
- A failed Tracer POST is best-effort with a 5-second timeout, matching `stageEventSink` in
  `cli/src/commands/ship.ts`.
- A failed raw write is reported on stderr and never changes a gate's exit code.
- If the credential proxy is unreachable, provider calls fail closed with a placeholder-rejected
  error. `doctor` reports proxy reachability, CA trust and `NODE_USE_ENV_PROXY` (11).
