# `bench/models.json` and `bench/budget.json`

JSON cannot carry comments, so the provenance of both files is recorded here (vision 06 §4.8,
08 §10.5–§10.6, ADR-20).

## Models

| role | entry | id | fallback |
|---|---|---|---|
| maintainer, proposer | frontier | `gemini-3.8-flash` | `gemini-3.6-flash` |
| judge | small | `gemini-3.6-flash` | — |

`temperature` is 0.2 (06 §4.8 "Determinism"). Both ids must be listed by `models.list`.
`checkModels()` (`packages/wiki/src/llm/models.ts`) checks this. Both ids were listed on
2026-11-01.

### Free-tier limits (`rpm`, `rpd`, `tpm`)

Recorded value: **5 RPM, 20 RPD and 250,000 TPM for each model.**

These values have **not been verified against a Google-published table.** The sources checked on
2026-11-01:

- Google's official page is https://ai.google.dev/gemini-api/docs/rate-limits (last updated
  2026-10-28 UTC). It publishes no per-model free-tier numbers. It says to view a project's active
  limits in AI Studio (https://aistudio.google.com/rate-limit), which needs a signed-in session.
- A third-party copy of the AI Studio free-tier table lists Gemini 3.8 Flash and Gemini 3.6 Flash
  at 5 RPM, 250,000 TPM and 20 RPD each. It also lists 10 RPM and 500 RPD for the Flash-Lite
  models. Source: https://www.scriptbyai.com/gemini-api-free-tier-limits/.
- A developer-forum post reports the same 20 RPD cap for 3.8 Flash:
  https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609.

The conservative default for unverified limits would be 5 RPM and 100 RPD. The reported 20 RPD is
lower than that, so the lower value is recorded. Rate limits are per project, not per key. Daily
quotas reset at midnight Pacific time, which the `RateLimiter` uses as its day key.

Replace these values with the verified ones from the fact page `fact/gemini-free` once it is
seeded (08 §10.6, 15 §5).

## Budget

```
monthlyUsd 0, perGateMaxUsd 0      free tier: the dollar caps stay at 0 (ADR-20)
perGateMaxRollouts 48              = 4 tasks × 3 runs × 2 models × 2 modes
perGateMaxRequests 480             = 48 rollouts × 10 requests per rollout
splitAcrossDays true               the gate cannot fit in one day's rpd (below)
```

- **Requests per rollout.** A rollout makes at most 10 HTTP requests. The ReAct loop's
  `maxSteps` should be 10 or lower. Retries and fallback attempts also count against the budget,
  because `RequestBudget` counts every HTTP attempt.
- **Days.** Each model runs half the rollouts (24 × 10 = 240 requests). At 20 RPD per model that
  is about 12 days per gate in the worst case. The two models draw on separate quotas, so they can
  run in parallel. Fallback-served calls draw on the small model's quota, and the gate cannot use
  those rollouts anyway (06 §4.8).
- **Shortening the gate.** Rollouts usually finish in fewer than 10 requests. Beyond that, a gate
  can be made shorter by running fewer runs per task, or by verifying higher free-tier limits.
  Moving to a paid tier, which is configured here, also works.
