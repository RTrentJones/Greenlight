# The `agent` lane — autonomous tools (Gemini free tier)

Status: **A1 building** (provider pack + matrix landed). A2 (template + deploy) and A3 (live
dogfood) follow. Ships across **0.3.0**.

## What an agent is

An `agent` is an autonomous tool: a **Cloudflare Worker** that wakes on a **cron trigger**, calls an
LLM (**Gemini**, free tier), does low-stakes work, stores the result, and exposes a tiny HTTP
surface. It is the [keepalive](../infra/modules/keepalive) Worker pattern (a proven cron Worker)
promoted to a first-class user lane.

Why this shape: workers + cron is **free tier**, immune to repo-inactivity (the keepalive lesson),
no OCI idle-reclaim, no new paid account; Gemini's free tier is **one Google AI Studio key, no
billing/card**, with limits a daily cron sits far under.

## Matrix

| lane | targets | data | llm |
|---|---|---|---|
| **agent** | `workers` | `none`, `kv` | `gemini` (v1; a future `llm` axis generalizes this) |

`agent` → `workers`, default data `kv` (stores last output + run metadata).

## Worker surface

```
scheduled(daily) -> Gemini(gemini-2.5-flash) -> KV.put(today, text + metadata)
GET  /           -> latest output (public, read-only)
GET  /status     -> { ok, lastRun, model, preview }    <- verify api-mode target
POST /run        -> force a run (bearer-gated RUN_TOKEN; seeds first output + lets verify trigger)
```

## Locked decisions

1. **Deploy = wrangler** (like the astro blog + mcp/workers): cron + KV binding + `custom_domain` +
   the `GEMINI_API_KEY`/`RUN_TOKEN` secrets in `wrangler.toml` / `wrangler secret`. No Terraform for
   the agent — KV/DNS are wrangler-managed for the workers target.
2. **Verify = `api` mode** on `/status` (asserts `ok:true` + a recent run). `eval` (LLM-judged output
   quality) is the v2; a dedicated `agent` verify mode later.
3. **First agent = a self-contained daily content generator** — Gemini-generated text stored in KV +
   served. Zero external data sources / extra tokens. A real-data **digest** agent is the v2.
4. **Safety**: read-only/low-stakes; bearer on `/run`; daily cron stays far under the free-tier
   quota; the key is secret-only (never committed/echoed).
5. **Version**: `0.3.0` (a new lane is a capability tier), lockstep across npm + module refs + wrapper.

## Phases

- **A1 — provider pack + matrix** *(done)*: the `gemini` pack in
  [cli/src/providers.ts](../cli/src/providers.ts) (`GEMINI_API_KEY`, verify `…/v1beta/models`,
  `provider-gemini` skill, AI-Studio setup URL); the `agent` lane + MATRIX row in
  [packages/shared/src/schema.ts](../packages/shared/src/schema.ts); `lane` threaded into
  `ProviderToolInfo`/`ToolKitInfo` so the pack matches; tests.
- **A2 — `_template-agent` + deploy path**: a Worker template (`src/index.ts` `scheduled`+`fetch`,
  `wrangler.toml` cron+KV+custom_domain, `verify.config.ts` api→`/status`, README, `gitignore`);
  confirm the workers adapter covers cron/KV; wire the `add` emit; tests.
- **A3 — live dogfood**: `greenlight add <name> --lane agent --target workers --data kv` → gather a
  free Gemini key → deploy (wrangler) → `POST /run` seed → `verify --env prod` → confirm the cron
  fires and output lands in KV. (Needs the free key + the 0.3.0 release.)

## Gemini (free tier) reference

- Key: Google AI Studio (`aistudio.google.com/apikey`) — free, instant, no billing.
- Model: `gemini-2.5-flash`.
- Call: `POST …/v1beta/models/gemini-2.5-flash:generateContent?key=…` with
  `{ contents: [{ parts: [{ text }] }] }`.
- Pack verify: `GET …/v1beta/models?key=…` → 200 (fail-fast on a bad key).

See the [provider-gemini skill](../.claude/skills/provider-gemini/SKILL.md) for the runtime details.
