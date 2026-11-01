# 09 — The self-verifying-app contract

Every service Greenlight manages MUST satisfy clauses C1–C7. Together they make a tool checkable
by its *content*, which goes further than showing that it is reachable. Each clause comes from a
specific failure on the live portfolio (15 §2). Each one is enforced first by the strongest outlet
available (ADR-01): a template default where possible, then a `doctor` rule, then a verify check,
and skill text only for what cannot be mechanized.

There is one `contract` page per clause in the framework wiki (`wiki/contract/c1-identity.md` …),
with the schema in 08 §3.3. That page is the single text that templates, `doctor`, graders and the
`greenlight-build` skill all cite.

## 1. Clauses

### C1 — Identity

**Rule.** A service MUST serve its build commit at `GET <base>/__version` without authentication,
as JSON:

```json
{ "sha": "<40-hex>" }
```

It MAY add `"builtAt"` (ISO timestamp) and `"version"` (package version). `sha` MUST be the commit
the artifact was built from. It is injected at build time as `GREENLIGHT_SHA`; on Workers the
adapter bakes it in already, and on Vercel it comes from `VERCEL_GIT_COMMIT_SHA`. It is never
computed at runtime from a git checkout. In a local preview, where no commit is baked in, `sha` MAY
be `null`.

For the mcp lane, `<base>` is the connect base, so the route is `/mcp/__version`. BAMCP and
Polyphony already serve it that way.

**Why.** The verify settle loop could green-light the previous deployment, and a fix that existed
in git was not what was running (15, 15). The harness's artifact-identity probe
(`packages/verify/src/api.ts`, together with `requireIdentity`) turns enforcement on per tool by
exposing this route.

**Verify.**

```ts
{ id: 'identity', path: '/__version', status: 200, json: [{ path: 'sha', matches: '^[0-9a-f]{40}$' }] }
// and on the prod/beta branch of the spec:
requireIdentity: true
```

### C2 — Liveness separate from readiness

**Rule.** A service MUST expose two routes.

- `GET <base>/health/live` answers from the process alone. It MUST NOT open a database
  connection, call an LLM, or call any other paid or metered dependency. It returns
  `200 {"ok":true}`.
- `GET <base>/health` reports each dependency:

```json
{
  "ok": true,
  "checks": {
    "database": "healthy",
    "llm": "healthy",
    "queue": "degraded"
  },
  "sha": "<40-hex>"
}
```

Each entry in `checks` is `"healthy"`, `"degraded"` or `"down"`. `ok` is true only when no entry
is `"down"`. The route returns 200 when `ok` is true and 503 otherwise.

Keepalive probes, container healthchecks and uptime monitors MUST use `/health/live`. The one
exception is a `needs-traffic` liveness model, where the probe's whole purpose is to reach the
store; that probe uses the keepalive's `probeTable` query, not `/health`. `/health` is for
`verify`, at deploy time and on demand.

**Why.** Polyphony's container healthcheck hit `/health` every 30 seconds. That route checks
Postgres and pgvector, so Neon never scaled to zero, and the compute allowance drained (15).
The opposite failure appeared on HeistMind, where the keepalive needed to reach the store and did
not (15). C2 gives each probe the layer it should touch.

**Verify.**

```ts
{ id: 'live',  path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }], maxMs: 1500 },
{ id: 'ready', path: '/health',      status: 200, json: [{ path: 'ok', equals: true },
                                                         { path: 'checks.database', equals: 'healthy' }] },
```

### C3 — Guarded writes are asserted

**Rule.** Every route that changes state MUST reject an unauthenticated request. The tool's verify
config MUST contain one check per such route, sending the minimal request without credentials and
asserting the rejection status: 401, or whatever the route's protocol defines, such as Discord's
signature failure. If a protocol's discovery endpoints are a capability that clients rely on, as
OAuth Dynamic Client Registration is for MCP connectors, the config MUST also assert that the
capability is advertised **and** that it answers.

**Why.** BAMCP's DCR was disabled, and the static machine token kept verify green while claude.ai's
connector could no longer register (15). HeistMind's Discord endpoint needed a check that an
unsigned POST is rejected, because a missing key answered 503 instead (`verify/heistmind.config.ts`
in the wrapper).

**Verify.**

```ts
{ id: 'guard-<route>', path: '/api/<route>', method: 'POST', body: {}, status: 401 },
```

### C4 — Freshness per producer

**Rule.** Anything that runs on a schedule or ingests from producers MUST expose a last-success
timestamp **per producer**. A producer is a cron job, an upstream feed, or a `tool:mode` pair in
Tracer. Verify MUST assert `maxAgeHours` on each one, with a threshold of the schedule interval plus
a margin, such as a daily job at 26h.

```json
{ "producers": { "daily-digest": { "lastSuccess": "2026-11-01T06:00:12Z" },
                 "bamcp:eval":   { "lastSuccess": "2026-10-31T22:41:03Z" } } }
```

The response MAY be part of `/health` or `/status`.

**Why.** Tracer computed freshness across all tools, so one fresh producer masked a stale one. The
fix keyed freshness by producer (15). A cron that stops still answers 200 with yesterday's
data (greenlight-v2 §8, "depth over reachability").

**Verify.**

```ts
{ id: 'fresh-<producer>', path: '/status', json: [{ path: 'producers.<producer>.lastSuccess', maxAgeHours: 26 }] }
```

### C5 — Success is recorded, not inferred

**Rule.** A status of `ok: true` MUST mean that the most recent recorded attempt succeeded. It
MUST NOT mean that output exists, and it MUST NOT mean that nothing has failed yet. Every attempt
MUST be recorded with its timestamp and outcome. A failed attempt MUST set `ok: false` and expose
`lastError` until a later attempt succeeds.

**Why.** Muse reported `ok` before any attempt had succeeded, and its fix was "report ok only after
a successful recorded attempt". The agent template now implements this
(`tools/_template-agent/src/index.ts`: `ok = Boolean(rec) && attempt?.ok === true`). The verify
harness had the same bug class: it had to "require a successful attempt; reject empty matchers".

**Verify.**

```ts
{ id: 'ok', path: '/status', json: [{ path: 'ok', equals: true }, { path: 'lastError', equals: null }] }
```

### C6 — Idle cost is zero

**Rule.** With no user traffic, a service MUST NOT cause any query or call against a scale-to-zero
or metered dependency. This covers Neon, LLM APIs and paid APIs. Background work MUST be woken by
events, such as an enqueue or a scheduled wake-up computed from due work. It MUST NOT poll on a
fixed short interval. The only permitted idle traffic is what the tool's liveness model requires
(10 §1).

**Why.** An idle Polyphony made about 50,000 Postgres queries a day: a 2-second queue poll, a
60-second reaper and a 30-second healthcheck. Neon never slept (15).

**Enforcement.** This clause cannot be expressed as a plain HTTP assertion, so it is enforced in
three places:

- by C2, which closes the healthcheck path;
- by DR-21, which fails a `needs-silence` probe that reaches the store;
- by a `structural` replay task in the bench (06 §4), which runs the app under a simulated idle
  window against a counting Postgres proxy and asserts zero queries.

The build skill carries the event-driven rule for application code.

### C7 — Environment-invariant checks are marked

**Rule.** A function-shaped verify config MUST export the ids of the checks that hold in every
environment:

```ts
export const invariant = ['identity', 'live', 'guard-vote'];   // hold in preview, beta and prod
export default (ctx: VerifyConfigContext) => [...];
```

A check that is absent from `invariant` is environment-specific. Examples include data-dependent
checks that run in prod only, auth-on checks where preview runs with auth off, and holding-page
differences between beta and prod. When `greenlight preview` passes, its report MUST state that
only the invariant checks are guarantees for prod, and it MUST list the prod-only checks that did
not run.

**Why.** Polyphony's preview base had to change to `/mcp` before relative paths resolved the same
way locally. Tracer's data-dependent checks had to become prod-only. HeistMind's prod serves a
holding page while beta serves the app. BAMCP's preview runs with auth off (15). In each case
a green preview had been read as more than it proved.

**Enforcement.** The template exports `invariant`, DR-26 flags configs without it, and `preview`
prints the split.

## 2. Standard check ids

Templates and the build skill MUST use these ids so that patterns' `catches.checkSignature` and
intent criteria can reference them across tools.

| id | clause | notes |
|---|---|---|
| `identity` | C1 | |
| `live` | C2 | |
| `ready` | C2 | |
| `guard-<route>` | C3 | route slug in kebab-case |
| `dcr-advertised`, `dcr-answers` | C3 | MCP/OAuth tools |
| `fresh-<producer>` | C4 | |
| `ok` | C5 | |
| `ac-<n>` | — | checks that exist to assert intent criterion `AC-<n>` (08 §3.4) |

## 3. Per-lane implementation and template changes

Today only `tools/_template-agent` serves `/__version`, and its `/status` is a C4/C5 surface. The
other templates gain the following. All of it lands in P1.

| lane / target | C1 `/__version` | C2 `/health/live` + `/health` | C4/C5 | C7 | files changed |
|---|---|---|---|---|---|
| `astro/workers` | `src/pages/__version.json.ts` endpoint reading `import.meta.env.GREENLIGHT_SHA`, which the workers adapter injects at build. Prerendered at build, which is valid because the sha is static per build | `src/pages/health/live.json.ts` (static `{ok:true}`); `/health` only when `data` ≠ `none`, as a server endpoint querying D1/KV with one cheap read | n/a unless the site has a cron | `verify.config.ts` exports `invariant` | `_template-astro/src/pages/*`, `astro.config.mjs` (output: `static` with endpoints prerendered, or `hybrid` when `/health` needs a server route), new `verify.config.ts` |
| `next/vercel` | `app/__version/route.ts` returning `process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GREENLIGHT_SHA ?? null` | `app/health/live/route.ts`; `app/health/route.ts` querying the store via `lib/db` with one `select 1` (Neon) or a probe-table read (Supabase), with `export const dynamic = 'force-dynamic'` | optional `lib/attempts.ts` helper | yes | `_template-next/app/*`, `verify.config.ts` |
| `mcp/workers` | route `/mcp/__version` in the Worker's fetch handler before MCP dispatch | `/mcp/health/live`, `/mcp/health` | n/a | yes | `_template-mcp/workers/*` (the template is README-only today, so P1 adds a minimal Worker) |
| `mcp/oci`, `mcp/docker` | `server.ts` serves `/mcp/__version` from the `GREENLIGHT_SHA` build-arg baked into the image (`Dockerfile`: `ARG GREENLIGHT_SHA` → `ENV`) | `/mcp/health/live`; `/mcp/health`; the `Dockerfile` `HEALTHCHECK` targets `/mcp/health/live` | n/a | yes | `_template-mcp/oci/{server.ts,Dockerfile}`, `verify.config.ts` |
| `agent/workers` | present | add `/health/live`; keep `/status` as the C4/C5 surface and add `producers` | present (C5 already) | add `invariant` | `_template-agent/src/index.ts`, `verify.config.ts` |

Every generated `verify.config.ts` contains, at minimum, the checks `identity`, `live` and `ready`
(where a store exists), plus `requireIdentity: true` on the non-preview branch and an `invariant`
export. Because of this, the first `greenlight preview` after `greenlight add` already passes C1,
C2 and C7, which is the P1 exit criterion (14).

## 4. Enforcement map

| clause | template (outlet 3) | doctor (outlet 2) | verify (outlet 4) | skill (outlet 5) |
|---|---|---|---|---|
| C1 | routes + build injection | DR-24 | `identity` + `requireIdentity` | build: "never remove `/__version`" |
| C2 | both routes, healthcheck wiring | DR-21 (probe layer), DR-22, DR-23 | `live`, `ready` | build: which probe uses which route |
| C3 | — (app-specific) | — | `guard-*`, `dcr-*` | build: "every write route gets a guard check in the same change" |
| C4 | agent template `producers` | DR-25 | `fresh-*` | build |
| C5 | agent template attempt records | — | `ok` | build |
| C6 | event-driven worker skeleton in templates that have background work (agent; next with a queue, as an optional module) | DR-21 | structural replay task | build: "no fixed-interval polling against a store" |
| C7 | `invariant` export | DR-26 | `preview` report split | loop: "a green preview proves only `invariant`" |

## 5. The future `package` lane

The contract is written so that it does not assume HTTP, which lets the package lane (ADR-13)
adopt it without redesign.

| clause | service meaning | package meaning |
|---|---|---|
| C1 | `/__version` returns the build sha | `<bin> --version` prints the version and the sha; the published tarball's `package.json` carries `gitHead` |
| C2 | live vs ready routes | `<bin> --help` exits 0 without network (live); a smoke command exercises the real dependency (ready) |
| C3 | guarded writes | commands that mutate remote state refuse without credentials |
| C4 | per-producer freshness | n/a, unless the package ships a scheduler |
| C5 | recorded success | n/a |
| C6 | idle cost zero | importing the library performs no network I/O |
| C7 | env-invariant marking | the same `invariant` export distinguishes checks that hold for both the prerelease dist-tag and `latest` |
