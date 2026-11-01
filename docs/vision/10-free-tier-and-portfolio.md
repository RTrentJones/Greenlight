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
gives values the authors are confident held recently. P0 MUST re-check every value against the
source and record the check date before the page is marked `confirmed`. Cells marked TBD MUST be
filled from the source at P0.

| page | card required | idle | quotas to record (scope) | seed value (verify at P0) | usage probe | source to check |
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

### 3.2 Algorithm

`accounts` and `portfolio` run the same function, `computeHeadroom(config, packs, facts)`:

1. For each quota `q` referenced by any tool, set `consumers(q)` to the tools that list `q`.
2. **Measure.** If `q.usage` exists and its pack's token is available (an operator shell, or
   `agent run` behind the proxy), call the pack's `usage()` and take the `used` value for `q.key`.
   For an `account`-scoped quota the call is made once. For a `project` or `database` scope it is
   made per consumer, and the maximum is reported.
3. **Estimate when unmeasurable.** When `usage` is absent or fails, `used` is `null` and
   `headroomPct` is `null`, and the report shows `unknown` with the reason. The function MUST NOT
   invent an estimate. The one structural exception is a count quota, such as
   `supabase-free#projects`, `neon-free#projects` or `oci-always-free#a1-ocpu`, where `used` can
   be computed from the manifest itself: the number of consumers, or the sum of their declared
   OCPUs. Those quotas are always measured.
4. `headroomPct = 100 × (1 − used / limit)`, rounded down.
5. **Thresholds.** Current usage at or above 80% gives a warning in `accounts` and DR-27 W. Usage
   at or above 95% gives DR-27 E. The `add` prompt (07 §2.2) uses the *projected* usage from §3.3.

### 3.3 Projection for a new tool

`add` (and kickoff, through `accounts --cell`) warns when adding a tool would push any quota it
draws on to 80% or more. The projection is computed per quota `q` in the new tool's
`liveness.quotas`:

```
projected(q) = current(q) + estimate(q, newTool)
warn  if projected(q) / limit(q) ≥ 0.80
block if projected(q) / limit(q) ≥ 1.00   (exit 4 unless --accept-headroom; 07 §2.2)
```

**`current(q)`** is the measured `used` from §3.2. For rate quotas it is the **maximum daily
value over the trailing 7 days**, not today's partial value, so a quiet morning does not hide a
busy week. When the measurement is unavailable, the projection is reported as unknown and no
warning is raised on that quota. The output says `headroom unknown for <q>` so that the gap is
visible.

**`estimate(q, newTool)`** is chosen by the first rule that applies:

1. **Count quotas** (projects, OCPUs, managed resources): exact. For projects and OCPUs the
   estimate is the new tool's own count, which is 1 for a project and the declared OCPUs for
   compute. For managed resources it is the number of resources in the `infra/<name>.tf` that
   `add` is about to emit, counted from the plan-free module resource list in the provider pack.
2. **Sibling median.** For rate quotas, when at least two existing tools share the new tool's cell
   and have measured usage, the estimate is the median of their trailing-7-day maximum daily usage.
3. **Baseline.** Otherwise, the estimate is the cell's **idle baseline**: the traffic Greenlight
   itself generates for that tool per day. It is computed from the manifest and the schedules, not
   guessed:
   - keepalive probes per day (0 for `always-on` and `needs-silence`, `86400 / interval` for the
     others);
   - plus verify runs per day (assumed 4: two ships, each with beta and prod verification);
   - multiplied by the checks per verify (from the template's `verify.config.ts`);
   - plus the agent lane's cron runs per day multiplied by the LLM calls per run (1 in the
     template).

   The warning text then says `estimate is the idle baseline only; real traffic will add to it`.

The projection result is printed per quota as `<label>: <current> + <estimate> = <projected> /
<limit> (<pct>%) [measured|sibling-median|baseline|unknown]`, and is also emitted in
`accounts --cell … --json` as an additional `projected` object on each quota.

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
quota and keepalive sweeps. Retirement is a manifest edit, applied through the existing gated
infrastructure path.

1. **`greenlight retire <name>`** (07 §3.3) removes the manifest entry and `infra/<name>.tf`. It
   removes the keepalive target and the tool's `promote.yml` allow-list entry. It archives
   `wiki/tools/<name>/` and records the reason in `decisions.md` and `log.md`.
2. The operator reviews and pushes.
3. **`infra.yml`** runs `terraform plan`. The destroy guard, added in v0.10 with the
   unplanned-replacement guard, sees destroys and requires manual approval through the protected
   environment. The approver sees the full list of resources to be destroyed.
4. After the apply, the operator deletes the secrets that `retire` listed as unused. An archived
   tool repo stays readable.
5. Quotas held by the tool, such as its Neon project and Supabase project, are freed by the
   destroy, and `accounts` shows the headroom returning.

Retirement never deletes data on its own. A store with data (Neon or Supabase) MUST be backed up
or explicitly waived. `retire` asks for this on a TTY, or requires `--data-waived` otherwise, and
records the answer in `decisions.md`.

## 6. No-domain mode

Without `domain` (FR-KICK-04, ADR-09), URLs are resolved as in 08 §1.3.

- Workers prod is `https://<name>.<sub>.workers.dev`, and beta is a separate Worker,
  `https://<name>-beta.<sub>.workers.dev`.
- Vercel URLs come from the adapter: the production `*.vercel.app` URL and the branch alias for
  `develop`.
- `oci` and `docker` are unavailable, because their Cloudflare tunnels need a zone.
- `doctor` skips DNS checks (DR-15) and probes these URLs for DR-16.
- The keepalive Worker itself runs on `workers.dev`.
- A domain can be added later with `greenlight config set domain <d>`. That command is out of scope
  here and is noted for P2 follow-up. After it, the next `infra.yml` apply creates the DNS records
  and custom domains. The `workers.dev` URLs keep working until they are disabled.
