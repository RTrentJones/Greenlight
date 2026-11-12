---
id: fact/gemini-free
type: fact
title: Gemini API free tier (the bench's model provider)
updated: 2026-11-12
status: confirmed
provider: gemini
verified: 2026-11-12
source: ["https://aistudio.google.com/docs/rate-limits", "https://ai.google.dev/gemini-api/docs/rate-limits"]
cardRequired: false
idle: unaffected
quotas:
  - { key: flash-rpm, label: "gemini-3.6-flash requests per minute", limit: 5, unit: "requests/minute", scope: project }
  - { key: flash-rpd, label: "gemini-3.6-flash requests per day", limit: 20, unit: "requests/day", scope: project }
  - { key: flash-lite-rpm, label: "gemini-3.5-flash-lite requests per minute (measured lower bound)", limit: 10, unit: "requests/minute", scope: project }
  - { key: flash-lite-rpd, label: "gemini-3.5-flash-lite requests per day (measured lower bound)", limit: 190, unit: "requests/day", scope: project }
---
Google publishes no per-model free-tier table, so these values were measured on 2026-11-12 with
one-token `generateContent` probes against the project the bench's key belongs to. Quotas are per
project and per model, and the daily count resets at midnight Pacific time.

For `gemini-3.6-flash`, both limits were confirmed from the API's own `QuotaFailure` details. At
5-second spacing the eighth request returned 429 with
`GenerateRequestsPerMinutePerProjectPerModel-FreeTier` and `quotaValue: "5"`. At 13-second
spacing the day's twentieth request was the last to succeed, and the next returned 429 with
`GenerateRequestsPerDayPerProjectPerModel-FreeTier` and `quotaValue: "20"`.

`gemini-3.5-flash-lite` never returned a 429. It served 190 consecutive requests in one day at
5-second spacing (about 10 per minute including latency). Both of its values are therefore lower
bounds: the true limits are at least that high and may be higher (a third-party copy of the AI
Studio table lists 10 RPM and 500 RPD). The recorded numbers are the ones observed to work, so a
limiter configured from them cannot cause a 429.

`bench/models.json` copies these values (08 §10.5). Re-measure when a model id changes or a 429
names a quota lower than the one recorded here.
