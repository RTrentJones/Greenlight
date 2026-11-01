# 08 — Data contracts

This document lists every schema the system reads or writes. The format is TypeScript, and each
schema MUST be implemented as a zod schema in `packages/shared` (or in `packages/wiki`, a new
package; see 03), with the TypeScript type inferred from it. Every machine-written artifact MUST be
validated strictly before anything trusts it. Unknown fields are errors, which follows the
precedent of `packages/verify/src/validate.ts`, where a typo or a field from a newer version can
never silently switch an assertion off.

All timestamps are ISO-8601 UTC strings. All SHAs are 40-character lowercase hex. "Semver range"
means a range string accepted by the `semver` package.

## 1. Manifest (`greenlight.config.ts`)

### 1.1 Current shape

From `packages/shared/src/schema.ts`: `ConfigSchema = { domain (required), alerts, blog?, tools[] }`.
`ToolSchema` contains `name`, `lane`, `target`, `data`, `auth`, `access`, `envs`, `adopted`,
`port`, `dir`, `readyTimeoutMs`, `external`, `preview`, `tokens`, `tokenOverrides`,
`dataShareWith` and `requireMigrationApproval`.

### 1.2 Changes

```ts
// ConfigSchema
domain?: string;                 // CHANGED: optional (no-domain mode, FR-KICK-04)
cloudflareAccountSubdomain?: string; // NEW: "<sub>" for <name>.<sub>.workers.dev when domain is absent
promotion?: PromotionPolicy;     // NEW: portfolio default, overridable per tool (default 'human')

// ToolSchema
liveness: Liveness;              // NEW, REQUIRED for new tools; `doctor` warns (DR-20) when absent on existing
promotion?: PromotionPolicy;     // NEW
wiki?: string;                   // NEW: project-wiki folder, default `wiki/tools/<name>`
kind?: 'service' | 'package';    // NEW, default 'service'; 'package' reserved for the future package lane

type PromotionPolicy = 'human' | 'auto-on-green';

interface Liveness {
  /** What idleness does to this tool's weakest dependency. */
  model: 'needs-traffic'    // a store that pauses when idle (supabase)
       | 'needs-silence'    // a store that scales to zero and bills while awake (neon); no probe may touch it
       | 'needs-heal'       // compute that can be reclaimed (oci) or die (docker); probe the app, heal on failure
       | 'always-on';       // workers/vercel with none|d1|kv: nothing to keep alive
  /** Path the keepalive probes. REQUIRED for needs-traffic and needs-heal.
   *  For needs-traffic it MUST reach the store (see keepalive probeTable); for needs-heal it MUST NOT. */
  probe?: string;
  /** Free-tier quotas this tool draws on, by fact-page id (§3.3), for headroom accounting. */
  quotas?: string[];             // e.g. ['fact/neon-free#compute-hours', 'fact/workers-free#requests']
}
```

**Validation rules**, added to `superRefine`:

- When `domain` is absent, every tool's target MUST be `workers` or `vercel`.
  `cloudflareAccountSubdomain` MUST be set when any tool targets `workers`.
- `liveness.model` MUST be consistent with `data` and `target`:
  - `needs-traffic` requires `data: 'supabase'`;
  - `needs-silence` requires `data: 'neon'`, or a store wired directly in infra, which is flagged
    by DR-21, not by the schema;
  - `needs-heal` requires `target` `oci` or `docker`;
  - `always-on` forbids `supabase` and forbids `oci`/`docker`.
- `promotion: 'auto-on-green'` MUST NOT be set on a tool with `access: 'private'`, or on a tool with
  `data` other than `none`, `d1` or `kv`. This keeps autonomous release to low-stakes tools; see
  ADR-07.

### 1.3 URL resolution (`packages/shared/src/url.ts`)

`resolveUrl` gains a no-domain branch.

| env | domain set (current) | domain absent (new) |
|---|---|---|
| prod, workers | `https://<name>.<domain>` | `https://<name>.<sub>.workers.dev` |
| beta, workers | `https://beta.<name>.<domain>` | `https://<name>-beta.<sub>.workers.dev` |
| prod, vercel | `https://<name>.<domain>` | `https://<vercelProject>.vercel.app` (from adapter) |
| beta, vercel | `https://beta.<name>.<domain>` | adapter-supplied branch alias for `develop` |
| blog | apex / `beta.` apex | `https://blog.<sub>.workers.dev` / `https://blog-beta.<sub>.workers.dev` |

On Workers, beta is a separate Worker named `<name>-beta`, not a version alias. This keeps URLs
deterministic, which is the property `resolveUrl` exists to guarantee.

## 2. Skill files

### 2.1 `SKILL.md` frontmatter (portable)

Only fields from the shared agent-skills standard are allowed, plus `version`. `version` is
already read by `cli/src/commands/ship.ts` `skillVersion()`.

```yaml
---
name: deploy-verify-promote        # kebab-case, == directory name
description: <one paragraph; the routing text agents match on>
version: "3"                       # integer string, bumped only by the harness on an accepted change (06 §6)
---
```

A skill MUST NOT rely on any other frontmatter key. A Claude-specific hint MAY appear in the body
only if the skill still works for an agent that ignores it (FR-AGENT-01).

### 2.2 `PURPOSE.md` (Greenlight-specific sidecar, never routed on)

```yaml
---
skill: deploy-verify-promote
version: "3"                       # MUST equal SKILL.md version (LR-12)
owner: framework                   # framework | project   (project skills live in a wrapper)
blast-radius: high                 # low | medium | high   — gate strictness (06 §5.4)
hooks: [on-start, on-failure, on-complete, on-incident]   # which wiki hooks the skill runs (05 §3)
bench-slice: [loop/*, replay/*]    # bench task globs that measure this skill (06 §4)
cites:                             # wiki pages that justify the skill's rules
  - id: pattern/settle-greenlights-previous-deploy
    rule: "verify asserts the deployed sha before any content check"
  - id: decision/oci-direct-to-prod
    rule: "oci has no beta; the local gate is mandatory"
---
# Why this skill exists
<prose: the problem, and which rules came from which evidence>
```

`cites[].rule` quotes, or exactly paraphrases, a rule in the SKILL.md body. Lint checks that the
cited page exists (LR-11). It also checks that every rule-bearing heading in SKILL.md is covered
by at least one citation or by an explicit `uncited: true` marker (LR-13).

## 3. Wiki pages

All pages are markdown with YAML frontmatter. The common fields are:

```ts
interface PageBase {
  id: string;            // "<type>/<slug>", slug kebab-case, == file path without extension, unique per wiki
  type: 'pattern' | 'fact' | 'decision' | 'incident' | 'contract'
      | 'intent' | 'liveness' | 'tool-decisions';
  title: string;
  updated: string;       // ISO date; set by the writer (maintainer or human)
  status: 'hypothesis' | 'confirmed' | 'superseded' | 'archived';
  supersededBy?: string; // page id; REQUIRED iff status == 'superseded'
}
```

### 3.1 `pattern`

```ts
interface PatternPage extends PageBase {
  type: 'pattern';
  kind: 'failure' | 'strategy';
  class: PatternClass;   // open set; lint warns on values not in the list below (LR-07)
  atRisk: string;        // the thing whose state matters ("supabase idle timer (Postgres activity)")
  probed?: string;       // failure only: what the faulty check actually touched ("PostgREST schema cache")
  cells: string[];       // "lane/target/data" globs, e.g. ["next/vercel/supabase", "*/oci/*"]
  applies: string;       // semver range of @rtrentjones/greenlight where this bites (">=0.1 <0.9")
  evidence: EvidenceRef[]; // ≥1 REQUIRED for confirmed
  catches?: CatchSpec;   // the distinguishing check; REQUIRED for confirmed failure patterns (LR-05)
  remediation: Remediation[];
  skills: string[];      // skills whose PURPOSE.md cites this page (lint verifies the back-link, LR-11)
}

type PatternClass = 'proxy-check' | 'artifact-identity' | 'free-tier-physics' | 'env-drift'
  | 'capability-regression' | 'iac-hazard' | 'spec-validity' | 'alert-suppression';

type EvidenceRef = string; // "<scheme>:<locator>":
  // issue:<owner>/<repo>#<n>   pr:<owner>/<repo>#<n>   commit:<owner>/<repo>@<sha>
  // run:<owner>/<repo>/<runId> raw:<rawId>            tracer:<runId>      post:<url>

interface CatchSpec {
  description: string;              // human sentence
  checkSignature?: string;          // matcher against failing VerifyCheck names (§6), a regex
  graderTask?: string;              // bench task id that encodes it (06 §4)
}

interface Remediation {
  outlet: 'mechanism' | 'doctor' | 'template' | 'verify' | 'skill';
  ref: string;                      // "greenlight@0.9.0" | "pr:…" | "skill:deploy-verify-promote@3" | path
  verified: boolean;                // true only with red→green evidence on a deployed artifact or a bench delta
}
```

Body sections, in order: `## Symptom`, `## Root cause`, `## Fix / workaround`,
`## How it is caught`. The body is 10–30 lines (LR-04).

### 3.2 `fact`

```ts
interface FactPage extends PageBase {
  type: 'fact';
  provider: string;            // provider-pack id from cli/src/providers.ts ("neon", "cloudflare")
  verified: string;            // ISO date a human or agent last checked against the provider's docs
  source: string[];            // URLs of the provider pages the values came from
  cardRequired: boolean;
  idle: 'pauses' | 'scales-to-zero' | 'reclaimed' | 'unaffected';
  quotas: Quota[];
}

interface Quota {
  key: string;                 // anchor id, referenced as "fact/<slug>#<key>"
  label: string;
  limit: number;
  unit: string;                // "requests/day", "CU-hours/month", "GB"
  scope: 'account' | 'project' | 'database' | 'worker';
  usage?: UsageProbe;          // how `accounts` measures current usage; absent → headroom unknown
}

interface UsageProbe {
  kind: 'provider-api' | 'graphql' | 'none';
  ref: string;                 // id of a usage function in the provider pack (07 §accounts)
}
```

### 3.3 `decision`, `incident`, `contract`

```ts
interface DecisionPage extends PageBase { type: 'decision'; decided: string; scope: string[]; }
interface IncidentPage extends PageBase {
  type: 'incident';
  tool: string;
  opened: string; closed?: string;
  evidence: EvidenceRef[];
  patterns: string[];          // pattern ids this incident produced or confirmed
  timeline: { date: string; text: string; evidence?: EvidenceRef }[];
}
interface ContractPage extends PageBase {
  type: 'contract';
  clause: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';
  lanes: string[];             // lanes where it applies; "*" for all
  enforcedBy: Remediation[];   // template / doctor / verify / skill
}
```

Incident pages have no length limit. Building agents MUST NOT be given incident pages (05 §3.2).

### 3.4 Project-wiki pages (`wiki/tools/<name>/`)

```ts
interface IntentPage extends PageBase {
  type: 'intent';
  tool: string;
  criteria: Criterion[];
}
interface Criterion {
  id: string;                  // "AC-<n>", stable
  text: string;                // the owner's words, verbatim where possible
  source: 'kickoff' | 'feedback' | 'incident';
  added: string;               // ISO date
  checks: string[];            // verify check ids (§6) that assert it; [] → lint warns (LR-15)
}

interface LivenessPage extends PageBase {
  type: 'liveness';
  tool: string;
  model: Liveness['model'];    // MUST equal the manifest (LR-16)
  atRisk: string;
  probe?: string;
  quotas: string[];
}

interface ToolDecisionsPage extends PageBase { type: 'tool-decisions'; tool: string; }
```

`intent.md` renders `criteria` as a table in the body. The frontmatter is the source of truth, and
the table is regenerated by `wiki lint --fix`.

## 4. Index and log

**`index.md`** consists of one line per non-archived page, grouped under `## <type>`. In the
framework wiki, once the index passes 60 lines (LR-09), patterns are further grouped by `cells`.

```
- [<title>](<relative path>) — <one-line problem> · <one-line root cause> · <one-line fix>
```

For a non-pattern page the three clauses are replaced by a single summary. The index is generated
by `wiki lint --fix` from frontmatter. A maintainer MUST still submit a full `update_index`, which
lint then compares against the generated index (06 §2.3).

**`log.md`** is append-only. Each entry is:

```
## <ISO timestamp> — <actor> — <operation>
<2–6 lines: what changed and why; page ids touched>
```

`actor` is one of: `maintainer:<model>`, `human:<github-login>`, `harness`.

## 5. Raw records (`.greenlight/raw/<rawId>.json`)

```ts
interface RawRecord {
  rawId: string;               // "<ISO compact timestamp>-<8 hex>", e.g. "20261101T120301Z-ab12cd34"
  kind: 'preview' | 'ship' | 'verify' | 'keepalive' | 'alert' | 'bench' | 'session';
  tool: string;
  env: 'preview' | 'beta' | 'prod';
  gitSha: string | null;       // join key with the tool name (03 §5)
  passed: boolean;
  startedAt: string; durationMs: number;
  skills: Record<string, string>;   // skill name → version in effect
  agent?: { vendor: 'claude' | 'codex' | 'other'; model?: string; sessionRef?: string };
  refs: EvidenceRef[];         // CI run, Tracer run, issue, PR — the durable evidence
  excerpt?: string;            // ≤ 15,000 chars, REDACTED (11 §6) — the failing checks + logs tail
  stages?: StageEvent[];       // for kind ship|preview
  verify?: unknown;            // the `verify --json` document (OTel shape, packages/verify/src/export.ts)
  wikiHits?: string[];         // pattern ids surfaced by `wiki lookup` during this run
}
```

Raw records are immutable. A writer MUST create a new file and MUST NOT modify an existing one.
`rawId` uniqueness is guaranteed by the random suffix. Records older than 180 days MAY be deleted
locally. Their `refs` keep the evidence reachable.

## 6. Verify check ids (change to `packages/verify`)

Intent criteria and pattern `catches` need stable handles on checks. Specs currently have no `id`
field, and strict validation would reject one.

- `VerifySpecBase` and `ApiCheck` gain `id?: string` (kebab-case, unique within a tool's config).
  `validate.ts` MUST accept it, type-check it and reject duplicates.
- `VerifyCheck` (the report entry) gains `id?: string`, copied from the spec.
- The `--json` export carries it as `eval.check_id`.
- `checkSignature` (§3.1) matches against `id` first, then against the check's `name`.

## 7. Stage events (change to `packages/loop/src/ship.ts`)

Current shape: `{ stage, tool, env, gitSha, durationMs, passed, detail?, skillVersion? }`.

New shape, which is backward compatible because the added fields are optional:

```ts
interface StageEvent {
  stage: 'preview' | 'build' | 'deploy' | 'verify' | 'rollback' | 'promote';  // + 'promote'
  tool: string; env: DeployEnv; gitSha: string | null;
  durationMs: number; passed: boolean; detail?: string;
  skillVersion?: string;                 // KEPT for compatibility: deploy-verify-promote's version
  skills?: Record<string, string>;       // NEW: every managed skill version in effect
  agent?: RawRecord['agent'];            // NEW: from GREENLIGHT_AGENT / GREENLIGHT_MODEL env, when set
  rawId?: string;                        // NEW: the raw record this event belongs to
}
```

`skillVersion()` is generalized to `skillVersions(cwd)`. It reads `version:` from every
`.claude/skills/*/SKILL.md`, and, when present, from `.agents/skills/*/SKILL.md`.
`GREENLIGHT_SKILL_VERSIONS` (a JSON object) overrides it.

## 8. Ledger (`wiki/ledger.jsonl` → `wiki/skill-impact.md`)

Only the harness writes the ledger, through `bench gate` or `wiki remediate`. Agents MUST NOT write
it, and `wiki lint` fails if a ledger line's `writer` is not `harness` (LR-14).

```ts
interface LedgerRow {
  ts: string;
  writer: 'harness';
  proposalId: string;          // "prop-<rawId-style>"
  pattern: string[];           // pattern ids motivating it
  skill?: string;              // target skill for outlet 'skill' | 'template'
  outlet: Remediation['outlet'];
  change: { kind: 'create' | 'patch' | 'pr' | 'no_action'; diff?: string; ref?: string };
  evidence: GateEvidence | FieldEvidence;
  outcome: 'accepted' | 'rejected' | 'pending-human';
  versionFrom?: string; versionTo?: string;
}

interface GateEvidence {
  kind: 'bench';
  models: string[];            // e.g. a frontier model and a small model (06 §5.3)
  split: 'val';
  runs: number;                // 3
  replay: { total: number; passing: number; regressions: string[] };   // hard constraint
  capability: { before: number; after: number; delta: number; pValue: number };  // per model
}
interface FieldEvidence {
  kind: 'field';
  check: string;               // check id that went red → green
  before: EvidenceRef; after: EvidenceRef;   // runs proving it on a deployed artifact
}
```

`skill-impact.md` is rendered newest-first as a table with these columns: date, proposal, skill or
outlet, patterns, outcome, evidence summary.

## 9. Maintainer and proposer I/O

### 9.1 Maintainer output (`wiki ingest --apply <file>`)

```ts
interface MaintainerOutput {
  create_pages: { id: string; content: string }[];     // full file incl. frontmatter
  update_pages: { id: string; ops: PatchOp[] }[];
  update_index: string;                                // REQUIRED, full index
  append_log: string;                                  // REQUIRED, the entry body (§4)
}
type PatchOp =
  | { op: 'append'; text: string }
  | { op: 'replace'; target: string; text: string }    // target: exact substring, MUST occur exactly once
  | { op: 'insert_after'; target: string; text: string };
```

These are the paper's names, generalized from `patterns` to `pages`. An op whose `target` occurs
zero times, or more than once, is refused, and the whole output is rejected atomically.

### 9.2 Proposer output (`wiki propose --apply <file>`)

```ts
type ProposerOutput =
  | { action: 'create'; outlet: 'skill'; name: string; skill_md: string; purpose_md: string; patterns: string[] }
  | { action: 'patch'; outlet: 'skill' | 'template'; name: string; edits: PatchOp[]; patterns: string[]; file?: string }
  | { action: 'issue'; outlet: 'mechanism' | 'doctor' | 'verify'; title: string; body: string; patterns: string[] }
  | { action: 'no_action'; reason: string };
```

`issue` opens a GitHub issue on the framework repo (outlets `mechanism` and `doctor`). For outlet
`verify` the issue goes on the wrapper, unless `--draft` is given, in which case it writes a draft
under `wiki/proposals/`.

## 10. Bench tasks (`bench/tasks/<taskId>/`)

```
task.json                 # TaskSpec
brief.md                  # what the agent is told — nothing else from this folder is visible to it
grader.verify.config.ts   # hidden grader; a normal verify config (function form allowed)
mutants/<n>/              # ≥1 known-bad implementation or patch; the grader MUST fail each (06 §4.3)
fixture/                  # optional starting repo state (for replay tasks)
```

```ts
interface TaskSpec {
  id: string;                          // "cap/astro-workers-d1-guestbook" | "replay/keepalive-probe-reaches-store"
  kind: 'capability' | 'replay';
  cell: string;                        // "lane/target/data"
  skills: string[];                    // managed skills this task measures
  fidelity: 'runtime' | 'structural';  // structural: graded on artifacts, not live behavior (06 §4.4)
  pattern?: string;                    // REQUIRED for replay
  split: 'train' | 'val' | 'test';
  timeoutMin: number;
  mutants: { id: string; description: string; kind: 'patch' | 'tree' }[];
}
```

## 11. CLI JSON outputs

### 11.1 `greenlight accounts --json`

```ts
interface AccountsReport {
  generatedAt: string;
  providers: {
    id: string;                        // provider-pack id
    configured: boolean;               // all non-optional tokens present in the secret source
    verified: boolean | null;          // fail-fast verify() result; null when not run (--offline)
    fact?: string;                     // fact page id
    quotas: { key: string; limit: number; unit: string; used: number | null; headroomPct: number | null;
              consumers: string[] }[]; // tools whose liveness.quotas reference this quota
  }[];
  cells: { cell: string; available: boolean; missing: string[] }[];  // lane×target×data the owner can deploy now
}
```

### 11.2 `greenlight portfolio --json`

```ts
interface PortfolioReport {
  generatedAt: string;
  tools: {
    name: string; cell: string; liveness: Liveness['model'];
    beta?: { sha: string | null; verified: boolean | null; at?: string };
    prod: { sha: string | null; verified: boolean | null; at?: string };
    waiting: number | null;            // commits on develop not on main (beta ahead of prod)
    lastShip?: { env: string; passed: boolean; at: string; rawId?: string };
    keepalive?: { lastSweep?: string; ok: boolean | null };
    alerts: { url: string; title: string }[];   // open alert issues for this tool
    promotion: PromotionPolicy;
  }[];
  quotas: AccountsReport['providers'][number]['quotas'];
}
```

## 12. Provider registry `inject` (change to `cli/src/providers.ts`)

```ts
interface TokenSpec {           // existing fields: envVar, label, scopes, createUrl, optional, verify, …
  inject?: InjectSpec;          // NEW: absent → CI-only token (listed by DR-30)
  usage?: (token: string, env: Record<string, string>) => Promise<{ key: string; used: number }[]>; // NEW
}
interface InjectSpec {
  hosts: string[];                              // exact hosts, no wildcards beyond a leading "*."
  header: string;                               // "Authorization"
  scheme: 'Bearer' | 'Basic' | 'raw';           // value format
  allow: { method: string; path: string }[];    // glob paths; default-deny everything else
  scrub?: string[];                             // response JSON paths / regexes to redact (11 §5)
}
```

`greenlight secrets proxy-config` renders the union of the configured tokens' `inject` specs into
the selected proxy's format (11 §4).
