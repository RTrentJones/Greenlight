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
in git was not what was running (`pattern/settle-greenlights-previous-deploy`,
`pattern/fix-merged-not-running`, 15 §2). The harness's artifact-identity probe
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
Postgres and pgvector, so Neon never scaled to zero, and the compute allowance drained
(`pattern/neon-never-sleeps`). The opposite failure appeared on HeistMind, where the keepalive
needed to reach the store and did not (`pattern/keepalive-probe-misses-postgres`). C2 gives each probe the layer it should touch.

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
connector could no longer register (`pattern/dcr-disabled-silently`). HeistMind's Discord endpoint needed a check that an
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
fix keyed freshness by producer (`pattern/freshness-across-producers`). A cron that stops still answers 200 with yesterday's
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
60-second reaper and a 30-second healthcheck. Neon never slept (`pattern/neon-never-sleeps`).

**Enforcement.** This clause cannot be expressed as a plain HTTP assertion, so it is enforced in
three places:

- by C2, which closes the healthcheck path;
- by DR-21, which fails a `needs-silence` probe that reaches the store;
- by a `structural` replay task in the bench (06 §4), which runs the app under a simulated idle
  window against a counting Postgres proxy and asserts zero queries.

The build skill carries the event-driven rule for application code.

### C7 — Environment-invariant checks are marked

**Rule.** A verify config MUST export a named `meta` object listing the ids of the checks that hold
in every environment:

```ts
export const meta = { invariant: ['identity', 'live', 'guard-vote'] };  // hold in preview, beta and prod
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
a green preview had been read as more than it proved
(`pattern/preview-prod-path-drift`).

**Loader change required.** Today `loadVerifySpecAt` in `cli/src/manifest.ts` imports the module
with jiti and keeps only `mod.default` (`let def = 'default' in mod ? mod.default : mod`). Named
exports are discarded, so `meta` would never reach `preview`, `doctor` or the report. The loader
MUST return `{ specs, meta }`:

- `meta` is validated strictly. Its only allowed key in this version is `invariant`, a list of
  check ids. Every id must exist in at least one environment's specs, otherwise the loader fails
  with `meta.invariant names unknown check "<id>"`.
- A function-form config is **evaluated once per context**, with
  `{ preview: true, env: 'preview' }`, `{ env: 'beta' }` and `{ env: 'prod' }`. This uses the same
  `VerifyConfigContext` the loader already constructs. From the three results the loader computes
  the coverage table `checkId → environments where the check is present`.
- An id listed in `invariant` that is absent from any environment's evaluated specs is a C7
  violation (DR-26). Configs are evaluated, never statically parsed: evaluation is what `verify`
  already does, and static inspection of arbitrary TypeScript cannot be made reliable.
- `VerifyReport` gains `coverage?: Record<string, DeployEnv[]>`, and the `--json` export carries
  it.

**Enforcement.** The template exports `meta`, DR-26 flags configs without it or with invariant ids
missing from an environment, and `preview` prints the split from the coverage table: "guaranteed for
prod: identity, live, guard-vote; prod-only, not run: ready-data".

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
other templates gain the following. The astro/workers row lands in M4, as the single creation path
the first vibe-code drill exercises (§6). The other lanes land in M6, each through the WikiSkill
cycle's template outlet (06 §5.6).

| lane / target | C1 `/__version` | C2 `/health/live` + `/health` | C4/C5 | C7 | files changed |
|---|---|---|---|---|---|
| `astro/workers` | server endpoint `src/pages/__version.ts` → `/__version`, reading the `GREENLIGHT_SHA` runtime var (§6.4) | `src/pages/health/live.ts` → `/health/live`; `src/pages/health/index.ts` → `/health`, one cheap D1 read when `data: d1` | n/a unless the site has a cron | `verify.config.ts` exports `meta` | the full runtime in §6 |
| `next/vercel` | `app/__version/route.ts` returning `process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GREENLIGHT_SHA ?? null` | `app/health/live/route.ts`; `app/health/route.ts` querying the store via `lib/db` with one `select 1` (Neon) or a probe-table read (Supabase), with `export const dynamic = 'force-dynamic'` | optional `lib/attempts.ts` helper | yes | `_template-next/app/*`, `verify.config.ts` |
| `mcp/workers` | route `/mcp/__version` in the Worker's fetch handler before MCP dispatch | `/mcp/health/live`, `/mcp/health` | n/a | yes | `_template-mcp/workers/*` (the template is README-only today, so M6 adds a minimal Worker) |
| `mcp/oci`, `mcp/docker` | `server.ts` serves `/mcp/__version` from the `GREENLIGHT_SHA` build-arg baked into the image (`Dockerfile`: `ARG GREENLIGHT_SHA` → `ENV`) | `/mcp/health/live`; `/mcp/health`; the `Dockerfile` `HEALTHCHECK` targets `/mcp/health/live` | n/a | yes | `_template-mcp/oci/{server.ts,Dockerfile}`, `verify.config.ts` |
| `agent/workers` | present | add `/health/live`; keep `/status` as the C4/C5 surface and add `producers` | present (C5 already) | add `meta` | `_template-agent/src/index.ts`, `verify.config.ts` |

Every generated `verify.config.ts` contains, at minimum, the checks `identity`, `live` and `ready`
(where a store exists), plus `requireIdentity: true` on the non-preview branch and a `meta` export.
Because of this, the first `greenlight preview` after `greenlight add` already passes C1, C2 and C7.
That is the template-outlet acceptance check for each lane (06 §5.6), and the astro row is part of
the M4 exit (14).

## 4. Enforcement map

| clause | template (outlet 3) | doctor (outlet 2) | verify (outlet 4) | skill (outlet 5) |
|---|---|---|---|---|
| C1 | routes + build injection | DR-24 | `identity` + `requireIdentity` | build: "never remove `/__version`" |
| C2 | both routes, healthcheck wiring | DR-21 (probe layer), DR-22, DR-23 | `live`, `ready` | build: which probe uses which route |
| C3 | — (app-specific) | — | `guard-*`, `dcr-*` | build: "every write route gets a guard check in the same change" |
| C4 | agent template `producers` | DR-25 | `fresh-*` | build |
| C5 | agent template attempt records | — | `ok` | build |
| C6 | event-driven worker skeleton in templates that have background work (agent; next with a queue, as an optional module) | DR-21 | structural replay task | build: "no fixed-interval polling against a store" |
| C7 | `meta.invariant` export | DR-26 | `preview` report split from the loader's coverage table | loop: "a green preview proves only `meta.invariant`" |

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
| C7 | env-invariant marking | the same `meta.invariant` export distinguishes checks that hold for both the prerelease dist-tag and `latest` |

## 6. Astro on Workers: the runtime for the first creation path

M4 delivers exactly one creation path end to end: astro/workers/d1 with no domain and beta-only
provisioning. Everything in this section is normative for that path.

### 6.1 What exists today, and why it is insufficient

- **The template is static only.** `tools/_template-astro` pins `astro ^5.7.0` and has one page,
  `src/pages/index.astro`. `astro.config.mjs` sets only `site` and the sitemap integration, with
  no adapter. `wrangler.jsonc` declares `"assets": { "directory": "./dist" }`, with no `main`
  entry and no bindings.
- **The workers adapter assumes static output.**
  - `workersAdapter` in `packages/adapters/src/index.ts` runs `pnpm run build` with `SITE_URL`
    and `GREENLIGHT_SHA` in the environment, and returns `artifactDir: <tool>/dist`.
  - `deploy` runs `wrangler deploy --env <env>` and captures the previous version id for rollback.
  - Nothing builds, previews or deploys a server entry, and nothing applies D1 migrations.
- **`hybrid` is not an option.** Astro 5 removed `output: 'hybrid'` and folded its behaviour into
  `static`, so a config naming it is rejected. The previous draft of this contract proposed it, and
  that was wrong.
- **A static site cannot be the reference app.** A book-club vote needs shared state, an identity
  model and a readiness probe against D1. Static output cannot provide any of those.

### 6.2 Decision: `output: 'static'` with the Cloudflare adapter and per-route `prerender = false`

The template uses the Astro 5 default `output: 'static'`, adds `@astrojs/cloudflare`, and marks
each dynamic route with `export const prerender = false`.

This is chosen over `output: 'server'` for the free tier. Prerendered pages are served by Workers
Static Assets, and asset requests do not invoke the Worker or count against the Workers request
allowance. Only API routes and the contract routes run in the Worker. A content-heavy app therefore
stays far under the request limit, and pages keep working while a dependency is down.

`output: 'server'` remains a documented alternative for apps where most pages are personalized.

**Version pinning.** The adapter's major version must match the installed Astro major. The exact
`@astrojs/cloudflare` version, and whether its Workers output layout matches §6.3, MUST be verified
against the adapter's documentation when M4 is implemented, and then pinned exactly. The layout
below is the one documented for the Astro 5 era of the adapter. If the verified layout differs, the
adapter integration (§6.5) follows the verified layout, and this section is corrected in the same
change.

### 6.3 Files

```
astro.config.mjs        adapter: cloudflare({ platformProxy: { enabled: true } }); output: 'static'
wrangler.jsonc          main: ./dist/_worker.js/index.js; assets: { directory: ./dist, binding: ASSETS }
                        d1_databases: [{ binding: DB, database_name, database_id, migrations_dir: migrations }]
                        preview_urls: false; workers_dev: per env (§6.6)
                        env.beta / env.prod: own name, account_id and database_id (§6.7)
public/.assetsignore    _worker.js and _routes.json, so the Worker bundle is never served as an asset
migrations/0001_init.sql
src/env.d.ts            typed runtime env: { DB: D1Database; GREENLIGHT_SHA: string }
src/lib/db.ts           D1 accessor from context.locals.runtime.env.DB
src/pages/__version.ts  → GET /__version          prerender = false
src/pages/health/live.ts → GET /health/live       prerender = false (process only, no DB)
src/pages/health/index.ts → GET /health           prerender = false (one D1 read)
verify.config.ts        meta + specs (§6.9)
tests/votes.spec.ts     Playwright request-context suite for the multi-client flow (§6.9)
```

Endpoint files are extensionless TypeScript endpoints. The earlier `__version.json.ts` and
`live.json.ts` names would have produced `/__version.json` and `/health/live.json`, which do not
match the contract's paths. Requiring the route table in §6.9 to pass in both local preview and
deployed beta is what prevents that drift from recurring.

### 6.4 Identity on a server route

`/__version` is server-rendered, so a build-time constant inlined into the page is not the source of
truth. Instead, the artifact carries its own identity:

1. **Build.** The adapter writes `dist/greenlight-artifact.json`, `{ "sha": "<build commit>",
   "builtAt": "…" }`, from the same `buildSha(toolDir)` it uses today.
2. **Deploy.** The adapter reads that file and passes `--var GREENLIGHT_SHA:<sha>` to
   `wrangler deploy`. Redeploying the same artifact, for example promoting a verified beta build to
   prod, therefore keeps its identity, which is what `--expect-sha` relies on.
3. **Serve.** `__version.ts` returns `{ sha: env.GREENLIGHT_SHA ?? null, builtAt }`. In local
   preview the var is set from the working tree's HEAD, or left as `null` when the tree is dirty.
   The identity check is then reported as "unverified", which is the existing behaviour.

### 6.5 Adapter changes (`packages/adapters/src/index.ts`, workers)

- **`build`.**
  - After the build, detect server output by the presence of `dist/_worker.js/`.
  - Write `greenlight-artifact.json`.
  - Return `artifactDir` plus `serverEntry` when present. `BuildResult` gains the optional field
    `serverEntry`.
- **`deploy`.** Before `wrangler deploy` the adapter runs the steps below, then runs the deploy
  with `--var GREENLIGHT_SHA:<sha>`:
  - When `migrations/` exists, run `greenlight migrations scan`, which already exists and is the
    dangerous-SQL gate.
  - Then run `wrangler d1 migrations apply DB --env <env> --remote`.
  - For `env: prod`, this whole step runs only inside the protected prod execution path
    (18-release-authority.md). The adapter refuses `prod` when
    `GREENLIGHT_RELEASE_AUTHORIZED` is absent, so an agent calling `greenlight deploy --env prod`
    from a session fails closed.
- **`preview`.** This is the `greenlight preview` path for this cell.
  1. Build with `GREENLIGHT_SHA` from HEAD.
  2. Run `wrangler d1 migrations apply DB --local --persist-to .greenlight/d1`.
  3. Run `wrangler dev --local --persist-to .greenlight/d1 --port <port>` against the built output.
     This is the same Worker bundle and asset layout that deploys, with D1 emulated by Miniflare.
  4. Run verify, then tear down.

  `astro dev`, which uses `platformProxy`, is for interactive development only. It is never the
  gate, because it does not exercise the built Worker.
- **`rollback`.** Unchanged: `wrangler rollback <versionId>`. Rollback does not revert D1
  migrations, so migrations MUST be additive (expand, then contract in a later release). The build
  skill carries that rule, and the migrations scan flags `DROP` and `ALTER … DROP`.

### 6.6 No-domain access to beta

In no-domain mode, beta is served at the beta account's workers.dev subdomain (§6.7, 08 §1.3).
Three controls keep beta from being publicly open by accident:

- **Cloudflare Access on workers.dev.** For tools with `access: 'private'`, or when the owner opts
  in for beta, Cloudflare Access is enabled on the beta Worker's workers.dev route. It is declared
  in Terraform next to the Worker and verified by a `guard-access` check that expects the Access
  redirect without a session.
- **`preview_urls: false`.** Version preview URLs (`<version>-<name>.<sub>.workers.dev`) are
  disabled in every env. They would otherwise serve any uploaded version, without the Access
  policy the main route has. DR-24's sibling check fails a workers tool whose wrangler config omits
  this.
- **`workers_dev`.** This is `true` only for the env being served there. In domain mode prod sets
  `workers_dev: false`, so the custom domain is the only public route and cannot be bypassed via
  workers.dev.

### 6.7 Beta-only provisioning

The first deploy of a new app MUST NOT create production resources.

- **Separate accounts.** Beta resources live in the owner's **beta Cloudflare account**: the
  Worker `<name>-beta` and the D1 database `<name>-beta`. That account is separate from prod
  because Cloudflare API tokens cannot be scoped to individual Worker scripts (18-release-authority
  §2). The agent's beta-scoped capability can create them without approval.
- **No prod resources at kickoff.** `greenlight add` emits the prod environment in
  `wrangler.jsonc` with `database_id` unset, and emits the prod D1 declaration in Terraform. No
  workflow creates those resources until the first approved prod release. The prod `database_id`
  is filled by the approved apply's output, and that change is committed by the protected
  execution identity.
- **Kickoff ends at beta.** The kickoff drill (14, M4) ends at a green beta. `portfolio` shows
  prod as `none` until the owner approves a release.

### 6.8 Reference app: book-club voting

This is the app the M4 drill builds from the brief "a site where my book club can vote on next
month's pick". The agent writes it from the build skill and the template. This specification is
the reference solution that the bench task's hidden grader (`cap/astro-workers-d1-bookclub`) is
written against, and it defines the mutants.

**Identity model.**
- The owner creates an invite code with `wrangler d1 execute` (the drill script does this).
- A member posts the code and a display name to `/api/join`, and receives a random 32-byte member
  token in an `HttpOnly; Secure; SameSite=Lax` cookie `bc_member`. The database stores only
  SHA-256(token).
- There are no passwords or third-party OAuth. An invite code has a use limit.

**Schema (`migrations/0001_init.sql`).**

```sql
CREATE TABLE invites (code_hash TEXT PRIMARY KEY, uses_left INTEGER NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                      created_at TEXT NOT NULL);
CREATE TABLE rounds  (id TEXT PRIMARY KEY, title TEXT NOT NULL, closes_at TEXT NOT NULL);
CREATE TABLE options (round_id TEXT NOT NULL REFERENCES rounds(id), id TEXT NOT NULL,
                      label TEXT NOT NULL, PRIMARY KEY (round_id, id));
CREATE TABLE votes   (round_id TEXT NOT NULL REFERENCES rounds(id),
                      member_id TEXT NOT NULL REFERENCES members(id),
                      option_id TEXT NOT NULL, created_at TEXT NOT NULL,
                      UNIQUE (round_id, member_id));
```

**Endpoints.** All of them are `prerender = false`.

| method & path | auth | success | failures |
|---|---|---|---|
| `POST /api/join` `{code, name}` | none | 201, sets `bc_member` | 403 bad or exhausted code; 422 invalid body |
| `GET /api/rounds/current` | member | 200 `{round, options, results?}`; `results` present only after `closes_at` | 401 without cookie |
| `POST /api/rounds/:id/votes` `{optionId}` | member | 201 | **401** without a valid cookie; **409** second vote by the same member (the UNIQUE constraint, never a read-then-write check); 422 unknown option; 423 round closed |
| `GET /__version`, `/health/live`, `/health` | none | contract (§1) | `/health` 503 when D1 fails |

**Criteria (`intent.md`, 08 §3.4).**
- `AC-1`: members can vote once per round.
- `AC-2`: results show only after the deadline.
- `AC-3`: only invited members can vote.

### 6.9 Verify spec and acceptance

```ts
export const meta = { invariant: ['identity', 'live', 'ready', 'guard-vote', 'ac-votes'] };

export default ({ env }: VerifyConfigContext) => [
  {
    mode: 'api',
    requireIdentity: env !== 'preview',
    checks: [
      { id: 'identity',   path: '/__version', status: 200, json: [{ path: 'sha', exists: true }] },
      { id: 'live',       path: '/health/live', status: 200, json: [{ path: 'ok', equals: true }], maxMs: 1500 },
      { id: 'ready',      path: '/health', status: 200, json: [{ path: 'checks.database', equals: 'healthy' }] },
      { id: 'guard-vote', path: '/api/rounds/drill/votes', method: 'POST', body: { optionId: 'a' }, status: 401 },
      { id: 'guard-read', path: '/api/rounds/current', status: 401 },
    ],
  },
  {
    // AC-1..AC-3 need state across requests and two independent clients, which single api checks
    // cannot express. The suite uses Playwright's request context with separate cookie jars.
    mode: 'playwright',
    id: 'ac-votes',
    suite: { command: 'pnpm exec playwright test tests/votes.spec.ts',
             env: { BC_INVITE_CODE: process.env.BC_INVITE_CODE ?? '' } },
  },
];
```

`tests/votes.spec.ts` runs this sequence:

1. Two clients, A and B, join with the drill invite code, using separate request contexts and so
   separate cookie jars.
2. A votes and receives 201. A votes again and receives 409. B votes and receives 201.
3. A third client with no cookie votes and receives 401. A client with a forged cookie receives
   401.
4. A **new** client C joins and reads `/api/rounds/current`. It sees both votes counted once the
   drill's round, which closes one minute after creation, has passed `closes_at`, and sees no
   `results` before that.

**Acceptance for M4 (14).** The drill passes only when all of the following hold:

- §6.9 passes against `greenlight preview`, meaning the local Worker with Miniflare D1;
- §6.9 passes against the deployed beta at its workers.dev URL;
- the route table `/__version`, `/health/live`, `/health`, `/api/join`, `/api/rounds/current` and
  `/api/rounds/:id/votes` is identical in both. The suite asserts that each path answers with the
  expected status, so an extension or path drift fails it.

The vote must persist across the independent clients of step 4, and the duplicate and
unauthorized votes must be rejected.

The bench task's mutants are the following, and the hidden grader must fail each one:
- a read-then-write duplicate check under concurrent requests;
- a vote route without the auth guard;
- results returned before the deadline;
- `/__version` served as `/__version.json`;
- `/health/live` querying D1.
