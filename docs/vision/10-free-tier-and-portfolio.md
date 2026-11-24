# 10 — Free tiers, liveness and the portfolio

This document specifies how Greenlight keeps a portfolio of tools alive on free tiers. It defines
the liveness models, the fact pages that describe each tier, the quota accounting that stops one
project starving another, the portfolio view and retirement. The schemas are in 08 §1.2, §3.2 and
§11, and the commands are in 07 §3.1–§3.3.

## 1. Liveness models

### 1.1 The four models

Each tool declares what idleness does to its weakest dependency. The model then decides what the
keepalive does, which route it probes and what `doctor` checks.

| model | what idleness does | keepalive does | probe MUST | probe MUST NOT | doctor |
|---|---|---|---|---|---|
| `needs-traffic` | the store pauses (Supabase Free after 7 days without database activity) | periodic probe that **executes a query** (`probeTable` → `GET /rest/v1/<table>?select=<col>&limit=1`, 2xx only) | reach the store's query engine | stop at a cache or schema layer | DR-22 |
| `needs-silence` | the store scales to zero and bills while awake (Neon) | nothing against the store; optionally `/health/live` for app reachability | — | touch the store at all, including the container healthcheck (C2, C6) | DR-21 |
| `needs-heal` | compute is reclaimed (OCI Always Free) or dies (docker host) | probe `/health/live` (app layer); on failure, dispatch the remediate workflow (re-apply + redeploy) | reach the app process through the tunnel | wake a database behind it | DR-23 |
| `always-on` | nothing (Workers/Vercel with `none`/`d1`/`kv`) | none required | — | — | — |

These follow the two keepalive failures, which went in opposite directions. HeistMind's probe
stopped short of the store it was meant to keep awake. Polyphony's probes reached a store that
should have been left alone. A probe has to touch exactly the layer whose state it manages.

### 1.2 Default model by cell

`add` and `adopt` use this table as the `--liveness` default, and the schema rules in 08 §1.2
reject contradictions.

| target \ data | `none` | `d1` | `kv` | `supabase` | `neon` |
|---|---|---|---|---|---|
| `workers` | always-on | always-on | always-on | — | — |
| `vercel` | always-on | — | — | needs-traffic | needs-silence |
| `oci` | needs-heal | — | — | — | needs-heal (compute) + DR-21 for the store |
| `docker` | needs-heal | — | — | — | needs-heal + DR-21 |

A tool that is `needs-heal` at the compute layer and also uses Neon, wired directly in infra as
Polyphony is, takes the model `needs-heal`. DR-21 still checks the needs-silence property of its
store. This is because DR-21 reads `infra/<tool>.tf` for `neon_*` resources, independently of the
declared model.

### 1.3 Keepalive wiring

The keepalive Worker (`packages/keepalive`, `KeepaliveTarget`) is configured from the manifest.

- **`needs-traffic`** produces a `supabase` target. `probeTable` comes from `liveness.probe`, and
  `probeSchema` comes from the tool's schema-per-env name when one is used.
- **`needs-heal`** produces an `oci`/`docker` target with `probePath: liveness.probe`, which MUST
  be the C2 live route, for example `/mcp/health/live`.
- **`needs-silence`** and **`always-on`** produce no target.

`infra/modules/keepalive` keeps its existing inputs. The wrapper's keepalive `.tf` is generated
from the manifest by `add`/`adopt` instead of being hand-maintained, and `doctor` DR-22 and DR-23
compare the two.

## 2. Fact pages

Each free tier that Greenlight can use has one `fact` page in the framework wiki (08 §3.2) at
`wiki/facts/<provider>-<tier>.md`. A page records whether a card is required, idle behavior, what
the tier forbids (for example commercial use), the quotas with their scope, how usage can be
measured, and the provider pages the values came from, with a `verified` date. Lint expires a page
after 90 days (LR-17).

**Quota numbers change, so this document does not assert them as current.** The "seed" column
gives values the authors are confident held recently. M1 MUST re-check every value against the
source and record the check date before the page is marked `confirmed`. Cells marked TBD MUST be
filled from the source at M1.

| page | card required | idle | quotas to record (scope) | seed value (verify at M1) | usage probe | source to check |
|---|---|---|---|---|---|---|
| `facts/cloudflare-workers-free` | no | unaffected | requests (account, per day); CPU time per invocation; cron triggers (account) | 100,000 requests/day; 10 ms CPU per invocation; cron count TBD | Cloudflare GraphQL Analytics (`workersInvocationsAdaptive`) | developers.cloudflare.com/workers/platform/limits/ |
| `facts/cloudflare-kv-free` | no | unaffected | reads/day, writes/day, storage (account) | 100,000 reads/day; 1,000 writes/day; 1 GB | GraphQL Analytics (KV operations) | developers.cloudflare.com/kv/platform/limits/ |
| `facts/cloudflare-d1-free` | no | unaffected | rows read/day, rows written/day, storage (account) | 5 M rows read/day; 100,000 rows written/day; 5 GB | GraphQL Analytics (D1) | developers.cloudflare.com/d1/platform/limits/ |
| `facts/vercel-hobby` | no | unaffected (functions are cold-started) | bandwidth, function invocations and duration, builds (account); **non-commercial use only** | TBD | Vercel usage API, availability TBD | vercel.com/docs/limits , vercel.com/docs/plans/hobby |
| `facts/neon-free` | no | **scales to zero** after a few minutes with no connections; compute is billed while awake | compute hours (per project), storage (per project), projects (account), branches (per project) | TBD (the plan changed during 2025) | Neon API consumption endpoints, plan availability TBD | neon.com/pricing , neon.com/docs/introduction/plans |
| `facts/supabase-free` | no | **pauses** after 7 days without database activity | active projects (account), database size, egress | 2 active projects; 500 MB database; egress TBD | Management API usage, TBD | supabase.com/pricing |
| `facts/gemini-aistudio-free` | no (AI Studio key, no billing) | unaffected | requests/min, requests/day, tokens/min **per model**; the default model rotates | TBD per model | none (the agent template records 429s as attempts) | ai.google.dev/gemini-api/docs/rate-limits |
| `facts/hcp-terraform-free` | no | unaffected | managed resources (organization) | 500 managed resources | HCP API (resource count) | hashicorp.com/products/terraform/pricing |
| `facts/github-actions-free` | no | workflows in an inactive public repo are disabled after 60 days without activity (why keepalive is a Cron Worker, not a scheduled workflow) | minutes/month for private repos; storage | public repos: free standard runners; private: 2,000 min/month | REST billing usage API | docs.github.com/billing (GitHub Actions) |
| `facts/oci-always-free` | **yes**, at signup | idle instances are **reclaimed** | Ampere A1 OCPUs and memory (tenancy), boot volume storage | 4 OCPUs and 24 GB memory total for A1 | OCI usage API, TBD | docs.oracle.com/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm |
| `facts/docker-self-host` | n/a (the owner's host) | the host may die; no idle reclaim | none from a provider | — | none | — |

Every `TokenSpec` provider pack in `cli/src/providers.ts` MUST name its fact page or pages through
a new `facts: string[]` field on `ProviderPack`, so that `accounts` can find them.

## 3. Quota accounting

### 3.1 Consumers

A tool consumes a quota when its `liveness.quotas` lists the quota key (08 §1.2). `add` fills the
list from the cell, using the rule set below. It can be edited by hand and is checked by LR-16 and
LR-21 indirectly.

| cell element | quota keys added |
|---|---|
| target `workers` | `fact/cloudflare-workers-free#requests` |
| data `kv` | `fact/cloudflare-kv-free#reads`, `#writes` |
| data `d1` | `fact/cloudflare-d1-free#rows-read`, `#rows-written` |
| target `vercel` | `fact/vercel-hobby#bandwidth`, `#function-invocations` |
| data `neon` | `fact/neon-free#compute-hours` (per project), `fact/neon-free#projects` (account) |
| data `supabase` | `fact/supabase-free#projects`, `#db-size` |
| lane `agent` | `fact/gemini-aistudio-free#requests-per-day` |
| target `oci` | `fact/oci-always-free#a1-ocpu`, `#a1-memory` |
| always | `fact/hcp-terraform-free#managed-resources`, `fact/github-actions-free#minutes` (private repos only) |

### 3.2 Observations, not consumer counts

Earlier drafts counted consumers from the manifest and called the result "measured". That
conflates three different things, and this section keeps them apart. Each value is a
`QuotaObservation` (08 §11.1) with one of three sources:

| source | what it is | example | may it gate? |
|---|---|---|---|
| **observed** | a value read from the provider's usage API for a concrete account and resource, over a stated period | Neon compute hours for project `p-123`, March so far | yes |
| **declared** | what the manifest says a tool will hold, before or without measurement | "heistmind holds one Supabase project" | informational only; never substitutes for an observation of the same quota |
| **estimated** | a projection for a tool that does not exist yet (§3.3) | idle baseline for a new Worker | warns only; never blocks without an observation behind it |

The rules are:

1. **Key by resource.** An observation is identified by `(provider, account, resource, quota,
   period, unit)`. Per-project quotas, such as Neon compute hours per project, are reported per
   project, and a warning names the project: `neon-free#compute-hours on project p-123 (polyphony,
   tracer): 82%`.
2. **Deduplicate shared resources.** Two tools sharing one store (`dataShareWith`) map to one
   resource. The observation lists both tools in `managedBy`, and the store counts once.
3. **Count what Greenlight does not manage.** Account-scoped quotas, such as the number of Neon or
   Supabase projects, include resources the provider reports that no manifest entry maps to. These
   are flagged `outsideGreenlight: true`. A manual project on the same account therefore reduces
   headroom, as it does in reality.
4. **Units never convert implicitly.** An observation's unit must equal the fact page's unit. A
   request count cannot stand in for CU-hours, bandwidth, rows scanned or storage. Where no usage
   API exists for a quota's unit, that quota's value is `unknown`.
5. **Unknown is not safe.** `headroomPct` is `null` and the status is `unknown` when no observation
   exists. Kickoff and `add` treat `unknown` as a reason to tell the owner, never as permission
   (§3.3). The output always says which quotas are unknown and why, for example `no usage API`,
   `token unavailable` or `history too short`.
6. **Thresholds apply to observations.** Observed usage at or above 80% gives a warning in
   `accounts` and DR-27 W. At or above 95% it gives DR-27 E.

`accounts` and `portfolio` run the same function, `computeHeadroom(config, packs, facts)`. It
gathers observations from each configured pack's `usage()` (08 §3.2), adds declared allocations
from the manifest, deduplicates by resource, and returns `AccountsReport.headroom` (08 §11.2).
Observations need a provider token, which only an operator shell or CI holds (11 §4.4). An agent
session therefore reads the last CI-computed report, which `doctor --live` writes as an artifact,
rather than calling provider usage APIs itself.

### 3.3 Projection for a new tool

`add` (and kickoff, through `accounts --cell`) projects the effect of a new tool on each quota in
its `liveness.quotas`. A projection is reported only when its inputs support it:

```
projected(q, r) = current(q, r) + estimate(q, newTool)     // r = the resource the new tool will use
warn  if projected / limit ≥ 0.80
block if projected / limit ≥ 1.00 and current is observed   (exit 4 unless --accept-headroom; 07 §2.2)
```

**`current(q, r)`** is the observed value. For a quota scoped to the account, the observation is
for the account. For a quota scoped to a project or database, `r` is the new tool's own resource,
which is new and therefore zero, unless the tool shares a store through `dataShareWith`, in which
case `r` is the shared resource. For rate quotas, `current` is the maximum daily value over the
trailing 7 days from the observation's `history`. If the history covers fewer than 7 days, or no
observation exists, `current` is `unknown`. The projection is then `unknown` too, and it never
blocks.

**`estimate(q, newTool)`** is chosen by the first rule that applies, and only when its unit matches
the quota's unit:

1. **Count quotas** (projects, OCPUs, managed resources): exact.
   - A new project or database counts 1. A tool using `dataShareWith` counts 0, because it adds no
     project.
   - Compute counts its declared OCPUs.
   - Managed resources count the resources in the `infra/<name>.tf` that `add` is about to emit.
2. **Sibling median.** For rate quotas whose unit matches a measured sibling: when at least two
   existing tools share the cell and have observed values in the same unit, the estimate is the
   median of their trailing-7-day maximum.
3. **Idle baseline**, for request-count quotas only. This is the traffic Greenlight itself
   generates, computed from schedules:
   - keepalive probes per day, which are 0 for `always-on` and `needs-silence`;
   - plus verify runs per day multiplied by checks per verify;
   - plus agent cron runs multiplied by LLM calls per run.

   The baseline is never used for compute-time, bandwidth, row or storage quotas. Those are
   `unknown` when no sibling exists.

Each line of output names its basis. For example: `<label> on <resource>: <current> + <estimate> =
<projected> / <limit> (<pct>%) [observed+sibling-median]`, or `headroom unknown: no usage API for
CU-hours`.

### 3.4 Cell availability

The cell `lane/target/data` is **available** when every provider pack it needs has
`configured: true`. The packs a cell needs are:

- `cloudflare`, always, as the DNS and keepalive host;
- `hcp`, always, for Terraform state;
- `github`, always;
- the target's pack: `vercel`, `oci` or `docker` (workers is covered by `cloudflare`);
- the data pack: `neon` or `supabase` (D1 and KV are covered by `cloudflare`);
- `gemini` for the `agent` lane.

`accounts` lists every MATRIX cell (`packages/shared/src/schema.ts`) with `available` and
`missing`. The kickoff skill proposes only available cells, and offers to set up a missing provider
with that provider's fact page linked.

## 4. The portfolio view

`greenlight portfolio` (07 §3.2) is the owner's release control panel. Its columns and their exact
meanings are:

| column | meaning | source |
|---|---|---|
| cell | `lane/target/data` | manifest |
| liveness | model | manifest |
| prod | sha served at prod `/__version`, plus whether a passing verify exists **for that sha** | C1 route; ship raw record or CI run with `headSha` |
| beta | the same for beta; `n/a (direct)` for tools without beta | as above |
| waiting | commits on `origin/develop` not on `origin/main` | `git rev-list --count origin/main..origin/develop` (in the submodule for cross-repo tools) |
| ready to release | `waiting > 0` **and** beta sha == `origin/develop` tip **and** beta verified at that sha | derived |
| last ship | env, result, age | raw store / deploy workflow |
| keepalive | last sweep result and age | keepalive status / alert issues |
| alerts | open alert-issue count with links | GitHub issues |
| promotion | `human` / `auto-on-green` | manifest |

"Verified" always means verified **at the sha that is currently served**. A passing verify for an
earlier sha does not count. This is the portfolio-level form of the SHA-gating rule, and the case
it guards against is beta serving a build that was never verified, after a failed ship with no
rollback.

## 5. Retirement

Vibe coding makes projects cheap to start, so a dead project that is never retired keeps spending
quota and keepalive sweeps. Retirement has to delete precisely the tool's own resources, decide
what happens to its data, and leave every other resource alone. The existing destroy guard in the
generated `infra.yml` (`cli/src/commands/init.ts`) exits 1 when a plan would delete a Supabase,
Neon, D1 or R2 store. It fails the plan job before any approval step, so approval cannot resume
it. Retirement therefore needs its own authorization path, and it MUST NOT be implemented by
removing or weakening the general guard.

### 5.1 Lifecycle

```
active ──retire start──▶ retiring ──teardown confirmed──▶ retired
             │                │
             └──── abort ─────┘ (back to active; nothing destroyed yet)
```

- **`active`** is the normal state.
- **`retiring`** means the manifest entry remains, with `lifecycle: 'retiring'` (08 §11.3), and the
  tool's inventory is frozen in `wiki/tools/<name>/retirement.md`. Deploys and the keepalive stop
  for the tool. Resources still exist until the authorized apply runs.
- **`retired`** is reached only after every inventory item has an outcome recorded and confirmed.
  The manifest entry is then removed and the wiki folder is archived. The inventory page is kept
  as the record.

### 5.2 Inventory

`retire <name> --start` builds the inventory from four sources and writes it to
`retirement.md`. Every resource appears once, with its owner and its planned outcome.

| source | examples | how it is torn down |
|---|---|---|
| **Terraform-owned** | the tool's Neon project or branch, its D1 database, DNS records, the custom domain, the keepalive target | the authorized apply (§5.4) |
| **Wrangler-managed** | agent-lane Workers and their KV namespaces, created by `wrangler deploy` and not in Terraform state | `wrangler delete` and `wrangler kv namespace delete` in the protected job, listed by name and id |
| **adopted, existing** | an adopted Vercel project, an adopted Supabase project, an external tool repo | an explicit choice per resource: **detach** (remove domains, env vars and the Greenlight wiring, leaving the resource) or **delete**. The default is detach |
| **shared** | a store used through `dataShareWith` by another tool | always **kept**. Retiring a sharer removes only its own access. Retiring the owner is refused while any sharer remains |

Secrets are listed too, and they are deleted from the secret source only after the resources are
gone.

### 5.3 Data disposition

Each store in the inventory gets one disposition, recorded in `retirement.md`:

- **export**: the protected job dumps the store (Neon `pg_dump` to an artifact, D1 export, KV
  export) and records the artifact id before anything is deleted;
- **keep**: the resource is detached and left in place, still counting against quota;
- **delete**: destroyed without export. This requires the owner to write the store's name in the
  authorization (§5.4).

A store without a disposition blocks the authorization.

### 5.4 Plan-bound deletion authorization

1. `retire <name> --plan` removes the tool's Terraform declarations on a branch and runs
   `terraform plan` in CI, which uses the read-only token. CI writes the plan's destroy set, meaning
   every address with a `delete` action, and the plan's hash to `retire/<name>.json`:

   ```ts
   interface RetireAuthorization {
     v: 1; tool: string;
     wrapperSha: string;            // commit the plan was made at
     planHash: string;              // sha256 of the saved plan file
     destroy: string[];             // exact Terraform addresses
     wrangler: { kind: 'worker' | 'kv'; name: string; id: string }[];
     detach: { provider: string; resource: string }[];
     data: { address: string; disposition: 'export' | 'keep' | 'delete' }[];
     expiresAt: string;
   }
   ```
2. The owner reviews `retire/<name>.json` and approves it with a signed release tag whose payload
   adds `retire: "<sha256 of retire/<name>.json>"` (18 §3.1).
3. The generated `infra.yml` guard gains one exception. When the run carries a verified approval
   whose `retire` hash matches a committed `retire/<name>.json`, **and** the plan's hash equals
   `planHash`, **and** the plan's destroy set equals `destroy` exactly, the guard permits those
   deletes. Otherwise the guard behaves as today:
   - any delete outside the authorized set fails the job;
   - a plan that differs from the authorized one fails the job;
   - a delete of a shared store fails the job even if it is listed.
4. The apply runs only in the protected job (18 §5 row 10), at `wrapperSha`. It exports data where
   the disposition is `export`, then applies, then runs the Wrangler deletions, then the detaches.

### 5.5 Confirmation

After the apply, `retire <name> --confirm` checks each inventory item and records an outcome: a
Terraform resource is absent from state and from the provider's API; a Wrangler resource no longer
lists; a detached resource no longer carries Greenlight domains or env vars; an export artifact
exists. Items it cannot check are marked `unverified`, and the tool stays `retiring` until the
owner records them by hand. Only when every item has an outcome does the tool move to `retired`.
`accounts` then shows the quota returning, from observations rather than from the manifest edit.

## 6. No-domain mode

Without `domain` (FR-KICK-04, ADR-09), URLs are resolved as in 08 §1.3.

- Workers prod is `https://<name>.<sub>.workers.dev` in the production account. Beta is a separate
  Worker in the beta account (18 §4), at `https://<name>-beta.<cloudflare.beta.accountSubdomain>.workers.dev`.
- Vercel URLs come from the adapter: the production `*.vercel.app` URL and the branch alias for
  `develop`.
- `oci` and `docker` are unavailable, because their Cloudflare tunnels need a zone.
- `doctor` skips DNS checks (DR-15) and probes these URLs for DR-16.
- The keepalive Worker itself runs on `workers.dev`.
- **Beta lives in a separate free Cloudflare account** (18 §4), so beta Workers and their D1 and KV
  resources are created there without approval. Production resources are created only by the
  approved apply in the protected job.
- **Beta access.** `workers.dev` URLs are public. A `private` tool's beta MUST be protected with
  Cloudflare Access on its `workers.dev` hostname, and Worker preview URLs (`preview_urls`) MUST be
  disabled, because a version preview URL would otherwise bypass Access. DR-15 checks both in
  `--live` mode.
- A domain can be added later with `greenlight config set domain <d>`. That command is out of scope
  here and is noted as an M4 follow-up. After it, the next `infra.yml` apply creates the DNS records
  and custom domains. The `workers.dev` URLs keep working until they are disabled.
