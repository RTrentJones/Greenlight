# Changelog

## v0.9.0

The keepalive-actually-works release. Supabase paused `heistmind-db` on 2026-07 while keepalive
reported every target healthy — the probe had never once created database activity, and the
scoring made that undetectable. Both are fixed, and the fix is loud where the old one was quiet.

### Breaking

- **`supabase` keepalive targets now require `probeTable`** (or an explicit `probePath`). The probe
  GET the PostgREST root (`/rest/v1/`), which PostgREST answers from its in-memory schema cache
  without issuing any SQL. Supabase measures *database* activity, not HTTP traffic, so the ping
  never reset the 7-day idle timer — the "table/schema-agnostic, survives schema changes" property
  that made the root attractive is exactly what made it useless. Targets now issue
  `GET /rest/v1/<probeTable>?select=*&limit=1`, a query that actually executes.
  **Consumers: add `probeTable` to every supabase target in `targets_json`.** Pick a table the
  `anon` role can `SELECT`; RLS returning zero rows is fine — what matters is that the query ran.
  A target without one now reports a failure instead of a false pass.
- **A `supabase` target is alive only on a 2xx.** Previously any status under 500 counted as alive,
  so a 401 from a dead or rotated key looked healthy and never opened an alert issue — which is how
  the pause above went unnoticed. A missing `anonKey` now fails without a request rather than
  falling through to an unauthenticated ping that "passes".
  `oci` targets keep the lenient rule deliberately: a 401 from an auth-gated endpoint (BAMCP's
  `/mcp`) still proves the tunnel and container are serving, which is all that probe claims.

### Added

- **`probeSchema`** on a keepalive target — sent as `Accept-Profile`, for tools whose tables live
  outside `public` (schema-per-env).
- **`probeSelect`** — narrows the probe's `select=` (default `*`) to keep row data off the wire.

### Follow-ups (deliberate, not forgotten)

- **The Worker has no route**, so its `fetch` handler — which returns a full sweep as JSON — is
  unreachable and a sweep can only be observed via `wrangler tail`.
- **Nothing catches "the Worker stopped running."** Alerts fire only when it runs *and* observes a
  failure; a cron that stops firing is still silent. A dead-man's-switch on an independent platform
  closes it.
- **`doctor` does not check that a `data: supabase` tool has a `probeTable`**, so this class of
  misconfiguration is still caught at pause time rather than at check time.

## v0.8.0

The gate-identity release: verification now asserts *which artifact* is serving, promotion is
pinned to the commit that was verified, and the loop measures itself.

### Breaking

- **`Adapter.teardown` removed; `deployStyle` required.** All four implementations only ever threw
  from `teardown` — a contract nobody implements is documentation. Its replacement is the hook the
  loop actually needs: optional `rollback(toolDir, env, previous)`. Every adapter now declares
  `deployStyle: 'push' | 'git'`; callers branch on it instead of catching vercel's not-wired throw.
  Custom adapters must update.
- **`exactTools` defaults ON when `expectTools` is non-empty** (mcp verify). The drift guard is
  the point of listing tools — a capability added in code but not in the verify loop now fails the
  gate by default. Opt out with `exactTools: false`; the empty lane-default smoke spec keeps it off.
  **Consumers: audit your mcp specs** — an intentionally-partial `expectTools` list needs the
  explicit opt-out.
- **CLI command functions return exit codes** (`Promise<number>`) instead of calling
  `process.exit` mid-body; `bin.ts` owns the single exit. Affects programmatic importers only.
- **Unknown CLI flags now error** instead of being silently ignored (`--waitt 30` no longer runs
  the command with different semantics than asked).

### Added

- **`greenlight ship <name> --env <beta|prod>`** — one in-process loop turn: build → deploy →
  SHA-gated verify → rollback on failure. Replaces the `deploy X && verify X` shell pairs in
  workflows (which could never react to a failed prod verify — the deploy context was gone).
  `--events <file>`, `--expect-sha`, `--no-rollback`.
- **Stage events**: every ship/preview stage emits `{ stage, tool, env, gitSha, durationMs,
  passed, skillVersion }` — stderr JSON lines, optional file, and a best-effort POST to
  `$GREENLIGHT_INGEST_URL` (bearer `$TRACER_INGEST_TOKEN`, 5s cap, never fails the ship) in a
  tracer-compatible shape. The loop's own telemetry: push→healthy-in-prod latency, first-pass gate
  rate, rollback MTTR.
- **Artifact-identity verify (`--expect-sha`)**: the workers adapter bakes `GREENLIGHT_SHA` into
  builds; a tool serves `{ sha }` at `/__version`; `api` verify probes it FIRST, retrying within
  the settle budget — the settle loop can no longer green-light the *previous* deployment. Missing
  endpoint/sha degrades to a passing "sha unverified" check (per-tool opt-in); a mismatch fails
  hard and skips content checks.
- **SHA-pinned promotion (`promote --commit <sha>`)**: the fast-forward targets exactly the
  verified commit. If develop moved after the beta verify, only the verified commit is promoted
  (with a warning); a sha never on develop refuses. Closes the verify→promote TOCTOU.
- **Rollback (workers)**: `deploy` captures the live version id before deploying; a failed
  post-deploy verify restores it via `wrangler rollback`. oci/docker return a typed
  `{ ok: false }` with the heal path (digest-pinned rollback is the noted follow-up).
- **Per-check metrics**: every `api` check records `durationMs` + `attempts` (settle re-runs — the
  raw flakiness signal), exported in `--json` as `duration_ms`/`attempts`.
- **Parallel verify**: adjacent specs marked `concurrency: 'parallel'` overlap (api/mcp);
  the internal-link crawl fetches through a 6-wide pool instead of serially.
- **Function-shaped verify configs**: `export default (ctx: { env, url, preview }) => spec(s)` —
  the explicit alternative to reading `GREENLIGHT_*` env vars at module-eval time.
- **`preview --no-build`**; a passing preview writes a gitignored `.greenlight/preview-<sha>`
  receipt and emits a `preview` stage event (local-gate compliance becomes measurable).
- **Doctor**: local-only "no preview receipt for HEAD" nudge (skipped in CI); loud warning when
  verify falls back to the lane default smoke spec.
- **`readyTimeoutMs`** manifest field — per-tool readiness window override for preview/verify
  waits (replaces three unrelated hardcoded constants).

### Changed

- Emitted consumer templates (`adopt`/`init`) now carry the hardened workflows: `ship` instead of
  deploy+verify pairs, `doctor --strict` in CI, the fail-loud promote creds gate, sha-pinned
  promote + prod ship, a plan → destroy-guard → apply sequence in the unattended remediate path,
  and SHA-pinned third-party actions.
- The promote workflow now checks out the promoted commit before shipping prod. (Bug: the FF moved
  `origin/main`, but the CI working tree still held the dispatch ref — prod built PRE-promotion
  code, and the `GITHUB_TOKEN` push never re-triggers deploy.yml, so promoted code never actually
  reached prod until the next human push.)
- Framework CI: concurrency group (stale runs cancel), pnpm store cache, SHA-pinned actions.

### Follow-ups (deliberate, not forgotten)

- oci/docker digest-pinned rollback (Terraform-plane: instance pinned to an image digest instead
  of the mutable `:prod` tag).
- Tune `settleRetries`/`settleMs` per tool from the new `attempts` data instead of the 8×5s guess.
