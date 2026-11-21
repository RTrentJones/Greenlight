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
│ coding agent (Claude Code; Codex in M7)                                                   │
│   loads managed skills: deploy-verify-promote · kickoff · build · portfolio · wiki ·      │
│   provider-*  ── each runs hooks (05 §3) ──▶ greenlight CLI                               │
└───────┬───────────────────────────────┬─────────────────────────────────┬────────────────┘
        │ HTTPS via credential proxy     │ CLI calls                       │ git push
        ▼ (M5, 11)                       ▼                                 ▼
┌───────────────┐   ┌──────────────────────────────────────────┐   ┌─────────────────────────┐
│ provider APIs │   │ greenlight CLI (@rtrentjones/greenlight)  │   │ GitHub (wrapper + tool  │
│ Cloudflare,   │◀──│  plane 1: init add adopt retire bump      │   │ repos)                  │
│ Vercel, Neon, │   │  plane 2: preview verify ship promote     │   │  Actions = only CI      │
│ Supabase, OCI,│   │           doctor status portfolio accounts│   │  secrets (synced from   │
│ Gemini, HCP   │   │  plane 3: wiki {capture ingest propose    │   │   Infisical in M5)      │
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
| `schema.ts` | zod schemas for every page type, `LedgerEvent`, `EvidenceIdentity`, `RawRecord`, `MaintainerOutput`, `ProposerOutput`, `TaskSpec`, `TrajectoryEvent`, `BaselineIdentity`, `EvaluationRecord`, `Budget` (08 §3–§10) | strict: unknown keys are errors |
| `parse.ts` | `parsePage(path, text) → Page`, `serializePage(page) → string` | YAML frontmatter via `yaml`; preserves body bytes exactly so patches stay stable |
| `load.ts` | `loadWiki(root) → Wiki` (pages by id, index, log, ledger), `resolveId` | normalizes `pattern/x` ↔ `patterns/x` (04 §2.1) |
| `patch.ts` | `applyOps(text, ops) → text`, `applyMaintainerOutput(wiki, out) → Changeset` | exact-substring, exactly-once targets; whole output atomic (08 §9.1) |
| `index-gen.ts` | `generateIndex(wiki) → string`, `diffIndex(submitted, generated)` | sharding by cell past 60 lines (LR-09) |
| `lint.ts` | `lint(wiki, ctx) → LintResult[]`, `fix(wiki) → Changeset` | rules LR-01…LR-21 (04 §5); `ctx` carries manifest, installed version, verify check ids, skills |
| `lookup.ts` | `lookup(wiki, query) → PatternHit[]`, `context(wiki, tool) → ContextBundle` | query by check id/name, class, cell; filters `confirmed` + `affects`/`relevance` (04 §6, 05 §3) |
| `ledger.ts` | `appendEvent(root, event)` (harness only), `proposalHistory(events, id)`, `renderSkillImpact(events) → string` | refuses events without `writer: 'harness'`; append-only (08 §8) |
| `raw.ts` | `writeRaw(root, rec)`, `identity(cwd, tool, env) → EvidenceIdentity`, `retain(rawId)`, `redact(text, secretNames) → text`, `truncate(text, 15000)`, `postTracer(rec)` | identity in §5; redaction rules in 11 §6 |
| `skills.ts` | `loadSkills(dir) → ManagedSkill[]`, `installedSkills(cwd)`, `usedSkills(transcript) → Record \| 'unknown'`, `checkPurpose(skill, wiki)` | replaces `skillVersion()` in `cli/src/commands/ship.ts` (08 §7) |
| `evidence.ts` | `resolveRef(ref) → 'resolved' \| 'changed' \| 'unreachable'`, `exportEvidence(dir)` | a failed fetch is `unknown`, never `verified` (08 §5.3) |
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
| managed skills (copy) | `plugin/skills/`, `cli/assets/skills/` | `.claude/skills/` via `agent sync`; `.agents/skills/` in M7 | `.claude/skills/` via `agent sync <name>` |
| project skills (optional) | — | `.claude/skills/<name>/` with `owner: project` | — |
| ledger | `wiki/ledger.jsonl` (framework skills) | `wiki/ledger.jsonl` (project skills, project patterns' field remediations) | — |
| bench | `bench/tasks/`, `bench/graders/`, `bench/mutants/`, `bench/{splits,models,gate,budget}.json` | — | — |
| raw store | CI artifacts for bench runs; retained evidence and evaluation records in `wiki/evidence/` | `.greenlight/raw/` (gitignored), retained evidence in `wiki/evidence/` (committed), Tracer optional | — |
| verify configs | `tools/_template-*/verify.config.ts` | `apps/blog/verify.config.ts`, `verify/<tool>.config.ts`, local tools' own | adopted tools' deep suites |
| secrets | — | GitHub Actions secrets (today) or an Infisical project (M5) synced to them; trust model declared in the manifest (08 §13, 11, 18) | `GREENLIGHT_DISPATCH_TOKEN` only |

The rule behind the layout is that the framework repo holds what is true for every user, the
wrapper holds what is true for this owner's portfolio, and a tool repo holds only its code plus
pointers. This is the same split the current code already follows for verify configs and infra
(`docs/architecture.md`).

## 5. Evidence identity, join keys and data flows

### 5.1 Identity

**`(tool, gitSha)`** remains the primary join key. The name is a manifest tool name or `blog`.
The sha is the commit that was built, deployed, verified or probed. `StageEvent.gitSha` already
carries it (`packages/loop/src/ship.ts`), `/__version` exposes it at runtime (C1), and `verify
--expect-sha` asserts it.

That key alone conflates things that must stay apart, so every raw record and stage event carries
the full `EvidenceIdentity` (08 §5.1):

| case the sha cannot tell apart | identity component that separates it |
|---|---|
| two dirty-tree previews at one HEAD | `dirty` + `treeHash` |
| a wrapper verify-config change with no tool commit | `wrapperRev.sha` + `wrapperRev.verifyConfigHash` |
| an adopted tool's code moving independently of the wrapper | `sourceRepo` + `gitSha` (tool repo) beside `wrapperRev` (wrapper) |
| several attempts, environments or builds at one sha | `env`, `runId`, `attempt` |
| one logical change spread over many commits | `changeId` |
| what is actually serving | `artifactId` (worker version id, image digest, Vercel deployment id) |
| which skill was used, not just installed | `skills.used` (or `'unknown'`) beside `skills.installed` |

**Claims are invalidated by identity.** A verification claim holds for exactly the identity it
recorded. A changed `verifyConfigHash` makes an old "verified" claim stale for portfolio and
remediation purposes. A different `artifactId` at the same sha is a different artifact. Field
metrics (05 §9) count a *change* by `changeId`, an attempt by `(runId, attempt)`, and a cold
session by the absence of an earlier record with the same `changeId` from the same agent session.

### 5.2 Time scales

Evidence arrives at three time scales. Each has a producer, a record kind (08 §5) and a consumer.

| time scale | producers | raw `kind` | durable refs | consumers |
|---|---|---|---|---|
| **build time**: minutes, inside an agent session | `greenlight preview`, `verify --url`, bench rollouts, agent session | `preview`, `verify`, `bench`, `session` | preview receipt `.greenlight/preview-<sha>`, bench CI artifact | on-failure hook, maintainer, bench gate |
| **deploy time**: minutes, in CI | `greenlight ship` (build → deploy → verify → rollback), `promote` | `ship` | Actions run id, Tracer run id | portfolio, field monitor, maintainer |
| **run time**: days to weeks, unattended | keepalive Worker sweeps, cron freshness checks, alert issues | `keepalive`, `alert` | issue number, Tracer run id | portfolio, on-incident hook, maintainer |

### 5.3 Flow rules

1. **Raw records are written by the CLI, never by agents.** `preview`, `verify`, `ship`, `promote`
   and `bench run` call `writeRaw` at the end of each run. Keepalive and alert evidence enters
   through `greenlight wiki capture --from-issue <n>` and `--from-run <ref>`, run by the
   on-incident hook or by a scheduled workflow. Before automatic capture is wired into a command, a
   milestone's drill MAY use `wiki capture --manual`, which writes a redacted record from a pasted
   report (14).
2. **References are not assumed durable** (ADR-08, revised). A record holds refs and also
   `RetainedEvidence`: the redacted excerpt (at most 15,000 characters), the verdict and content
   hashes (08 §5.3).
3. **Retention.** Once a ledger event or a `confirmed` page cites a record, it is copied to the
   committed `wiki/evidence/`, where it stays as long as anything cites it. Uncited raw records may
   be deleted after 180 days.
4. **Resolution.** A ref that cannot be fetched resolves to `unreachable`, and the claim it supports
   becomes `unknown`, never `verified`. `wiki capture --export` produces a portable bundle of
   retained evidence and the ledger.
5. **Tracer is optional.** When `GREENLIGHT_INGEST_URL` is set, records are also POSTed in the
   existing ingest shape (`tools/tracer` `POST /api/ingest`, OTel/OpenInference), and the record's
   `refs` gain `tracer:<id>`. Tracer never replaces retained evidence.
6. **The wiki is downstream of raw, and skills are downstream of the wiki.** Skills never read
   raw records except through the proposer's read-only interface, which shows training evidence
   only (06 §1.4).
7. **Knowledge capture is downstream of shipping.** A failed capture, lint or Tracer POST never
   changes a gate's outcome (§7).

### 5.4 The bench as a component

The bench runner (`greenlight bench run`, 06 §4.2) has three isolated parts:

- **Rollout container.** The agent runs here as an unprivileged user, with the task brief, the
  fixture and the skill set under test. It has no `bench/graders/`, no `bench/mutants/` and no
  operator credentials. Its egress is limited to package registries, localhost and the fake
  upstreams. The command shims send trajectory events to a write-only socket outside the container.
- **Grading container.** It starts only after the rollout's whole process tree has been killed and
  its container stopped. It mounts the final tree read-only, plus the task's grader, and returns
  per-grader results.
- **Evaluator.** This is CLI code. It applies the policy table (06 §5.4), writes the
  `EvaluationRecord` (08 §10.4) and appends ledger events.

Rollouts run in one of two evaluation modes, recorded in the baseline identity:

- **isolation:** the wiki is off;
- **production:** hooks are on, against a pinned wiki snapshot.

Isolation attributes effects to skill text, and production evaluates the workflow as shipped (06
§4.7).

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
  │ owner approves the verified sha through the protected path (18) ───▶ verify beta --expect-sha
  │                                                    → FF → ship prod, run by the protected identity
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
agent: git push develop → CI provisions BETA resources only → deploy.yml ship beta
       (production resources are created only for an owner-approved commit, 18)
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

### 6.4 One WikiSkill iteration (the first one is M2, 06 §10)

```
evaluator: S = accepted skill set (skillSetHash); id = BaselineIdentity
  bench run --split train (isolation, both models) under S  ──▶ train raw records (+ field records)
  wiki ingest  → maintainer bundle (train + field + incidents only)
maintainer agent (sandbox, bundle only) → MaintainerOutput → wiki ingest --apply → lint
  bench baseline --split val (both models × both modes) if id changed  ──▶ EvaluationRecord
  wiki propose → proposer bundle (index, skill-impact, train summary, val aggregate only)
proposer agent (sandbox, bundle + read-only CLI) → ProposerOutput (one change, or no_action)
evaluator, by outlet (06 §5.6):
   skill/template → candidate rollouts (val, both models × modes) → policy table → EvaluationRecord
   mechanism/doctor → repro: fails on base, passes on candidate; check-all
   verify → assertion rejects faulty artifact, accepts fixed
   control arm (first iteration) → evaluated the same way, labelled control
ledger: candidate-accepted | candidate-rejected | no-action   (append-only events)
owner: reviews the ledger row and the PR/issue → merged | rejected-by-review (withdrawn) …
later: released (CLI version) → verified-in-production (field evidence)
next iteration: if a skill/template change merged, train rollouts regenerate under the new S
```

### 6.5 Incident → maintainer → proposer → gate → release

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

### 6.6 Secrets through the proxy (M5)

The proxy is a security boundary only under the `isolated` trust model, in which the agent holds no
operator credentials and its egress is enforced to the proxy. Under `local-convenience` it routes
credentials but guarantees nothing against an adversarial agent ([11](11-secrets.md) §1.1). Human
release approval never depends on the proxy alone. It rests on the protected execution identity
described in [18](18-release-authority.md).

```
agent env: CLOUDFLARE_API_TOKEN=gl-placeholder-cloudflare, HTTPS_PROXY=<proxy>, NODE_USE_ENV_PROXY=1
agent ── wrangler / fetch api.cloudflare.com ──▶ proxy
proxy: host ∈ inject.hosts? canonicalize path; first matching rule (method, path, query, body,
       resource binding, env scope) allows? select credential by (host, resource, session) → upstream
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
