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
cloudflare?: {                   // NEW: two free accounts, because Workers script permission is account-wide (18)
  prod: { accountSubdomain?: string };   // "<sub>" for <name>.<sub>.workers.dev when domain is absent
  beta: { accountSubdomain: string };    // REQUIRED when any tool targets workers: beta always runs in this account
};
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
  `cloudflare.prod.accountSubdomain` MUST be set when domain is absent and any tool targets
  `workers`. `cloudflare.beta.accountSubdomain` MUST be set whenever any tool targets `workers`,
  with or without a domain, because beta always runs in the separate beta account (18). The
  account ids themselves are repo variables, not manifest fields.
- `liveness.model` MUST be consistent with `data` and `target`:
  - `needs-traffic` requires `data: 'supabase'`;
  - `needs-silence` requires `data: 'neon'`, or a store wired directly in infra, which is flagged
    by DR-21, not by the schema;
  - `needs-heal` requires `target` `oci` or `docker`;
  - `always-on` forbids `supabase` and forbids `oci`/`docker`.
- `promotion: 'auto-on-green'` MUST NOT be set on a tool with `access: 'private'`, or on a tool with
  `data` other than `none`, `d1` or `kv`. This keeps autonomous release to low-stakes tools; see
  ADR-07.
- **Changing `promotion` is itself a privileged change.** Schema validation cannot stop an agent
  from editing the manifest. The protection is that a policy change takes effect only after the
  owner approves a commit containing it, through the same approval path as a production release
  ([18](18-release-authority.md)). A manifest whose `promotion` differs from the last owner-approved
  manifest is evaluated with the old policy, and `doctor` reports the change as pending (DR-32).

### 1.3 URL resolution (`packages/shared/src/url.ts`)

`resolveUrl` gains a no-domain branch.

| env | domain set (current) | domain absent (new) |
|---|---|---|
| prod, workers | `https://<name>.<domain>` | `https://<name>.<prodSub>.workers.dev` |
| beta, workers | `https://<name>.<betaSub>.workers.dev` (beta account; a `beta.<name>.<domain>` custom domain is not available because the zone lives in the prod account) | `https://<name>.<betaSub>.workers.dev` |
| prod, vercel | `https://<name>.<domain>` | `https://<vercelProject>.vercel.app` (from adapter) |
| beta, vercel | `https://beta.<name>.<domain>` | adapter-supplied branch alias for `develop` |
| blog | apex / `https://blog.<betaSub>.workers.dev` | `https://blog.<prodSub>.workers.dev` / `https://blog.<betaSub>.workers.dev` |

On Workers, beta is a Worker of the same name in the **beta account**, not a version alias and not
a second script in the prod account. This keeps URLs deterministic, which is the property
`resolveUrl` exists to guarantee, and it keeps beta credentials unable to touch prod scripts (18).
This changes the current scheme, which serves beta at `beta.<name>.<domain>`. Existing wrappers
migrate by M5, and until then DR-34 reports the shared-account beta as a blocking gap.

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
  affects?: string;      // semver range of @rtrentjones/greenlight that HAS the framework defect (">=0.1 <0.9");
                         // absent when the pattern is not about a framework defect
  relevance: 'framework-version' | 'app-code' | 'both';
                         // framework-version: surfaced only while the installed CLI is in `affects`
                         // app-code: a lesson about code the owner writes; surfaced regardless of version
                         // both: surfaced always; the framework-version half is flagged when `affects` matches
  evidence: EvidenceRef[]; // ≥1 REQUIRED for confirmed
  catches?: CatchSpec;   // the distinguishing check; REQUIRED for confirmed failure patterns (LR-05)
  remediation: Remediation[];
  skills: string[];      // skills whose PURPOSE.md cites this page (lint verifies the back-link, LR-11)
}

`relevance` exists because a fault fixed in the framework can still recur in app code. A keepalive
probe that stops at a cache is prevented by the framework since 0.9 for Supabase targets. A
hand-written health route that stops at a cache is not, so `keepalive-probe-misses-postgres` has
`relevance: both`.

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
  ref: string;                 // id of a usage function in the provider pack (TokenSpec.usage, §12)
  returns: 'QuotaObservation[]'; // with history where the provider exposes it (§11.1); 'none' → value null (unknown)
}
```

### 3.3 `decision`, `incident`, `contract`

```ts
interface DecisionPage extends PageBase {
  type: 'decision'; decided: string; scope: string[];
  skills: string[];            // skills whose PURPOSE.md cites this page (LR-11 back-link)
}
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
  skills: string[];            // LR-11 back-link
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

## 5. Raw records and evidence identity (`.greenlight/raw/<rawId>.json`)

### 5.1 Identity

`(tool, gitSha)` is one join key among several. It cannot tell apart these cases:

- two dirty-tree previews at the same HEAD;
- a wrapper verify-config change made without a tool commit;
- an adopted tool's code moving independently of the wrapper;
- several attempts, environments or builds at one sha;
- which skill the agent actually used.

Every record therefore carries an `EvidenceIdentity`.

```ts
interface EvidenceIdentity {
  tool: string;
  env: 'preview' | 'beta' | 'prod' | 'bench';
  sourceRepo: string;                  // "<owner>/<repo>" of the code under test (the tool repo for adopted tools)
  gitSha: string | null;               // HEAD of sourceRepo
  dirty: boolean;                      // working tree differs from HEAD
  treeHash?: string;                   // REQUIRED iff dirty: sha256 over tracked + untracked-not-ignored file contents
  wrapperRev: { sha: string | null; verifyConfigHash: string | null }; // the wrapper commit and the content hash of the
                                       // tool's verify config as loaded; a changed config invalidates old claims
  runId: string;                       // CI run id, or a local uuid for local runs
  attempt: number;                     // 1-based retry count within runId
  changeId?: string;                   // the logical change: PR number, or the branch name + merge-base sha
  artifactId?: string;                 // the deployed artifact: worker version id, image digest, vercel deployment id
  skills: {
    installed: Record<string, { version: string; contentHash: string }>;  // every managed skill on disk
    used: Record<string, { version: string; contentHash: string }> | 'unknown'; // observed in the transcript, else 'unknown'
  };
}
```

`skills.used` comes from the agent transcript: skill tool calls, or reads of `SKILL.md` paths. When
no transcript is available it is `'unknown'`, and attribution (05 §9) treats it as unknown. It is
never treated as "all installed".

### 5.2 Raw record

```ts
interface RawRecord extends EvidenceIdentity {
  rawId: string;               // "<ISO compact timestamp>-<8 hex>", e.g. "20261101T120301Z-ab12cd34"
  kind: 'preview' | 'ship' | 'verify' | 'keepalive' | 'alert' | 'bench' | 'session';
  passed: boolean;
  startedAt: string; durationMs: number;
  agent?: { vendor: 'claude' | 'codex' | 'other'; version?: string; model?: string; sessionRef?: string };
  bench?: {                    // REQUIRED iff kind == 'bench'
    task: string; split: 'train' | 'val' | 'test'; model: string; mode: 'isolation' | 'production';
    skillSetHash: string; evaluationId: string; run: number; seed: string;
  };
  refs: EvidenceRef[];         // CI run, Tracer run, issue, PR — durable where possible, never assumed durable
  retained: RetainedEvidence;  // the minimal evidence kept locally regardless of refs (§5.3)
  stages?: StageEvent[];
  verify?: unknown;            // the `verify --json` document (packages/verify/src/export.ts)
  wikiHits?: string[];
}
```

### 5.3 Retention and export

References rot. CI artifacts expire, Tracer is optional, and issues can be edited. Each record
therefore carries `RetainedEvidence`, which stays in the repository for as long as any ledger event
or `confirmed` page cites the record.

```ts
interface RetainedEvidence {
  verdict: 'passed' | 'failed' | 'unknown';
  excerpt: string;             // ≤ 15,000 chars, REDACTED (11 §6): failing checks + log tail
  hashes: { excerpt: string; verify?: string; transcript?: string; diff?: string };  // sha256 of the full artifacts
  fetchedAt: string;
}
```

The rules for retention and export:

- **Location.** Raw records are written under `.greenlight/raw/`, which is gitignored. When a ledger
  event or a page cites a record, `wiki capture --retain <rawId>` copies the record to
  `wiki/evidence/<rawId>.json`, which is committed. Retained records are immutable, so a retained
  record is never edited.
- **Deletion.** Records nobody cites MAY be deleted after 180 days.
- **Fetch failure.** Resolving an `EvidenceRef` (`wiki lint --online`, `wiki remediate`) yields one
  of `resolved`, `changed` (the content hash differs from `hashes`) or `unreachable`. Only
  `resolved` evidence can support a `verified: true` remediation or a `confirmed` status. An
  unreachable ref makes the claim `unknown` and never `verified`. Lint reports any `confirmed` page
  whose only evidence is unreachable and unretained.
- **Export.** `wiki capture --export <dir>` writes all retained evidence plus the ledger as a tarball
  with a manifest of hashes, so the evidence can be moved to Tracer, Langfuse or Phoenix.

## 6. Verify check ids and metadata (change to `packages/verify`, M0)

Intent criteria and pattern `catches` need stable handles on checks. Today the validator rejects an
`id` (`api spec.checks[0]: unsupported field "id"`, `packages/verify/src/validate.ts`). This
change lands in **M0**, because the first iteration's graders and every later drill depend on it.

- `VerifySpecBase` and `ApiCheck` gain `id?: string`, kebab-case and unique within a tool's config.
  `validate.ts` MUST accept it, type-check it and reject duplicates.
- `VerifyCheck` (the report entry) gains `id?: string`, copied from the spec.
- The `--json` export carries it as `eval.check_id`.
- `checkSignature` (§3.1) matches against `id` first, then against the check's `name`.

**C7 metadata.** A verify config MAY export a named `meta` beside its default export:

```ts
export const meta = { invariant: ['live', 'version'] as string[] };  // check ids that MUST hold in every env
export default (ctx: VerifyConfigContext) => [...];
```

The current loader evaluates the module and keeps only the default export. It MUST be changed to
return `{ spec, meta }`, preserving named exports. Per-environment coverage of a function-form
config is computed by calling the default export once for each context: `{preview: true}`,
`{env: 'beta'}` and `{env: 'prod'}`. The check ids each call returns are recorded. DR-26 then
compares `meta.invariant` against the intersection of those three sets. Configs are already
executed by `verify`, so no static analysis is needed. A config that throws for one context counts
as zero coverage for that context.

`VerifyReport` gains `coverage?: { invariant: string[]; byEnv: Record<'preview'|'beta'|'prod', string[]>;
missing: { env: string; id: string }[] }`, filled when the config exports `meta`. It is carried into
the `--json` export as `gl.coverage`.

## 7. Stage events (change to `packages/loop/src/ship.ts`)

Current shape: `{ stage, tool, env, gitSha, durationMs, passed, detail?, skillVersion? }`.

The new shape keeps the existing fields and adds `EvidenceIdentity`, so it remains compatible:

```ts
interface StageEvent extends EvidenceIdentity {
  stage: 'preview' | 'build' | 'deploy' | 'verify' | 'rollback' | 'promote';
  durationMs: number; passed: boolean; detail?: string;
  skillVersion?: string;                 // KEPT for compatibility: deploy-verify-promote's installed version
  agent?: RawRecord['agent'];            // from GREENLIGHT_AGENT / GREENLIGHT_MODEL env, when set
  rawId?: string;
}
```

`skillVersion()` is generalized to `installedSkills(cwd)`. It returns name, version and content hash
for every `.claude/skills/*/SKILL.md`, plus `.agents/skills/*/SKILL.md` from M7.
`GREENLIGHT_SKILLS_USED` (a JSON object, set by an agent wrapper that can observe skill loads)
populates `skills.used`, which is otherwise `'unknown'`.

## 8. Ledger (`wiki/ledger.jsonl` → `wiki/skill-impact.md`)

The ledger is a sequence of **append-only events**. Only the harness writes it, through
`bench gate`, `wiki remediate`, the merge and release workflows, and spend accounting. Lint fails if
any line's `writer` is not `harness` (LR-14). A proposal's history is the set of its events (06
§6.1).

```ts
type LedgerEvent = {
  ts: string;
  writer: 'harness';
  eventId: string;                       // sha256 of the canonical JSON of the rest of the event
  proposalId?: string;                   // absent only for 'spend' and 'release-check'
  stage: 'no-action' | 'candidate-rejected' | 'candidate-accepted' | 'merged' | 'released'
       | 'verified-in-production' | 'withdrawn' | 'release-check' | 'spend';
  path?: 'standard' | 'safety-fix' | 'neutral';   // 06 §5.4; REQUIRED on candidate-* events
  control?: boolean;                     // true for control-arm proposals (06 §10.2); never merged
  pattern?: string[];
  skill?: string;
  outlet?: Remediation['outlet'];
  change?: { kind: 'create' | 'patch' | 'pr' | 'issue' | 'no_action'; diff?: string; ref?: string };
  evidence?: Evidence;
  reason?: string;                       // REQUIRED for no-action, withdrawn, neutral, and human overrides
  versionFrom?: string; versionTo?: string;   // on merged (skill/template)
  release?: string;                      // on released: the CLI version
  spend?: { usd: number; rollouts: number; tokensIn: number; tokensOut: number; evaluationId?: string };
};

type Evidence =
  | { kind: 'bench'; evaluationRecord: string;   // hash of the EvaluationRecord (§10.4)
      results: GateResult[] }                    // one per model × mode
  | { kind: 'repro'; base: EvidenceRef; candidate: EvidenceRef; reproTask: string }  // fails on base, passes on candidate
  | { kind: 'template'; evaluationRecord: string; lanes: string[]; mutantsFailed: number; mutantsTotal: number }
  | { kind: 'artifact'; check: string; faulty: EvidenceRef; fixed: EvidenceRef }       // verify outlet
  | { kind: 'field'; check: string; before: EvidenceRef; after: EvidenceRef };        // verified-in-production

interface GateResult {
  model: string; mode: 'isolation' | 'production'; split: 'val' | 'test'; runs: number;
  replay: { total: number; baselinePassing: number; candidatePassing: number; regressions: string[] };
  capability: { before: number; after: number; delta: number; pValue: number | null };  // null when not computed
  decision: 'pass' | 'fail';                    // this model×mode under the policy table (06 §5.4)
}
```

`skill-impact.md` renders one row per proposal, newest first. The columns are date, proposal,
skill or outlet, patterns, path, latest stage, and an evidence summary in which each model and mode
is shown separately. Control proposals are shown in a separate table.

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
type FilePatchOp = PatchOp & { file: string };   // "SKILL.md" | "PURPOSE.md" (relative to the skill dir) | a template path

type ProposerOutput =
  | { action: 'create'; outlet: 'skill'; name: string; skill_md: string; purpose_md: string; patterns: string[] }
  | { action: 'patch'; outlet: 'skill' | 'template'; name: string; edits: FilePatchOp[]; patterns: string[] }
  | { action: 'issue'; outlet: 'mechanism' | 'doctor' | 'verify'; title: string; body: string; patterns: string[] }
  | { action: 'no_action'; reason: string };
```

A skill `patch` that changes a rule-bearing section of `SKILL.md` MUST carry `PURPOSE.md` edits in
the same `edits` array (LR-13 runs on the result). All edits across all files apply atomically, or
none do. Each `edits[].file` must resolve inside the target skill directory, or to the named
template path. Anything else is refused.

`issue` opens a GitHub issue on the framework repo (outlets `mechanism` and `doctor`). For outlet
`verify` the issue goes on the wrapper, unless `--draft` is given, in which case it writes a draft
under `wiki/proposals/`.

## 10. Bench

### 10.1 Layout and task spec

```
bench/
  tasks/<taskId>/task.json        # TaskSpec
  tasks/<taskId>/brief.md         # what the agent is told
  tasks/<taskId>/fixture/         # optional starting repo state
  graders/<taskId>/               # hidden; never mounted into a rollout container (06 §4.2)
  mutants/<taskId>/<n>/           # ≥1 per grader; the grader MUST fail each (06 §4.3)
  splits.json  models.json  gate.json  budget.json
```

Graders and mutants live outside task folders, so bundle and sandbox builders that copy
`tasks/<id>/` can never include them by accident.

```ts
interface TaskSpec {
  id: string;                          // "<kind-prefix>/<slug>", e.g. "replay/keepalive-probe-reaches-store"
  kind: 'capability' | 'replay' | 'loop' | 'wiki' | 'routing' | 'portfolio' | 'mechanism';
  graders: ('app' | 'trajectory' | 'maintainer' | 'routing' | 'repro')[];   // ≥1; all must pass
  cell?: string;                       // "lane/target/data"; REQUIRED for capability, replay, loop
  skills: string[];                    // managed skills this task measures
  fidelity: 'runtime' | 'structural';
  pattern?: string;                    // REQUIRED for replay and mechanism
  split: 'train' | 'val' | 'test';
  state: 'pending' | 'active' | 'quarantined';  // pending until baselined (06 §4.1); quarantined by a human, with reason
  quarantineReason?: string;
  timeoutMin: number;
  modes: ('isolation' | 'production')[];        // default both
  trajectory?: { rules: TrajectoryRule[] };     // REQUIRED iff graders includes 'trajectory'
  routing?: { expect: string[]; forbid: string[] };   // REQUIRED iff graders includes 'routing'
  mutants: { id: string; grader: TaskSpec['graders'][number]; description: string;
             kind: 'patch' | 'tree' | 'trajectory' | 'maintainer-output' }[];
}
```

### 10.2 Trajectory events and rules

The command shims (06 §4.6) and the transcript parser emit one event per action. Events go to a
write-only socket outside the agent's writable tree.

```ts
interface TrajectoryEvent {
  seq: number; ts: string;
  source: 'shim' | 'transcript';
  cmd: string;                         // "git" | "greenlight" | "wrangler" | … | "<tool-call name>"
  argv: string[]; cwd: string;
  exit?: number;                       // shims only
  meta?: Record<string, string>;       // parsed facts, e.g. { subcommand: "preview", tool: "guestbook", passed: "true" }
}

type Matcher = { cmd: string; args?: string[]; meta?: Record<string, string> };  // args: ordered subsequence, "*" wildcard
type TrajectoryRule =
  | { rule: 'before'; first: Matcher; then: Matcher }    // every `then` is preceded by some `first`
  | { rule: 'after'; trigger: Matcher; then: Matcher; within?: number }  // each trigger is followed by `then` within n events
  | { rule: 'never'; match: Matcher; unless?: Matcher }  // no match, unless `unless` occurred earlier
  | { rule: 'count'; match: Matcher; min?: number; max?: number };
```

Examples:

- "preview before push":
  `{rule:'before', first:{cmd:'greenlight', args:['preview','*'], meta:{passed:'true'}}, then:{cmd:'git', args:['push','origin','develop']}}`
- "never promote":
  `{rule:'never', match:{cmd:'greenlight', args:['promote']}}`
- "look up after a failed verify", which is used in production mode only:
  `{rule:'after', trigger:{cmd:'greenlight', args:['verify'], meta:{passed:'false'}}, then:{cmd:'greenlight', args:['wiki','lookup']}, within:5}`

### 10.3 Baseline identity

```ts
interface BaselineIdentity {
  taskSetHash: string;        // over task.json + brief.md + fixture/ of every task in the split, in id order
  splitsHash: string;         // splits.json + each task's state
  graderSetHash: string;      // graders/ + mutants/ for those tasks
  depsHash: string;           // bench runner lockfile + installed @rtrentjones/greenlight version
  harness: { runnerVersion: string; imageDigest: string };
  agent: { vendor: string; version: string };
  models: string[];           // from models.json, in order
  skillSetHash: string;       // over every managed skill's SKILL.md + PURPOSE.md content
  mode: 'isolation' | 'production';
  wikiSnapshotHash: string | null;   // REQUIRED for production mode
  proxyPolicyHash: string | null;    // the rendered proxy config used by fake upstreams, when any
}
```

Two evaluations are comparable iff all fields except `skillSetHash` are equal (06 §1.5).

### 10.4 Evaluation record

```ts
interface EvaluationRecord {
  hash: string;                        // sha256 of the canonical JSON of the rest
  identity: BaselineIdentity;
  role: 'baseline' | 'candidate' | 'release-check' | 'train';
  proposalId?: string;
  outcomes: {
    task: string; run: number; model: string; mode: 'isolation' | 'production';
    score: 0 | 1; graders: { kind: string; passed: boolean; detail?: string }[];
    seed: string; rawId: string; durationMs: number;
    cost: { usd: number; tokensIn: number; tokensOut: number };
  }[];
}
```

Evaluation records are stored under `wiki/evidence/eval/<hash>.json`. They contain no grader source
and no transcripts, only verdicts and raw ids. The raw records stay under `.greenlight/raw/` and
are retained by the rule in §5.3.

### 10.5 Budget

```ts
interface Budget { monthlyUsd: number; perGateMaxUsd: number; perGateMaxRollouts: number; }
```

`bench/budget.json` is the only budget schema, and the CLI, the evolution loop and the roadmap all
use these names. Spend is summed from `spend` ledger events in the current calendar month (UTC).
There is no local spend file.

## 11. CLI JSON outputs

### 11.1 Quota observations

A provider's usage functions and the manifest both produce `QuotaObservation`s. Accounting keeps
the three sources separate, and it never adds an estimate to an observation.

```ts
interface QuotaObservation {
  provider: string;            // provider-pack id
  account: string;             // provider account / team / org id
  resource: string | null;     // concrete resource id (neon project id, D1 database id, worker name); null for account-wide
  quota: string;               // "fact/<slug>#<key>"
  scope: 'account' | 'project' | 'database' | 'worker';
  period: 'day' | 'month' | 'none';
  unit: string;                // MUST equal the fact page's unit; no implicit conversions
  source: 'observed' | 'declared' | 'estimated';
  value: number | null;        // null = unknown
  window?: { from: string; to: string };
  history?: { at: string; value: number }[];   // observed only; enough for the projection (10 §3.3)
  managedBy: string[];         // Greenlight tools mapped to this resource (deduplicated: a shared store appears once)
  outsideGreenlight: boolean;  // resource exists in the account but in no manifest entry
}
```

The accounting rules:

- **Deduplication** is by `(provider, account, resource, quota)`. Two tools sharing one Neon
  database produce one observation, with two `managedBy` entries.
- **Usage outside Greenlight** counts against account-scoped headroom whenever the provider reports
  it.
- **Projections** are reported only when `unit` matches and `history` covers the projection window.
  Otherwise the headroom is `unknown`.
- **Unknown is never safe.** Kickoff treats `unknown` as a reason to warn and never as permission to
  proceed.

### 11.2 `greenlight accounts --json`

```ts
interface AccountsReport {
  generatedAt: string;
  providers: {
    id: string; account: string | null;
    configured: boolean; verified: boolean | null;
    fact?: string;
    observations: QuotaObservation[];
    headroom: { quota: string; resource: string | null; scope: string;
                limit: number; used: number | null; source: QuotaObservation['source'];
                headroomPct: number | null; status: 'ok' | 'warn' | 'block' | 'unknown' }[];
  }[];
  cells: { cell: string; available: boolean; missing: string[] }[];
}
```

### 11.3 `greenlight portfolio --json`

```ts
interface PortfolioReport {
  generatedAt: string;
  tools: {
    name: string; cell: string; liveness: Liveness['model'];
    lifecycle: 'active' | 'retiring' | 'retired';        // 10 §5
    beta?: { sha: string | null; artifactId: string | null; verified: boolean | null; at?: string };
    prod: { sha: string | null; artifactId: string | null; verified: boolean | null; approvedBy?: string; at?: string };
    waiting: number | null;
    lastShip?: { env: string; passed: boolean; at: string; rawId?: string };
    keepalive?: { lastSweep?: string; ok: boolean | null };
    alerts: { url: string; title: string }[];
    promotion: { effective: PromotionPolicy; pending?: PromotionPolicy };   // pending = edited but not owner-approved (§1.2)
    resources: { provider: string; resource: string; shared: boolean }[];
  }[];
  headroom: AccountsReport['providers'][number]['headroom'];
}
```

## 12. Provider registry `inject` and proxy policy (change to `cli/src/providers.ts`)

The policy language has to express everything 11 and 18 promise. A host-and-path allow-list cannot
do that, so the policy is a list of typed rules evaluated in order, and the default is deny.

```ts
interface TokenSpec {           // existing fields: envVar, label, scopes, createUrl, optional, verify, …
  inject?: InjectSpec;          // absent → CI-only token (DR-30)
  usage?: (token: string, env: Record<string, string>) => Promise<QuotaObservation[]>;
}

interface InjectSpec {
  credential: { id: string; envScope: 'beta' | 'prod'; resources?: ResourceSelector[] };
  hosts: string[];              // exact hosts; a leading "*." is the only wildcard
  header: string; scheme: 'Bearer' | 'Basic' | 'raw';
  baseUrlEnv?: string;          // Worker reverse-proxy fallback: env var the client reads for its API base URL
  rules: PolicyRule[];          // evaluated in order; first match decides; no match → deny
  redirects: 'deny' | 'same-host' | { allow: string[] };   // default 'deny'
  maxRequestBytes: number;      // default 1 MiB
  scrub: ScrubRule[];           // applied to responses, including streamed bodies, chunk by chunk with overlap
  audit: { redactPaths: string[] };  // JSON paths in request/response bodies removed from the audit log
  clients: ClientSupport[];     // which CLIs/SDKs work through this rule set (11 §4)
}

interface ResourceSelector { kind: string; id: string }   // e.g. { kind: 'worker', id: 'guestbook-beta' }

interface PolicyRule {
  effect: 'allow' | 'deny';
  method: string | string[];
  path: string;                 // matched after canonicalization: percent-decoding once, dot-segment removal,
                                // duplicate-slash collapse; a path that changes on a second pass is refused
  pathParams?: Record<string, ResourceBinding>;   // e.g. { scriptName: { kind: 'worker', mustBeIn: 'credential.resources' } }
  query?: Predicate[];
  body?: Predicate[];           // JSON bodies only; a non-JSON body with body predicates → deny
  requireApproval?: boolean;    // allow only with a valid approval record for this request (18)
}
interface ResourceBinding { kind: string; mustBeIn: 'credential.resources' | string[] }
interface Predicate { path: string; equals?: unknown; in?: unknown[]; matches?: string; absent?: boolean }
interface ScrubRule { jsonPath?: string; regex?: string; replace: string }
interface ClientSupport { client: string; version: string; works: boolean; via: 'forward-proxy' | 'base-url' | 'none'; note?: string }
```

**Credential selection.** When several credentials target the same host, the proxy selects one by
`(host, resource, session)`. The resource is extracted by `pathParams` or by the body predicates,
and the session's allowed credential ids come from the session grant (11 §3.3). If the request names
no resource, or names a resource bound to a credential that the session was not granted, the proxy
denies the request. Permissions are never the union of all credentials for a host.

**Unsupported clients.** A client with no `works: true` entry is reported by `secrets proxy-config`
as CI-only for that provider (DR-30). It is never silently routed around.

## 13. Secrets settings

```ts
interface SecretsSettings {     // greenlight.config.ts → `secrets` (optional; defaults shown)
  source: 'github' | 'infisical';                 // default 'github'
  infisical?: { projectId: string; envs: { beta: string; prod: string }; domain?: string };
  sink: 'github' | 'infisical';                   // where `secrets gather` writes; default = source
  proxy?: {
    mode: 'none' | 'infisical-agent-proxy' | 'worker';
    trust: 'local-convenience' | 'isolated';      // 11 §1.1 — declared, and checked by DR-31
    workerUrl?: string;
  };
}
```

The trust model is declared rather than inferred. `isolated` is valid only when the agent runs in an
environment that holds no operator credentials and whose egress is enforced to the proxy. `doctor`
can verify part of that (DR-31), and the rest is the owner's statement, recorded in the manifest
([18](18-release-authority.md)).

## 14. Adapter contract changes (`packages/adapters`)

These are the changes 09 §6 needs for server-rendered Astro on Workers, and that 18 needs for
protected releases.

```ts
interface BuildResult {            // existing: { outDir, ... }
  outDir: string;
  serverEntry?: string;            // NEW: path of the Worker entry when the build is not purely static (Astro + @astrojs/cloudflare)
  artifact: { sha: string; contentHash: string };   // NEW: written to dist/greenlight-artifact.json, read at deploy
}
interface DeployResult {           // existing fields kept
  artifactId: string;              // NEW: Worker version id | image digest | Vercel deployment id (08 §5.1)
  account: 'beta' | 'prod';        // NEW: which Cloudflare account (workers target)
}
```

`deploy(toolDir, 'prod')` MUST refuse unless the process holds a release authorization, the
`GREENLIGHT_RELEASE_AUTHORIZED` value defined in 18. It MUST also refuse unless the artifact's
`sha` equals the authorized sha. The refusal is a defence in depth. The boundary itself is that
only the protected job holds prod credentials (18).
