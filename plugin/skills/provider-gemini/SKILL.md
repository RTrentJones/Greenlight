---
name: provider-gemini
description: The `agent` lane in Greenlight — an autonomous cron-triggered Cloudflare Worker backed by Google Gemini (free tier). Use when building, deploying, or verifying an agent tool, or debugging its KV / account-id / seed wiring.
---

# provider-gemini

The `agent` lane is an **autonomous tool**: a Cloudflare Worker that wakes on a **cron trigger**,
calls **Gemini** (free tier), does low-stakes work, stores the result in KV, and exposes a tiny
HTTP surface. It's the keepalive-Worker pattern promoted to a user tool — free, always-available,
immune to repo-inactivity, no OCI box, no paid account. `agent` → target **workers**, data
**none | kv** (kv holds the last output + run metadata).

## Token — `GEMINI_API_KEY`

Creation + verify live in
[tokens-reference.md](https://github.com/RTrentJones/greenlight/blob/main/docs/tokens-reference.md).
**Free tier, no billing / no card** (Google AI Studio). One key serves every agent (shared, not
per-tool); stored as a **Cloudflare Worker secret** (`wrangler secret put`), never in the repo.
`RUN_TOKEN` (bearer-gates `POST /run`) is the second Worker secret.

## The model + call

`gemini-2.5-flash` (fast; ~15 RPM / 1500 req/day free, so a daily cron is ~1/day).

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}
{ "contents": [{ "parts": [{ "text": "<prompt>" }] }] }   → candidates[0].content.parts[0].text
```

## Deploy — emitted CI (push to main)

`greenlight add` emits `.github/workflows/deploy-<name>.yml`. On a push to main that touches
`tools/<name>` it: creates the KV namespace (find-or-create in CI), deploys the Worker (cron +
`custom_domain`), sets `GEMINI_API_KEY` + `RUN_TOKEN` Worker secrets from GitHub secrets, seeds the
first run, and verifies. The only manual setup is **adding those two GitHub secrets**. `wrangler.toml`
carries the cron + KV binding + per-env `custom_domain`; no Terraform. (Local: `wrangler deploy --env prod`.)

## Surface + verify

| route | purpose |
|---|---|
| `scheduled()` | the cron: prompt Gemini → `STATE.put(today, text + metadata)` |
| `GET /` | latest output (public, read-only) |
| `GET /status` | `{ ok, lastRun, model, preview }` — the **api-mode verify** target |
| `POST /run` | force a run — **bearer-gated** (`RUN_TOKEN`); lets deploy/verify seed the first output |

`verify.config.ts` hits `/status` and asserts `ok` + a recent run. (Output *quality* is a future
`eval` mode — LLM-judged.)

## Gotchas
- **KV namespace as code (no manual id).** The deploy workflow does a **find-or-create** on the KV
  namespace in CI and binds it — the `wrangler.toml` id stays a placeholder, never hand-filled.
- **Account id from a scoped token.** `add` resolves the Cloudflare account id into `wrangler.toml`
  so wrangler skips the `/memberships` call a scoped token can't make (see provider-cloudflare).
- **Seed before verify.** The first cron may not have fired at deploy time, so `/status` would
  (correctly) report no run — the deploy step `POST /run`s once to seed *before* verifying. Don't
  reorder these.
- **No keepalive.** The cron *is* the heartbeat and the edge Worker is always-available — never add
  an agent to `module.keepalive.targets_json`.

## Safety envelope
Low-stakes / read-only first agents (generate → store → serve, no destructive external actions);
bearer on `/run`; cron frequency far under the free-tier daily limit; key secret-only, never echoed.
