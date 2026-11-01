# 15 — Seed content

This document contains the initial wiki content as draft pages. A page is **ready to copy only
after it passes the actual `greenlight wiki lint`** (§1, step 7). These drafts were written before
the linter exists, and they must be re-validated when it does. Section 2
pages go in `wiki/` in the framework repo. Section 6 and section 7 pages go in `wiki/` in
`RTrentJones.dev`. Every page uses the schemas in 08 §3.

Evidence refs were resolved against the repos at the time of writing:

- framework commits are on `RTrentJones/greenlight`;
- wrapper commits are on `RTrentJones/RTrentJones.dev`;
- `post:` refs point at the published blog.

A ref marked `TODO` could not be resolved from the material available. It MUST be resolved, or
removed, during M1 seeding, and `wiki lint --online` (LR-03) catches any that are left.

`updated` dates are the date of seeding, written below as `2026-11-01`. Seeders replace them with
the date they actually commit.

## 1. How seeds are compiled

1. **Sources, in priority order.**
   - incident write-ups: the blog posts and the issues they cite;
   - `fix:` commits in both repos, whose subject lines name the failure;
   - the verify-config header comments in the wrapper, which record why each check exists;
   - the "footguns" sections of the provider skills;
   - the manifest comments in `greenlight.config.ts`.
2. **One page per root cause, not per symptom.** The three keepalive failures are three patterns,
   because they had three different causes (§2.1–§2.3). The incident page joins them (§7.1).
3. **Fill in `atRisk`, `probed` and `catches` first.** If the distinguishing check cannot be
   written down, the page stays `hypothesis`.
4. **Set `status: confirmed` only with a verified remediation.** "Verified" means one of:
   - a release containing the fix, plus a later run proving the deployed artifact behaves
     correctly;
   - a guard that fails on the faulty configuration.

   Otherwise the page is `hypothesis`.
5. **Move the knowledge, do not copy it (the one-home rule, 04 §7).** In the same PR that seeds a
   pattern, the source shrinks:
   - a provider-skill footgun paragraph becomes one imperative sentence plus `See
     wiki/patterns/<slug>.md.`;
   - a verify-config header comment in the wrapper becomes one line, `// Why: wiki/tools/<name>/intent.md`,
     while each check keeps a one-line inline comment naming its criterion id (`// AC-3`).
6. **Back-link.** Add each seeded pattern, decision and contract page to `cites` in the
   `PURPOSE.md` of every skill whose rules it justifies, and list those skills in the page's
   `skills`. LR-11 requires the back-link on every cited page type, not only patterns.
7. **Validate before calling a seed ready.** Seeding happens in M1, and it is complete only when
   all of the following hold:
   - `greenlight wiki lint --strict` passes on the seeded framework wiki and project wiki;
   - `pnpm check-seam` passes on every framework page;
   - every `confirmed` pattern satisfies LR-05: evidence, `catches`, and at least one remediation
     with `verified: true` backed by deployed red→green evidence or a guard that fails on the
     faulty configuration.

   A page that fails stays out of the wiki, or enters as `hypothesis`. No exception is granted
   for drafts in this document.
8. **Framework prose is generalized; evidence stays specific.** Framework pages describe the
   failure in terms of lanes, targets and stores, and never name the owner's tools or domain
   (LR-19). The fields `evidence`, `remediation[].ref` and `catches.graderTask` may name the
   owner's repos, issues and commits. This is the LR-19 exception for `EvidenceRef` fields, and it
   keeps the evidence checkable. The project-specific narrative lives in the project wiki and the
   incident pages (§6, §7), which stay in the wrapper.
9. **Separate where a defect lived from where the lesson applies.**
   - `affects` is the semver range of framework versions that carried a framework defect, or `"*"`
     when the defect was in application code.
   - `relevance` says where the lesson keeps applying:
     - `framework-version`: hidden once the installed CLI is outside `affects`;
     - `app-code`: surfaced regardless of CLI version, because newly written app code can repeat
       it;
     - `both`.

   An app-level recurrence of an old framework-era fault therefore still surfaces the general
   guidance.

## 2. Framework patterns

### 2.1 `patterns/keepalive-probe-misses-postgres.md`

```markdown
---
id: pattern/keepalive-probe-misses-postgres
type: pattern
title: A Supabase keepalive that never reaches Postgres
updated: 2026-11-01
status: confirmed
kind: failure
class: proxy-check
atRisk: Supabase free-tier idle timer, measured as Postgres activity
probed: PostgREST's in-memory schema cache at /rest/v1/
cells: ["*/*/supabase"]
affects: "<0.9.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - commit:RTrentJones/greenlight@c97222a07dc82904193ed241f266cb6a15cce29e
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: the probe is a query that only Postgres can answer, and only a 2xx with a row counts as healthy
  checkSignature: "keepalive.*supabase.*probeTable"
  graderTask: replay/keepalive-probe-reaches-store
remediation:
  - { outlet: mechanism, ref: "greenlight@0.9.0", verified: true }
skills: [provider-supabase, deploy-verify-promote]
---
## Symptom
The keepalive Worker reported a Supabase-backed tool healthy on every sweep, but the project paused
anyway after a week. The next sweep got a 530 from the paused project and opened an issue.

## Root cause
The probe requested `/rest/v1/`. PostgREST answers that path from its schema cache without sending
anything to Postgres. Supabase measures idleness at the database, so the idle timer never reset.

## Fix / workaround
Since 0.9.0 a Supabase keepalive target must declare `probeTable`, and the probe becomes
`GET /rest/v1/<table>?select=<col>&limit=1`. Use a dedicated one-row table that is readable
anonymously, so the probe does not expose user data.

## How it is caught
The keepalive refuses a Supabase target without `probeTable`. Only a 2xx response counts as
healthy, so a revoked grant or a rotated key now fails loudly.
```

### 2.2 `patterns/keepalive-probe-cached.md`

```markdown
---
id: pattern/keepalive-probe-cached
type: pattern
title: A keepalive response served from Cloudflare's cache
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: proxy-check
atRisk: the upstream store or app the keepalive is meant to touch
probed: Cloudflare's edge cache in front of the Worker's subrequest
cells: ["*/*/*"]
affects: "<0.9.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3
catches:
  description: the probe's subrequest bypasses the cache, and the upstream access is observable (a query count or log line moves)
  checkSignature: "keepalive.*cache"
remediation:
  - { outlet: mechanism, ref: "commit:RTrentJones/greenlight@938973a9046fc1f10a2bb5c5c85577f25fbefdb3", verified: false }
skills: [provider-cloudflare]
---
## Symptom
Keepalive sweeps succeeded with no corresponding activity at the target.

## Root cause
The Worker's `fetch` to the target could be answered by Cloudflare's cache, so the request never
left the edge. A cached 200 looks the same as a real one to the caller.

## Fix / workaround
Make keepalive subrequests uncacheable. See
`pattern/workers-fetch-cache-conflict` for the way *not* to do it, which is combining
`cache: 'no-store'` with `cf.cacheTtl`.

## How it is caught
In a replay, the target counts requests, and the grader asserts that the count increases once per
sweep.
```

### 2.3 `patterns/workers-fetch-cache-conflict.md`

```markdown
---
id: pattern/workers-fetch-cache-conflict
type: pattern
title: The Workers runtime rejects cache:'no-store' combined with cf.cacheTtl
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: proxy-check
atRisk: every keepalive target (no probe leaves the Worker)
probed: nothing — the Worker throws before the subrequest is sent
cells: ["*/*/*"]
affects: ">=0.10.0 <0.10.1"          # framework versions that carry the defect
relevance: both
evidence:
  - issue:RTrentJones/RTrentJones.dev#86
  - pr:RTrentJones/greenlight#28
  - commit:RTrentJones/greenlight@b23a3010054dba6a3b80a9be90a6ebc3afba2ccd
catches:
  description: a keepalive dry run in the Workers runtime (miniflare) must issue one subrequest per target without throwing
  graderTask: replay/keepalive-subrequest-leaves-worker
remediation:
  - { outlet: mechanism, ref: "greenlight@0.10.1", verified: false }
skills: [provider-cloudflare]
---
## Symptom
After upgrading to 0.10.0, every sweep threw before any probe was sent. The sweep reported the error
and opened an issue, so alerting worked. Prevention had stopped entirely.

## Root cause
The fix for cached probes passed both `cache: 'no-store'` and `cf: { cacheTtl: 0 }`. The Workers
runtime rejects that pair. Unit tests ran in Node, which accepts both options, so the tests passed.

## Fix / workaround
0.10.1 drops `cf.cacheTtl` and keeps `cache: 'no-store'`. Exercise Worker code in the Workers
runtime (miniflare / `wrangler dev`), not only in Node.

## How it is caught
The replay runs the keepalive under miniflare and asserts one subrequest per target. The page moves
to `confirmed` once a production sweep on 0.10.1 is shown, by a hash-verified deployed Worker, to
have reached the probe table.
```

### 2.4 `patterns/caret-zero-major.md`

```markdown
---
id: pattern/caret-zero-major
type: pattern
title: A caret range on a 0.x dependency silently blocks minor upgrades
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: artifact-identity
atRisk: the fix the operator believes is deployed
probed: the lockfile after `pnpm update`, which reported success
cells: ["*/*/*"]
affects: "<1.0.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: doctor compares the installed version against open patterns fixed in newer versions (DR-33), and release notes give the explicit add command
remediation:
  - { outlet: doctor, ref: "DR-33", verified: false }
skills: [deploy-verify-promote]
---
## Symptom
The keepalive fix was released in 0.9.0, but after `pnpm update` the wrapper still ran 0.8.

## Root cause
The dependency was declared as `^0.8.0`. For a 0.x version, a caret range allows only patch
releases, so 0.9.0 was out of range and the update was a silent no-op.

## Fix / workaround
Upgrade across a 0.x minor explicitly: `pnpm add @rtrentjones/greenlight@^<minor>.0`, then
`greenlight bump`. Every minor release's notes give this command.

## How it is caught
DR-33 lists patterns known to the installed wiki that affect the installed version and name a fix
in a later one. Knowledge published after the installed release reaches an old installation only
through the opt-in advisory feed (04 §6). After
any upgrade, confirm the deployed artifact (see `pattern/settle-greenlights-previous-deploy`).
```

### 2.5 `patterns/settle-greenlights-previous-deploy.md`

```markdown
---
id: pattern/settle-greenlights-previous-deploy
type: pattern
title: The verify settle loop can pass against the previous deployment
updated: 2026-11-01
status: confirmed
kind: failure
class: artifact-identity
atRisk: the commit being shipped
probed: whatever artifact the URL served during the settle window
cells: ["*/*/*"]
affects: "<0.8.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - commit:RTrentJones/greenlight@04280a63432a861e51e2b5e4d4bb71a209787bc1
  - commit:RTrentJones/greenlight@debcf1e4fc87ed6209e2c63ee182afa77f0aade5
catches:
  description: /__version must equal the shipped sha before any content check runs (requireIdentity)
  checkSignature: "identity|__version"
remediation:
  - { outlet: mechanism, ref: "greenlight@0.8.0", verified: true }
skills: [deploy-verify-promote]
---
## Symptom
Verify passed right after a deploy whose new artifact was broken.

## Root cause
The settle loop retries checks until they pass, to absorb eventual consistency. The previous
deployment was still serving and already passed, so the loop green-lit it.

## Fix / workaround
Since 0.8, the tool serves its build sha at `/__version`. `ship` passes `--expect-sha`, and the
settle loop gates on identity before any content check. Set `requireIdentity: true`, so that a
missing endpoint fails instead of reading as "unverified".

## How it is caught
The identity probe fails hard when the URL serves a different sha. DR-24 warns about tools whose
spec has no identity check.
```

### 2.6 `patterns/oci-restart-window.md`

```markdown
---
id: pattern/oci-restart-window
type: pattern
title: An OCI container restart outlasts the verify window
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: env-drift
atRisk: a correct deploy reported as failed (false red), which triggers needless rollback or heal
probed: the old or booting container during the restart
cells: ["mcp/oci/*"]
affects: "*"          # framework versions that carry the defect
relevance: both
evidence:
  - commit:RTrentJones/RTrentJones.dev@88c21e1c1a5a8681134c72eec09ae9d3c1cd39b9
catches:
  description: prod verify for oci tools retries through the restart window, gated on identity so it cannot pass early
remediation:
  - { outlet: verify, ref: "commit:RTrentJones/RTrentJones.dev@88c21e1c1a5a8681134c72eec09ae9d3c1cd39b9", verified: false }
skills: [provider-oci, deploy-verify-promote]
---
## Symptom
Prod verify failed right after an OCI deploy that turned out to be healthy a minute later.

## Root cause
Restarting a Container Instance and pulling the new image is asynchronous. Verify began while the
old container was stopping or the new one was booting and running migrations.

## Fix / workaround
Retry prod verify through the restart window, with `settleRetries` × `settleMs` covering the boot.
Always combine the retries with `requireIdentity`, so that a longer window cannot green-light the
old image (see `pattern/settle-greenlights-previous-deploy`).

## How it is caught
The ship-gate fails only after the full window, and the identity gate prevents early passes.
```

### 2.7 `patterns/vercel-build-settle.md`

```markdown
---
id: pattern/vercel-build-settle
type: pattern
title: A Vercel production build outlasts the verify settle window
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: env-drift
atRisk: a correct promote reported as failed
probed: the previous production deployment, or the alias mid-switch
cells: ["next/vercel/*"]
affects: "*"          # framework versions that carry the defect
relevance: both
evidence:
  - commit:RTrentJones/RTrentJones.dev@2545b52af0ad00089897bca3576690bbb801c945
catches:
  description: the settle window covers a prod build plus aliasing, and identity gating prevents passing on the old deployment
remediation:
  - { outlet: verify, ref: "commit:RTrentJones/RTrentJones.dev@2545b52af0ad00089897bca3576690bbb801c945", verified: false }
skills: [provider-vercel, deploy-verify-promote]
---
## Symptom
Verify after a promote failed for a Vercel-hosted tool, then passed on a re-run.

## Root cause
Vercel deploys through its git integration (`deployStyle: 'git'`). A production build plus
aliasing can take longer than the default settle window, so verify read the old deployment or an
alias in mid-switch.

## Fix / workaround
Size `settleRetries` × `settleMs` to the tool's real build time. Keep `requireIdentity: true` so
the longer window cannot pass on the old build.

## How it is caught
The identity check fails until `VERCEL_GIT_COMMIT_SHA` equals the promoted sha.
```

### 2.8 `patterns/neon-never-sleeps.md`

```markdown
---
id: pattern/neon-never-sleeps
type: pattern
title: Idle-time polling keeps a scale-to-zero Neon compute awake
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: free-tier-physics
atRisk: Neon free-tier compute allowance (the compute must suspend when idle)
probed: n/a — no check measured idle database traffic
cells: ["*/*/neon", "mcp/oci/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
  - commit:RTrentJones/Polyphony@TODO   # the worker-wakeup / reaper change in the Polyphony repo
catches:
  description: over a simulated idle window, the app issues zero queries to the store
  graderTask: replay/idle-app-zero-store-queries
remediation:
  - { outlet: skill, ref: "skill:greenlight-build", verified: false }
  - { outlet: doctor, ref: "DR-21", verified: false }
skills: [provider-neon, greenlight-build]
---
## Symptom
An idle containerized app with a Neon database queried Postgres about 50,000 times a day. Neon never suspended, and roughly 720
awake hours a month consumed most of the free compute allowance before any real use.

## Root cause
Three timers ran without doing useful work: a job-queue poll every 2 seconds, a stale-job reaper
every 60 seconds, and a container healthcheck every 30 seconds against `/health`, which queries the
database. Suspension needs five quiet minutes, which never happened.

## Fix / workaround
Wake workers on enqueue instead of polling, and schedule one wake-up for work that is due later.
Run reapers only while jobs run. Point container healthchecks and keepalives at a store-free
`/health/live` (app contract C2, C6).

## How it is caught
A replay counts store queries over an idle window and requires zero. DR-21 flags `needs-silence`
tools whose probe touches the store.
```

### 2.9 `patterns/probe-touches-wrong-layer.md`

```markdown
---
id: pattern/probe-touches-wrong-layer
type: pattern
title: A liveness probe that touches a layer it is not managing
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: proxy-check
atRisk: the layer the probe exists to manage (container for needs-heal, store for needs-traffic)
probed: a deeper or shallower layer than the one at risk
cells: ["*/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: the probe path matches the liveness model — store-reaching for needs-traffic, store-free for needs-heal and needs-silence
remediation:
  - { outlet: doctor, ref: "DR-21", verified: false }
  - { outlet: template, ref: "C2 /health/live in all templates", verified: false }
skills: [deploy-verify-promote, provider-oci, greenlight-build]
---
## Symptom
A container tool's keepalive probed `/health`, which checks the database. It woke a database
that should have stayed asleep, and it told the heal path nothing the heal path needed.

## Root cause
The probe exists to detect a reclaimed or dead container. A probe guarding a pausing store has to
reach the store, but a probe guarding a container has to stop at the application. One endpoint was
serving both purposes.

## Fix / workaround
Split liveness from readiness. `/health/live` answers from the process, and it is what keepalive
and container healthchecks use. `/health` checks dependencies, and only verify calls it at deploy
time.

## How it is caught
DR-21 compares `liveness.probe` against the model. App contract C2 ships both routes in every
template.
```

### 2.10 `patterns/ok-before-success.md`

```markdown
---
id: pattern/ok-before-success
type: pattern
title: A status that reports ok before any attempt has succeeded
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: proxy-check
atRisk: the scheduled work the status claims is happening
probed: the existence of a status record, not a recorded successful attempt
cells: ["agent/workers/*", "*/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@f143d754539eb664f2a6e2e1dbf487ac05bf32d8
  - commit:RTrentJones/greenlight@9d3fc702233be9435d3312effdc2c285068e1034
catches:
  description: verify asserts ok == true AND lastError == null AND lastRun maxAgeHours; the app sets ok only after a recorded success
  checkSignature: "status.*ok|lastRun"
remediation:
  - { outlet: verify, ref: "tools/muse/verify.config.ts", verified: false }
  - { outlet: template, ref: "tools/_template-agent", verified: false }
skills: [provider-gemini, greenlight-build]
---
## Symptom
A cron agent's `/status` could report `ok` while no run had succeeded, and verify itself could accept an
attempt that never succeeded or a matcher that matched nothing.

## Root cause
`ok` was derived from the presence of state rather than from a recorded successful attempt. In the
harness, empty matchers counted as passing.

## Fix / workaround
Set `ok` only after a successful attempt is recorded, and expose `lastError` and `lastRun`. The
harness now requires a successful attempt and rejects empty matchers (app contract C5).

## How it is caught
The agent template's verify spec asserts `ok`, `lastError: null` and `lastRun` freshness together.
```

### 2.11 `patterns/freshness-across-producers.md`

```markdown
---
id: pattern/freshness-across-producers
type: pattern
title: One freshness check across all producers hides a stalled feed
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: proxy-check
atRisk: each individual scheduled feed
probed: the newest run from any producer
cells: ["*/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@7c3ab66f385528bb24cfd8586927c0015182729e
  - commit:RTrentJones/RTrentJones.dev@03f17682f9936b83ff88344b76cc9d31d87dabe5
catches:
  description: one maxAgeHours assertion per producer key (tool:mode), each with its own budget
  checkSignature: "latestRunAtBySource"
remediation:
  - { outlet: verify, ref: "tools/tracer/verify.config.ts", verified: false }
skills: [greenlight-build]
---
## Symptom
A dashboard's health route looked fresh while one daily feed had stopped.

## Root cause
Freshness was computed over the newest run across all tools, and later per tool. A producer that
was still running, or a manual run, masked one that had stalled.

## Fix / workaround
Key last-success time by producer (`tool:mode`) and assert each producer separately, with a budget
matched to its schedule (app contract C4). Run freshness checks only where scheduled ingest exists,
which is often prod only.

## How it is caught
A per-producer `maxAgeHours` assertion fails as soon as its own feed stalls.
```

### 2.12 `patterns/dcr-disabled-silently.md`

```markdown
---
id: pattern/dcr-disabled-silently
type: pattern
title: An OAuth MCP server's verify passes on a static token while interactive clients cannot register
updated: 2026-11-01
status: confirmed
kind: failure
class: capability-regression
atRisk: interactive MCP clients onboarding via OAuth Dynamic Client Registration
probed: an authenticated tools/list using a pre-issued machine token
cells: ["mcp/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@6c50cb82cf0f199e1f344599b1ac2e380f3c651e
catches:
  description: assert the authorization-server metadata advertises registration_endpoint AND an empty POST to it answers 400 (not 404)
  checkSignature: "oauth-authorization-server|register"
remediation:
  - { outlet: verify, ref: "verify/bamcp.config.ts", verified: true }
skills: [deploy-verify-promote]
---
## Symptom
An OAuth MCP server's gate stayed green while interactive MCP connectors could no longer connect.

## Root cause
Dynamic Client Registration was disabled. Verify authenticated with a static machine token, which
never exercises the path an interactive client takes to register.

## Fix / workaround
Re-enable DCR. Verify the onboarding path itself: the metadata advertises `registration_endpoint`,
the endpoint answers an empty registration with 400, and RFC 9728 protected-resource metadata is
served.

## How it is caught
The server's api checks fail if DCR is not advertised or answers 404.
```

### 2.13 `patterns/unplanned-compute-replacement.md`

```markdown
---
id: pattern/unplanned-compute-replacement
type: pattern
title: A Terraform apply that replaces running compute without anyone planning it
updated: 2026-11-01
status: confirmed
kind: failure
class: iac-hazard
atRisk: running containers and databases (state, uptime, free-tier allocation)
probed: n/a — apply ran unattended on push
cells: ["*/oci/*", "*/*/neon", "*/*/supabase"]
affects: "<0.10.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - pr:RTrentJones/greenlight#27
  - commit:RTrentJones/greenlight@7cdecab738968fa5818cb934e04ff7c213b2613a
catches:
  description: infra.yml fails a plan that destroys or replaces guarded resource types unless a human approves
remediation:
  - { outlet: mechanism, ref: "greenlight@0.10.0", verified: true }
skills: [provider-hcp, provider-oci, provider-neon]
---
## Symptom
A routine infra change could plan a destroy-and-recreate of running compute, and apply-on-push
would execute it.

## Root cause
Some attribute changes force replacement. Unattended apply had no step at which a human saw that a
plan contained a destroy.

## Fix / workaround
`infra.yml` runs plan, then a destroy guard over the saved plan, then manual approval, then apply.
This covers guarded resource types such as container instances and Neon branches and endpoints.
Run state surgery (`state rm`) as one atomic step that fails loudly.

## How it is caught
The destroy guard fails the workflow on any unplanned replacement of a guarded type.
```

### 2.14 `patterns/spec-typo-disables-assertion.md`

```markdown
---
id: pattern/spec-typo-disables-assertion
type: pattern
title: A typo or unknown field in a verify spec silently disables an assertion
updated: 2026-11-01
status: confirmed
kind: failure
class: spec-validity
atRisk: the behavior the assertion was written to guard
probed: nothing — the misspelled field was ignored and the check passed
cells: ["*/*/*"]
affects: "<0.6.0"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - commit:RTrentJones/greenlight@baae67534d2686116abfa8a7c40733c221755efd
catches:
  description: every spec is validated strictly before running; unknown, wrong-typed or out-of-range fields fail the gate
  checkSignature: "spec is valid"
remediation:
  - { outlet: mechanism, ref: "packages/verify/src/validate.ts", verified: true }
skills: [deploy-verify-promote, greenlight-build]
---
## Symptom
A check written to assert something passed even when that something was broken.

## Root cause
The harness ignored fields it did not recognize, so a misspelling (or a field from a newer version)
turned an assertion into a no-op while the gate read green.

## Fix / workaround
Strict specs: an unknown, wrong-typed or uncompilable field fails as `spec is valid — checks[i]:
unsupported field "…"`. Eleven follow-up fixes closed related gaps (non-negative budgets, integer
counts, own-property paths, future timestamps).

## How it is caught
Validation runs before any network call. Machine-written wiki artifacts follow the same rule (08).
```

### 2.15 `patterns/alert-suppressed-by-open-issue.md`

```markdown
---
id: pattern/alert-suppressed-by-open-issue
type: pattern
title: One open keepalive issue suppresses alerts for every other target
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: alert-suppression
atRisk: alerting for every keepalive target other than the one already failing
probed: the existence of any open keepalive issue
cells: ["*/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: with one target's issue open, a second target's failure still produces a new alert
  graderTask: replay/alert-per-target
remediation: []
skills: [provider-github]
---
## Symptom
While one target's keepalive issue stayed open, a failure on any other target could not have opened
a new alert.

## Root cause
The alert sink de-duplicates on any open keepalive issue rather than on an issue per target.

## Fix / workaround
De-duplicate per target, or comment on the existing issue naming the new target. Close an issue
only after verifying the deployed artifact.

## How it is caught
Not caught yet. This page stays `hypothesis` until a per-target alert replay passes.
```

### 2.16 `patterns/gemini-overload-fallback.md`

```markdown
---
id: pattern/gemini-overload-fallback
type: pattern
title: Free-tier Gemini overloads and model rotation stall a cron agent
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: free-tier-physics
atRisk: the agent's scheduled run producing output
probed: n/a — the cron fired, and the model call failed
cells: ["agent/workers/*"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - pr:RTrentJones/greenlight#25
  - pr:RTrentJones/greenlight#26
catches:
  description: lastRun freshness plus lastError == null on /status; a forced overload in a replay recovers via the fallback model
  checkSignature: "lastRun|lastError"
remediation:
  - { outlet: template, ref: "tools/_template-agent (retry + second model)", verified: false }
skills: [provider-gemini]
---
## Symptom
The agent's daily run failed on transient overload errors, or once its default model was retired.

## Root cause
The free tier returns transient overloads under load, and default model names rotate. A single
attempt against one model has no slack.

## Fix / workaround
Retry transient errors with backoff, and fall back to a second model when the first stays
overloaded. Keep the model ids in configuration so they can be rotated without a code change.

## How it is caught
The agent's verify spec asserts `lastRun` within 26 hours and `lastError: null`, so a stalled cron
fails the gate.
```

### 2.17 `patterns/fix-merged-not-running.md`

```markdown
---
id: pattern/fix-merged-not-running
type: pattern
title: A merged fix that is not what is running
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: artifact-identity
atRisk: the behavior the fix was meant to restore
probed: the repository and the release notes, not the deployed artifact
cells: ["*/*/*"]
affects: "*"          # framework versions that carry the defect
relevance: both
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
catches:
  description: compare the deployed artifact with the release that contains the fix — /__version sha, or a hash of the deployed Worker script against the published build — and check the deployed config names the new setting
  checkSignature: "identity|__version"
remediation:
  - { outlet: mechanism, ref: "greenlight@0.8.0 (ship --expect-sha)", verified: false }
  - { outlet: doctor, ref: "DR-33", verified: false }
skills: [deploy-verify-promote, greenlight-portfolio]
---
## Symptom
A keepalive probe-table setting was committed, and the database paused about two weeks later
anyway.

## Root cause
The deployed keepalive Worker was still the 0.8 build, which ignored the new setting. The fix sat
in the repo, inert, while every signal the operator looked at said it was in place.

## Fix / workaround
Treat "fixed" as a claim about the deployed artifact. After shipping a fix, check identity: for an
app, `/__version` equals the release; for a Worker, the deployed script's hash equals the published
build. Then check that the deployed configuration carries the new setting.

## How it is caught
SHA-gated ship covers tools that serve `/__version`. Frameworks deployed outside `ship`, such as the
keepalive Worker, need the hash comparison. A pattern moves to `confirmed` only after this check
(04 §4).
```

### 2.18 `patterns/preview-prod-path-drift.md`

```markdown
---
id: pattern/preview-prod-path-drift
type: pattern
title: Preview and prod serve the app under different base paths
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: env-drift
atRisk: the local gate's ability to predict prod
probed: a preview whose paths resolve differently from prod's
cells: ["mcp/oci/*", "mcp/docker/*"]
affects: "*"          # framework versions that carry the defect
relevance: both
evidence:
  - commit:RTrentJones/RTrentJones.dev@TODO   # "fix(polyphony): preview base /mcp, so local paths match prod"
  - commit:RTrentJones/RTrentJones.dev@TODO   # "fix(tracer): keep data-dependent verify checks prod-only"
catches:
  description: the same verify config, with relative paths, passes in preview and prod; env-specific checks are explicit ctx branches (C7)
remediation:
  - { outlet: verify, ref: "verify/polyphony.config.ts", verified: false }
  - { outlet: doctor, ref: "DR-26", verified: false }
skills: [deploy-verify-promote, greenlight-build]
---
## Symptom
A container tool's verify checks resolved to different routes under `greenlight preview` than in
prod. Another tool's data-dependent checks failed in envs that never receive scheduled data.

## Root cause
The mcp lane appends `/mcp` to the prod base. The preview served from `/`, so relative paths
differed. Separately, some checks were true only where scheduled ingest runs.

## Fix / workaround
Give the preview the same base path as prod (`preview.path: '/mcp'`), and have the app alias its
routes under it. Mark checks that depend on the env as explicit `ctx.env` / `ctx.preview` branches,
and keep everything else env-invariant.

## How it is caught
One function-form config runs in both envs. DR-26 flags branches with no invariant checks.
```

### 2.19 `patterns/supabase-pause.md`

```markdown
---
id: pattern/supabase-pause
type: pattern
title: A free-tier Supabase project pauses after a week without database activity
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: free-tier-physics
atRisk: the whole app behind the paused project
probed: n/a — physics of the free tier
cells: ["*/*/supabase"]
affects: "*"          # framework versions that carry the defect
relevance: app-code
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - commit:RTrentJones/greenlight@c97222a07dc82904193ed241f266cb6a15cce29e
catches:
  description: a needs-traffic tool has a keepalive whose probe is a real query, run more often than the idle limit
remediation:
  - { outlet: mechanism, ref: "packages/keepalive (probeTable required)", verified: false }
  - { outlet: doctor, ref: "DR-22", verified: false }
skills: [provider-supabase, greenlight-kickoff]
---
## Symptom
A paused project answers 530, and the app is down until someone restores it.

## Root cause
Supabase measures idleness at the database. A free project with no database activity for a week
is paused. HTTP traffic that never reaches Postgres does not count
(pattern/keepalive-probe-misses-postgres).

## Fix / workaround
Prefer Neon unless auth, storage and realtime are all needed together
(decision/neon-default-over-supabase). With Supabase, declare `liveness.model: needs-traffic` and a
keepalive target with `probeTable`. The cron interval must be well inside the idle limit; the
keepalive runs every three days.

## How it is caught
DR-22 fails a needs-traffic tool with no keepalive target. A 530 from the probe opens an alert.
```

### 2.20 `patterns/neon-state-rm.md`

```markdown
---
id: pattern/neon-state-rm
type: pattern
title: Forgetting a Neon branch in Terraform state partially, or silently
updated: 2026-11-01
status: hypothesis     # needs red→green evidence on a deployed artifact (LR-05); input to the cycle
kind: failure
class: iac-hazard
atRisk: consistency between Terraform state and the real Neon branch and endpoint
probed: a state edit that succeeded for one resource and not the other
cells: ["*/*/neon"]
affects: "*"          # framework versions that carry the defect
relevance: framework-version
evidence:
  - commit:RTrentJones/RTrentJones.dev@aa9fb485e653487683de761fbab4b173468f241b
  - commit:RTrentJones/RTrentJones.dev@47be1c3e20abcec507401285c6fff6e4504d7c83
catches:
  description: the recovery step removes the branch and its endpoint in one `terraform state rm` and fails the job on any error
remediation:
  - { outlet: mechanism, ref: "commit:RTrentJones/RTrentJones.dev@aa9fb485e653487683de761fbab4b173468f241b", verified: false }
skills: [provider-neon, provider-hcp]
---
## Symptom
After a Neon branch was deleted outside Terraform, recovery left state referring to an endpoint
whose branch was gone, and later plans failed or tried to recreate the wrong thing.

## Root cause
The branch and its endpoint were removed from state in separate steps, and a failure in one was not
fatal. State and reality diverged quietly.

## Fix / workaround
Forget the branch and endpoint in one `state rm` call, and fail loudly on any error. The manual
recovery path for a branch deleted outside Terraform is documented in infra.

## How it is caught
The recovery job exits non-zero on a partial state edit. The destroy guard
(pattern/unplanned-compute-replacement) covers the apply that follows.
```

## 3. Framework decisions

Each decision page is 20 lines or fewer.

### 3.1 `decisions/blog-never-pausing-store.md`

```markdown
---
id: decision/blog-never-pausing-store
type: decision
title: The blog never uses a store that pauses
updated: 2026-11-01
status: confirmed
decided: 2026-05-01   # TODO: date of greenlight-v1 §9
scope: [blog]
skills: [greenlight-kickoff, greenlight-build]   # back-links required by LR-11
---
The blog must stay up unattended, so its `data` is `none`, `d1` or `kv`, or an external service
(giscus, Resend). Supabase pauses after a week idle, and the blog schema makes it unrepresentable
(`BlogSchema` in `packages/shared/src/schema.ts`). Agents MUST NOT propose a pausing store for the
blog.
```

### 3.2 `decisions/oci-direct-to-prod.md`

```markdown
---
id: decision/oci-direct-to-prod
type: decision
title: OCI tools ship directly to prod; the local gate is mandatory
updated: 2026-11-01
status: confirmed
decided: 2026-06-01   # TODO: confirm from greenlight-v2 §6
scope: ["*/oci/*"]
skills: [deploy-verify-promote, provider-oci]   # back-links required by LR-11
---
The OCI free tier has no room for a standing beta. `mcp/oci` tools therefore have no beta, and the
pre-prod safety is `greenlight preview` (docker, matching prod's `/mcp` contract) plus the
SHA-gated ship-gate. "Direct to prod" means *no beta*. It does not mean that a push deploys: the
prod deploy of an image digest still requires the owner's approval of that artifact through the
protected prod path (18-release-authority). Self-heal may only redeploy the last approved digest.
An agent MUST run the local gate before asking for that approval.
```

### 3.3 `decisions/neon-default-over-supabase.md`

```markdown
---
id: decision/neon-default-over-supabase
type: decision
title: Neon is the default Postgres; Supabase only for bundled auth, storage and realtime
updated: 2026-11-01
status: confirmed
decided: 2026-07-01   # TODO: date of v0.2.25
scope: ["*/*/neon", "*/*/supabase"]
skills: [greenlight-kickoff, provider-neon, provider-supabase]   # back-links required by LR-11
---
Neon gives branch-per-env Postgres that scales to zero and resumes automatically, so it needs no
keepalive. Its liveness model is `needs-silence`: idle traffic is the failure. Choose Supabase only
when auth, storage and realtime are all needed together, and accept the `needs-traffic` keepalive
it requires.
```

### 3.4 `decisions/github-single-secret-store.md`

```markdown
---
id: decision/github-single-secret-store
type: decision
title: GitHub Actions secrets are the single secret store
updated: 2026-11-01
status: confirmed          # becomes superseded when M5 ships the readable source
supersededBy: null         # set to decision/one-readable-secret-source when M5 ships
decided: 2026-07-01        # TODO: date of v0.4.0
scope: ["*"]
skills: [provider-github]   # back-links required by LR-11
---
Tokens are gathered with hidden input and pushed straight to GitHub Actions secrets. No local
secret file exists. This holds until M5, which introduces a readable source that syncs to Actions
(ADR-06). The `--sink github` mode preserves this decision for owners who opt out.
```

### 3.5 `decisions/lockstep-versioning.md`

```markdown
---
id: decision/lockstep-versioning
type: decision
title: The npm version, MODULE_REF, framework wiki and skills move in lockstep
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-wiki]   # back-links required by LR-11
---
`scripts/release.mjs` bumps the npm version and `MODULE_REF` together. From M1 on, the framework
wiki and skills ship in the same package (ADR-04). A consumer therefore never runs CLI logic, infra
modules, skills or patterns from different versions. An infra-only or wiki-only fix still cuts a
patch release.
```

### 3.6 `decisions/promotion-is-human.md`

```markdown
---
id: decision/promotion-is-human
type: decision
title: Promotion to prod is the owner's decision
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [deploy-verify-promote, greenlight-portfolio]   # back-links required by LR-11
---
An agent may prepare a release by verifying beta at a pinned sha and showing the evidence. It
cannot release. Every channel that mutates prod (promotion, provider deploys, infra apply,
migrations, recovery) runs only under a protected execution identity, and only for an artifact the
owner approved (18-release-authority). `promotion: 'auto-on-green'` is allowed only for public tools
whose store does not pause and holds no user data (ADR-07), and changing that policy is itself an
owner-reviewed change (DR-32).
```

### 3.7 `decisions/no-domain-mode.md`

```markdown
---
id: decision/no-domain-mode
type: decision
title: A portfolio can run without a custom domain
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*/workers/*", "*/vercel/*"]
skills: [greenlight-kickoff, provider-cloudflare]   # back-links required by LR-11
---
Without `domain`, workers tools serve at their account's workers.dev subdomain. Beta is a separate
`<name>-beta` Worker in the beta account. Vercel tools serve at their `vercel.app` aliases, and oci
and docker tools need a domain. Beta is public unless Cloudflare Access is enabled on the beta
Worker's workers.dev route. Version preview URLs are disabled (`preview_urls: false`), so they
cannot bypass that protection (09 §6.6, ADR-09).
```

### 3.8 `decisions/retire-through-destroy-guard.md`

```markdown
---
id: decision/retire-through-destroy-guard
type: decision
title: Retiring a tool uses a plan-bound deletion authorization; the general destroy guard stays
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-portfolio]   # back-links required by LR-11
---
The generated plan guard *fails* any plan that deletes a stateful store, before approval is
reached, and approval cannot resume a failed job. Retirement therefore never removes or weakens
that guard. Instead, `retire` records the following, and the guard admits exactly those addresses
and nothing else:
- an inventory of the tool's resources, including Wrangler-managed and adopted ones;
- a data-disposition choice;
- a deletion authorization bound to the exact planned resource addresses and plan hash, approved
  by the owner.

Shared stores are refused. The tool is `retiring` until each inventoried resource has an explicit
outcome, then `retired` (10, 18).
```

### 3.9 `decisions/wiki-never-rolls-back.md`

```markdown
---
id: decision/wiki-never-rolls-back
type: decision
title: Skill changes roll back; the wiki does not
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-wiki]   # back-links required by LR-11
---
This follows the paper: a rejected proposal reverts the skill, never the wiki. Knowledge learned
from the failed attempt stays. A wrong page is retired by `status: superseded` plus `supersededBy`,
or by archival, and never by deletion or history rewrite. The ledger records rejected proposals, so
the proposer does not repeat them.
```

### 3.10 `decisions/incidents-hidden.md`

```markdown
---
id: decision/incidents-hidden
type: decision
title: Building agents never receive incident pages or unconfirmed patterns
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-wiki, deploy-verify-promote]   # back-links required by LR-11
---
Skills give building agents intent, liveness, decisions, facts and contract pages. After a gate
fails, they also get `confirmed` patterns through `wiki lookup`. Incidents (long narratives) and
`hypothesis` patterns are for the maintainer and humans only. Bench rollouts get no lookup at all.
This is grounded in the paper's ablation (ADR-10).
```

### 3.11 `decisions/one-readable-secret-source.md`

```markdown
---
id: decision/one-readable-secret-source
type: decision
title: One readable secret source; CI, runtime and agents are its consumers
updated: 2026-11-01
status: hypothesis   # becomes confirmed when M5 ships
decided: 2026-11-01
scope: ["*"]
skills: [greenlight-kickoff, provider-github]   # back-links required by LR-11
---
Infisical holds every secret and syncs to GitHub Actions, so CI is unchanged. Terraform projects
values into runtime stores. Agents run behind a credential-injecting proxy and hold placeholders
only. `--sink github` keeps the GitHub-only model for owners who want no new account (ADR-06).
Supersedes decision/github-single-secret-store.
```

### 3.12 `decisions/ci-only-tokens.md`

```markdown
---
id: decision/ci-only-tokens
type: decision
title: Credentials that cannot be injected over HTTP stay CI-only
updated: 2026-11-01
status: confirmed
decided: 2026-11-01
scope: ["*/oci/*", "*/docker/*"]
skills: [provider-oci, provider-docker, provider-github]   # back-links required by LR-11
---
OCI keys sign the whole request, so a header swap cannot produce the signature. Docker targets use
SSH, which is not HTTP. `GREENLIGHT_DISPATCH_TOKEN` lives in tool repos. None of these has an
`inject` spec, so agents never use them. Work that needs them runs in CI (`ship`, `remediate`).
DR-30 lists them so the boundary is visible.
```

## 4. Contract pages (short form)

Each page has `type: contract`, `status: confirmed`, and `lanes` and `enforcedBy` as shown. Every
body is 30 lines or fewer, and the full normative text is in 09.

Each contract page also carries `skills: [...]`, the skills whose `PURPOSE.md` cites it, as LR-11
requires for every cited page.

| file | clause | lanes | body summary | enforcedBy | skills |
|---|---|---|---|---|---|
| `contract/c1-identity.md` | C1 | `*` | serve the build sha at `/__version` (`{sha, builtAt?}`); specs set `requireIdentity: true` on deployed envs | template (M4 astro, M6 other lanes), DR-24, mechanism (`ship --expect-sha`) | greenlight-build, deploy-verify-promote |
| `contract/c2-live-vs-ready.md` | C2 | `*` | `/health/live` never touches a store; `/health` reports each dependency as JSON | template, DR-21 | greenlight-build, provider-neon, provider-supabase, provider-oci |
| `contract/c3-guarded-writes.md` | C3 | `*` | every write route has an unauthenticated-rejection check (`method: POST`, `status: 401`) | verify, skill (greenlight-build) | greenlight-build |
| `contract/c4-freshness-per-producer.md` | C4 | `*` | every cron or feed exposes last success per producer; one `maxAgeHours` per producer | DR-25, verify | greenlight-build, provider-gemini |
| `contract/c5-recorded-success.md` | C5 | `*` | `ok` is set only after a recorded successful attempt; expose `lastError` | template (agent), verify | greenlight-build, provider-gemini |
| `contract/c6-zero-idle-cost.md` | C6 | `*` | no timer touches a scale-to-zero store while idle; wake on demand | skill, DR-21, replay | greenlight-build, provider-neon |
| `contract/c7-env-invariant.md` | C7 | `*` | checks that hold in every env are listed in the config's named `meta.invariant` export; env-specific ones are explicit branches on `ctx.env`/`ctx.preview` | DR-26, template | greenlight-build, deploy-verify-promote |

## 5. Fact page skeletons

The values are deliberately left empty. A seeder fills each one from the provider's current pricing
or limits page, records the URLs in `source`, and sets `verified`. **No number may be committed
without a source URL** (LR-17 expires them after 90 days).

```markdown
---
id: fact/<provider>-<tier>
type: fact
title: <Provider> <tier> — limits and idle behavior
updated: <date>
status: confirmed
provider: <provider-pack id>
verified: <date>
source: [<pricing/limits URL>, ...]
cardRequired: <bool>
idle: <pauses | scales-to-zero | reclaimed | unaffected>
quotas:
  - { key: <key>, label: <label>, limit: <n>, unit: <unit>, scope: <scope>, usage: { kind: <kind>, ref: <fn id> } }
---
## What idleness does
## Limits that bite first
## How to see current usage
## Upgrade path and cost
```

| page | provider | expected `idle` | quotas to fill (keys) | notes for the seeder |
|---|---|---|---|---|
| `facts/cloudflare-workers-free.md` | cloudflare | unaffected | `requests`, `cpu-ms`, `cron-triggers`, `workers` | account-scoped; check the Workers plan limits page |
| `facts/cloudflare-d1-free.md` | cloudflare | unaffected | `rows-read`, `rows-written`, `storage` | daily vs monthly scope |
| `facts/cloudflare-kv-free.md` | cloudflare | unaffected | `reads`, `writes`, `storage` | writes are the tight limit |
| `facts/neon-free.md` | neon | scales-to-zero | `compute-hours`, `storage`, `projects`, `branches` | record the suspend delay and per-project vs account scope |
| `facts/supabase-free.md` | supabase | pauses | `projects`, `db-size`, `idle-days` | the pause trigger is database inactivity |
| `facts/vercel-hobby.md` | vercel | unaffected | `deployments`, `function-invocations`, `bandwidth` | Hobby is non-commercial |
| `facts/gemini-free.md` | gemini | unaffected | `rpm`, `rpd` per model | per-model limits; record the current default model |
| `facts/hcp-terraform-free.md` | hcp | unaffected | `managed-resources`, `users` | local execution mode |
| `facts/github-actions-free.md` | github | unaffected | `minutes` (private repos), `storage` | public repos differ |
| `facts/oci-always-free.md` | oci | reclaimed | `a1-ocpus`, `a1-memory`, `container-instances` | `cardRequired: true`; record the idle-reclaim policy |
| `facts/infisical-free.md` | infisical (M5) | unaffected | `identities`, `projects` | **record whether Agent Proxy is included** (Q3) |

## 6. Project wiki for the six live tools (wrapper)

Proposed check ids are given in square brackets after each criterion. Verify `id` support lands in
M0 (08 §6), so M1 seeding adds these `id`s to the wrapper's verify configs in the same change that
writes the intent pages. LR-15 is therefore satisfiable from the first seeded page.

### 6.1 `wiki/tools/blog/intent.md` and `liveness.md`

```markdown
---
id: intent/blog
type: intent
title: Blog — intent
updated: 2026-11-01
status: confirmed
tool: blog
criteria:
  - { id: AC-1, text: "Every published page and post serves", source: incident, added: 2026-11-01, checks: [pages-serve, posts-serve] }
  - { id: AC-2, text: "Share previews work: og.png serves as PNG and every page's meta points at it", source: incident, added: 2026-11-01, checks: [og-meta, og-png] }
  - { id: AC-3, text: "RSS and sitemap parse; no internal link is broken", source: kickoff, added: 2026-11-01, checks: [rss-valid, sitemap-valid, no-broken-links] }
  - { id: AC-4, text: "Unknown paths get the custom 404 page with a 404 status", source: kickoff, added: 2026-11-01, checks: [custom-404] }
  - { id: AC-5, text: "security.txt serves with a Contact and an Expires at least 30 days out", source: incident, added: 2026-11-01, checks: [security-txt] }
  - { id: AC-6, text: "Prod is rebuilt daily so pg_kafka evidence stays current (builtAt < 30h)", source: kickoff, added: 2026-11-01, checks: [prod-daily-rebuild] }
  - { id: AC-7, text: "The deployed artifact is the shipped commit", source: kickoff, added: 2026-11-01, checks: [identity] }
---
The personal site at the apex domain: posts and project pages. Content-only, so it must stay up
unattended and never depend on a store that pauses (decision/blog-never-pausing-store).
```

```markdown
---
id: liveness/blog
type: liveness
title: Blog — liveness
updated: 2026-11-01
status: confirmed
tool: blog
model: always-on
atRisk: nothing idles — static assets on Workers
quotas: [fact/cloudflare-workers-free#requests]
---
Workers Static Assets serve without a store. No keepalive is needed. The daily prod rebuild
(deploy.yml, 13:00 UTC) is a freshness requirement, not a liveness one, and AC-6 covers it.
```

### 6.2 `wiki/tools/heistmind/…`

```markdown
---
id: intent/heistmind
type: intent
title: HeistMind — intent
updated: 2026-11-01
status: confirmed
tool: heistmind
criteria:
  - { id: AC-1, text: "/ renders the real app shell, not a Vercel error or a stale placeholder", source: kickoff, added: 2026-11-01, checks: [app-shell] }
  - { id: AC-2, text: "The privacy and terms pages stay reachable, even behind the prod holding page", source: kickoff, added: 2026-11-01, checks: [legal-privacy, legal-terms] }
  - { id: AC-3, text: "The Discord interactions endpoint has its public key configured (unsigned POST → 401, not 503)", source: incident, added: 2026-11-01, checks: [discord-key-configured] }
  - { id: AC-4, text: "The deployed artifact is the shipped commit", source: kickoff, added: 2026-11-01, checks: [identity] }
---
A Next.js app on Vercel with Supabase and Discord OAuth. Prod serves a coming-soon holding page, and
beta serves the full app. The deep gate (an authenticated Playwright suite) lives in the tool repo's
`greenlight-verify.yml`. These criteria cover the surface both envs share.
```

```markdown
---
id: liveness/heistmind
type: liveness
title: HeistMind — liveness
updated: 2026-11-01
status: confirmed
tool: heistmind
model: needs-traffic
atRisk: Supabase free-tier idle timer (database activity)
probe: /rest/v1/keepalive_probe?select=id&limit=1
quotas: [fact/supabase-free#projects, fact/vercel-hobby#function-invocations]
---
The keepalive must run a real query (pattern/keepalive-probe-misses-postgres). The probe table is the
one-row `keepalive_probe`, because `profiles` was closed to anonymous reads. Verify the deployed
keepalive Worker after any Greenlight upgrade (incident/2026-08-keepalive-green-database-paused).
```

### 6.3 `wiki/tools/bamcp/…`

```markdown
---
id: intent/bamcp
type: intent
title: BAMCP — intent
updated: 2026-11-01
status: confirmed
tool: bamcp
criteria:
  - { id: AC-1, text: "The server is up and OAuth is enforced (unauthenticated /mcp → 401)", source: kickoff, added: 2026-11-01, checks: [oauth-enforced] }
  - { id: AC-2, text: "Interactive MCP clients such as claude.ai's connector can register via DCR", source: incident, added: 2026-11-01, checks: [dcr-advertised, dcr-live] }
  - { id: AC-3, text: "Clients can discover the authorization server (RFC 9728 metadata)", source: kickoff, added: 2026-11-01, checks: [protected-resource-metadata] }
  - { id: AC-4, text: "The tool list is exactly the declared set", source: kickoff, added: 2026-11-01, checks: [exact-tools] }
  - { id: AC-5, text: "A real tool computes a real answer, and egress to NCBI works (search_gene BRCA1)", source: kickoff, added: 2026-11-01, checks: [search-gene-brca1] }
  - { id: AC-6, text: "The newcomer demo path works: demo:HG002 resolves and its build is detected", source: kickoff, added: 2026-11-01, checks: [demo-hg002] }
  - { id: AC-7, text: "The deployed image is the shipped commit", source: kickoff, added: 2026-11-01, checks: [identity] }
---
A stateful MCP server for genomic BAM inspection on a free-tier OCI A1 container, direct-to-prod
(decision/oci-direct-to-prod). Preview runs with auth off, so AC-1 to AC-3 are prod-only, and AC-4
is environment-invariant.
```

```markdown
---
id: liveness/bamcp
type: liveness
title: BAMCP — liveness
updated: 2026-11-01
status: confirmed
tool: bamcp
model: needs-heal
atRisk: the OCI container instance (idle reclaim or death)
probe: /mcp/health/live   # TODO: confirm BAMCP serves this; today the keepalive probes "/"
quotas: [fact/oci-always-free#a1-ocpus, fact/oci-always-free#a1-memory]
---
Keepalive probes the app, never anything deeper. On failure, `greenlight-remediate-bamcp.yml`
re-applies infra and redeploys the last owner-approved image digest, never a newer unapproved
build (18-release-authority). Never imply the harness prevents reclaim; it detects and heals.
```

### 6.4 `wiki/tools/tracer/…`

```markdown
---
id: intent/tracer
type: intent
title: Tracer — intent
updated: 2026-11-01
status: confirmed
tool: tracer
criteria:
  - { id: AC-1, text: "The dashboard reads Neon: health ok with at least one run", source: kickoff, added: 2026-11-01, checks: [health-db] }
  - { id: AC-2, text: "Each daily feed is flowing on its own (dogfood ≤ 50h, pg_kafka benchmark ≤ 216h) — prod only", source: incident, added: 2026-11-01, checks: [feed-dogfood, feed-pg-kafka] }
  - { id: AC-3, text: "Overview, runs, compare and project pages render after live queries", source: kickoff, added: 2026-11-01, checks: [overview, runs, compare, project-tracer] }
  - { id: AC-4, text: "Public summary and badge serve", source: kickoff, added: 2026-11-01, checks: [summary, badge] }
  - { id: AC-5, text: "Anonymous visitors cannot write runs or spend provider tokens (ingest and run → 401)", source: kickoff, added: 2026-11-01, checks: [ingest-guard, run-guard] }
  - { id: AC-6, text: "Unknown projects 404; write routes are POST-only (GET → 405)", source: kickoff, added: 2026-11-01, checks: [unknown-project-404, ingest-get-405] }
  - { id: AC-7, text: "The deployed artifact is the shipped commit", source: kickoff, added: 2026-11-01, checks: [identity] }
---
The eval-run store and dashboard for Greenlight's verify exports. It is also the optional raw-layer
store for the wiki (ADR-08). Data-dependent checks are prod-only, because beta gets no scheduled
ingest.
```

```markdown
---
id: liveness/tracer
type: liveness
title: Tracer — liveness
updated: 2026-11-01
status: confirmed
tool: tracer
model: needs-silence
atRisk: Neon compute allowance (the compute must suspend when idle)
quotas: [fact/neon-free#compute-hours, fact/vercel-hobby#function-invocations]
---
No keepalive. Nothing may poll the database while the dashboard is idle
(pattern/neon-never-sleeps). Only page views, ingest and verify should wake it.
```

### 6.5 `wiki/tools/muse/…`

```markdown
---
id: intent/muse
type: intent
title: Muse — intent
updated: 2026-11-01
status: confirmed
tool: muse
criteria:
  - { id: AC-1, text: "There is output and the latest attempt did not fail", source: incident, added: 2026-11-01, checks: [status-ok, no-last-error] }
  - { id: AC-2, text: "The daily cron is still running (lastRun ≤ 26h)", source: incident, added: 2026-11-01, checks: [last-run-fresh] }
  - { id: AC-3, text: "The deployed Worker is the shipped commit", source: kickoff, added: 2026-11-01, checks: [identity] }
---
A cron-triggered Gemini agent on Workers, with KV holding its last output. Deploy seeds one run
(`POST /run`) before verify.
```

```markdown
---
id: liveness/muse
type: liveness
title: Muse — liveness
updated: 2026-11-01
status: confirmed
tool: muse
model: always-on
atRisk: the Gemini call on each cron run (overload, model retirement)
quotas: [fact/cloudflare-workers-free#cron-triggers, fact/cloudflare-kv-free#writes, fact/gemini-free#rpd]
---
Workers and KV do not idle out. The risk is the scheduled work silently failing, which AC-1 and AC-2
cover (pattern/gemini-overload-fallback, pattern/ok-before-success).
```

### 6.6 `wiki/tools/polyphony/…`

```markdown
---
id: intent/polyphony
type: intent
title: Polyphony — intent
updated: 2026-11-01
status: confirmed
tool: polyphony
criteria:
  - { id: AC-1, text: "The app is up behind the /mcp base", source: kickoff, added: 2026-11-01, checks: [app-up] }
  - { id: AC-2, text: "Every dependency is healthy: database and vector search", source: kickoff, added: 2026-11-01, checks: [health-deps] }
  - { id: AC-3, text: "The store-free liveness route stays up (keepalive depends on it)", source: incident, added: 2026-11-01, checks: [health-live] }
  - { id: AC-4, text: "The frontend and the Usage page serve", source: kickoff, added: 2026-11-01, checks: [frontend, usage-page] }
  - { id: AC-5, text: "Every API route is JWT-gated (sources, scenes, books, me, jobs, usage, characters → 401)", source: kickoff, added: 2026-11-01, checks: [api-guards] }
  - { id: AC-6, text: "The deployed image is the shipped commit", source: kickoff, added: 2026-11-01, checks: [identity] }
---
A multi-user AI book-writing platform: FastAPI plus a static Next frontend in one container, on OCI.
Registration is invite-gated in the app.
```

```markdown
---
id: liveness/polyphony
type: liveness
title: Polyphony — liveness
updated: 2026-11-01
status: confirmed
tool: polyphony
model: needs-heal
atRisk: the OCI container (reclaim or death); separately, Neon must stay silent while idle
probe: /mcp/health/live
quotas: [fact/oci-always-free#a1-ocpus, fact/neon-free#compute-hours, fact/gemini-free#rpd]
---
Two risks pull in opposite directions. The container needs a heal probe, which is `/health/live`
and never touches the database. The Neon database needs silence (pattern/neon-never-sleeps).
Workers wake on enqueue, and the reaper runs only while jobs run. Only verify at deploy time calls
`/health`.
```

```markdown
---
id: tool-decisions/polyphony
type: tool-decisions
title: Polyphony — decisions
updated: 2026-11-01
status: confirmed
tool: polyphony
---
## 2026-?? — lane `mcp` to reach the `oci` target  <!-- TODO: date of the adopt commit -->
Polyphony is not an MCP server. The matrix allows `oci` only for the `mcp` lane, so the manifest
declares `mcp`. Its verify spec uses `api` mode. The app aliases `/mcp`, `/mcp/health` and
`/mcp/__version`, so relative paths resolve the same way in preview and prod.

## 2026-?? — Neon wired directly in infra; `data: none` in the manifest
The `mcp` lane allows only `data: none`, so the Neon project is instantiated in
`infra/polyphony.tf`, and the plan guard covers `neon_*` destroys. DR-21 must treat this tool as
having a scale-to-zero store, through `liveness.quotas` naming `fact/neon-free`.

## 2026-?? — vector search moved to pgvector in Neon (Qdrant Cloud dropped)
```

## 7. Incidents

### 7.1 `wiki/incidents/2026-08-keepalive-green-database-paused.md` (wrapper)

```markdown
---
id: incident/2026-08-keepalive-green-database-paused
type: incident
title: The keepalive was green, and HeistMind's database paused anyway
updated: 2026-11-01
status: confirmed
tool: heistmind
opened: 2026-08-16
evidence:
  - issue:RTrentJones/RTrentJones.dev#55
  - issue:RTrentJones/RTrentJones.dev#86
  - pr:RTrentJones/greenlight#28
  - pr:RTrentJones/RTrentJones.dev#90
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
patterns:
  - pattern/keepalive-probe-misses-postgres
  - pattern/caret-zero-major
  - pattern/workers-fetch-cache-conflict
  - pattern/alert-suppressed-by-open-issue
timeline:
  - { date: 2026-07-31, text: "probeTable added to the config; inert on the deployed 0.8 Worker" }
  - { date: 2026-08-16, text: "database pauses; next sweep gets a 530 and opens an issue", evidence: "issue:RTrentJones/RTrentJones.dev#55" }
  - { date: 2026-08-24, text: "0.9.0 deployed after an explicit upgrade (^0.8.0 blocked it); probe reaches Postgres; Worker verified by SHA-256 against the release" }
  - { date: 2026-10-10, text: "upgrade to 0.10.0" }
  - { date: 2026-10-13, text: "every sweep throws before the probe is sent; issue opened", evidence: "issue:RTrentJones/RTrentJones.dev#86" }
  - { date: 2026-10-17, text: "Worker fix merged upstream; probe-table move to keepalive_probe opened", evidence: "pr:RTrentJones/greenlight#28" }
  - { date: 2026-10-30, text: "database up, but not because of the keepalive; fix awaiting release (0.10.1)" }
---
Three different causes produced one symptom. The issue was closed in August only after three direct
checks:

- the probe table returned a real row anonymously;
- the deployed Worker was byte-identical to the release;
- the deployed configuration named the table.

Lesson for every skill: verify the deployed artifact, not the pipeline's report that it deployed,
for anything whose job is to keep something else alive. Close this incident when a sweep on 0.10.1
reaches `keepalive_probe` and the deployed Worker has been verified the same way.
```

### 7.2 `wiki/incidents/2026-09-polyphony-neon-never-sleeps.md` (wrapper)

```markdown
---
id: incident/2026-09-polyphony-neon-never-sleeps
type: incident
title: An idle Polyphony kept its Neon compute awake
updated: 2026-11-01
status: confirmed
tool: polyphony
opened: 2026-09-01   # TODO: exact date from the Polyphony repo
closed: 2026-09-30   # TODO
evidence:
  - post:https://rtrentjones.dev/blog/keepalive-green-database-paused/
  - commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42
patterns:
  - pattern/neon-never-sleeps
  - pattern/probe-touches-wrong-layer
timeline:
  - { date: 2026-09-01, text: "found ~50,000 queries/day from an idle app (job poll 2s ≈ 43,200; reaper 60s ≈ 1,440; healthcheck 30s ≈ 5,760)" }
  - { date: 2026-09-15, text: "worker switched to wake-on-enqueue with one scheduled wake-up; reaper runs only while jobs run" }
  - { date: 2026-09-20, text: "liveness split: /health/live (no DB) for healthcheck and keepalive; /health for verify only", evidence: "commit:RTrentJones/RTrentJones.dev@16cee9a60db9a93d55567bd41d21378a193c0e42" }
---
Suspension needs five quiet minutes, and the app never gave it one. That came to roughly 720 awake
hours a month, using most of the free compute allowance before any scene had been generated. The
keepalive probe was not the cause, since its cron runs every three days, but it probed the wrong
layer.
```

## 8. First-iteration fixtures (M2)

These are the seeds for the first complete WikiSkill cycle (06 §10). They live in the framework
repo's `bench/`, which is never visible to rollout agents, proposers or maintainers (06 §1.4).

### 8.1 Seed status at M1

Five framework patterns enter as `confirmed`. Each has deployed red→green evidence, or a guard that
fails on the faulty configuration:

| pattern | why it is confirmed |
|---|---|
| `keepalive-probe-misses-postgres` | 0.9.0 deployed; the deployed Worker was verified byte-identical to the release by SHA-256, its configuration named the probe table, and the probe table answered an anonymous request with a row (§7.1) |
| `settle-greenlights-previous-deploy` | `verify --expect-sha` refuses an artifact whose `/__version` differs, on every SHA-gated ship |
| `dcr-disabled-silently` | the DCR checks run against the deployed server on every ship and fail when registration is disabled |
| `unplanned-compute-replacement` | the generated plan guard fails a plan that replaces running compute |
| `spec-typo-disables-assertion` | strict spec validation fails a config with an unknown or mistyped field before any check runs |

The other fifteen patterns enter as `hypothesis`, and they are inputs to the cycle. Confirming them
is work the cycle does, through the outlets in 06 §5.6. Seeding does not confirm them.

### 8.2 Replay tasks

**`replay/keepalive-probe-reaches-store`** (`fidelity: runtime`, grader `app`)

- **Fixture.** A fixture wrapper with one `next/vercel/supabase` tool, plus a fake Supabase-shaped
  service run under miniflare. The fake serves:
  - `/rest/v1/` from an in-memory schema document **without** touching its store;
  - `/rest/v1/<table>?select=…` by executing a query against its store.

  It resets a simulated 7-day idle timer **only on store queries**, and it exposes
  `/__fake/idle` with `{ lastQueryAt, paused }`.
- **Brief.** "Add a keepalive target for `<tool>` so its database does not pause."
- **Hidden grader.** It runs one keepalive sweep against the fake and asserts:
  - `paused: false`;
  - `lastQueryAt` advanced;
  - the target declares a `probeTable`, and its probe reads that table without exposing user
    columns (structural part).

**`replay/idle-probe-leaves-store-asleep`** (`fidelity: runtime`, grader `app`)

- **Fixture.** A fixture `mcp/oci` container tool, run locally under docker as its `preview`
  descriptor, backed by a fake Neon-shaped Postgres proxy. The proxy counts every query and records
  its origin from the connection's `application_name`.
- **Brief.** "Add container liveness and a keepalive target for `<tool>`."
- **Hidden grader.** It simulates a 10-minute idle window with the healthcheck interval and the
  keepalive schedule compressed. It asserts:
  - zero queries from the healthcheck and from the keepalive;
  - `/health/live` answers 200 while the database is stopped;
  - `/health` still reports the database when called once by verify.

**Train and val variants.** Each replay task has two fixture variants that differ in tool name, the
store's table names and the app framework. One variant is in `train` and one in `val`, so the val
instance is unseen by the proposer (06 §1.4).

### 8.3 Mutants

Every mutant must make the named grader fail. CI fails if any grader passes a mutant (06 §4.3).

| mutant | applied to | must fail |
|---|---|---|
| historical root probe: the target probes `/rest/v1/` | replay/keepalive-probe-reaches-store | keepalive-probe-reaches-store |
| historical cached probe: the subrequest can be served from cache | replay/keepalive-probe-reaches-store | keepalive-probe-reaches-store |
| historical healthcheck: container `HEALTHCHECK` and keepalive target `/health` | replay/idle-probe-leaves-store-asleep | idle-probe-leaves-store-asleep |
| historical poll loop: a 2-second queue poll against the store | replay/idle-probe-leaves-store-asleep | idle-probe-leaves-store-asleep |
| **overgeneral A**: "every healthcheck and keepalive queries the database", applied to both fixtures | both | **idle-probe-leaves-store-asleep only** |
| **overgeneral B**: "probes never touch the database", applied to both fixtures | both | **keepalive-probe-reaches-store only** |

The two overgeneral rows are what make the pair a test of learning. Each wrong rule passes one task
and fails the other. A grader pair in which either overgeneral mutant passes both tasks, or fails
both, is invalid, and `bench check-graders` refuses it.

### 8.4 Maintainer task: `wiki/probe-layer-incidents`

- **Input bundle:**
  - the incident pages §7.1 and §7.2;
  - failing train traces from both replay tasks under the current skills;
  - the pages `keepalive-probe-misses-postgres` (confirmed), `neon-never-sleeps` (hypothesis) and
    `probe-touches-wrong-layer` (hypothesis).
- **Required distinction.** The output must contain, as a new page or an update to
  `probe-touches-wrong-layer`, a rule that is **conditional on the liveness model**:
  - for `needs-traffic` the probe reaches the store;
  - for `needs-silence` and `needs-heal` it stops at the application.

  The rule must cite evidence from both incidents.
- **Structural checks:**
  - the output validates against `MaintainerOutput`;
  - every new or changed claim cites an `EvidenceRef` present in the bundle;
  - no existing evidence ref is removed;
  - no `hypothesis` is moved to `confirmed`, because the bundle holds no deployed red→green
    evidence for the Neon side.
- **Known-bad outputs.** These are the grader's mutants, and each must fail:
  1. states overgeneral A;
  2. states overgeneral B;
  3. drops the Neon incident's evidence from the updated page;
  4. adds a claim with no evidence ref, such as "Neon suspends after 60 seconds";
  5. sets `neon-never-sleeps` to `confirmed`.

### 8.5 Loop control task: `loop/fixture-preview-before-push`

- **Fixture.** A fixture tool with a one-line change requested.
- **Grader.** The `trajectory` grader requires
  `before(preview passed for <tool>, git push origin develop)`.
- **Purpose.** It checks the trajectory machinery itself, not the probe lesson.
- **Mutants:**
  - a recorded trajectory that pushes before previewing;
  - one that previews a different tool;
  - one whose preview failed.

### 8.6 Control-arm proposal

The harness evaluates a hand-written skill patch to `greenlight-build`, labelled `control` in the
ledger and never merged:

> **Health checks must always query the database**, so that a probe cannot pass while the store is
> unreachable.

It is plausible, and it is wrong for `needs-silence`. The cycle's own self-check passes only when
the evaluator rejects it: `replay/idle-probe-leaves-store-asleep` (val variant) must regress under
the patch on both gate models. If the control is accepted, the gate is not discriminating, and the
iteration is recorded as a harness failure, not as a learning result.
