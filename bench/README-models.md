# `bench/models.json` and `bench/budget.json`

JSON cannot carry comments, so the provenance of both files is recorded here (vision 06 §4.8,
08 §10.5–§10.6, ADR-20).

## Models

| role | entry | id | fallback |
|---|---|---|---|
| maintainer, proposer | frontier | `gemini-3.6-flash` | — |
| judge | small | `gemini-3.5-flash-lite` | — |

**Switched on 2026-11-04** (ADR-20 amendment, trigger 2). `gemini-3.8-flash`, the original
frontier, returned 502/503 on every attempt for four consecutive days (Nov 1–4). The most capable
model that kept answering, `gemini-3.6-flash`, became the frontier. `gemini-3.5-flash-lite`
answered probes and became the small model. Its limits were measured on 2026-11-12 (below). Every earlier evaluation is incomparable and was abandoned.

`temperature` is 0.2 (06 §4.8 "Determinism"). Both ids must be listed by `models.list` with
`generateContent` among their `supportedGenerationMethods`. `checkModels()`
(`packages/wiki/src/llm/models.ts`) checks this. A model that lists no methods counts as
unavailable, and a model the listing marks deprecated is reported in `deprecated`. Both ids were
listed on 2026-11-01.

### Which model served a call

`GenerateResult.servedBy` is the API's `modelVersion` when the response carries one, and otherwise
the id of the endpoint that was called. `requested` keeps the configured id, and `endpoint` keeps
the id whose endpoint was called. A live call on 2026-11-01 to `gemini-3.6-flash` returned
`modelVersion: "gemini-3.6-flash"`, so today `servedBy` equals the configured id. If Google
repoints the alias, `modelVersion` changes. The gate policy compares `servedBy` with the outcome's
`model`, so a drifted alias makes the rollout ungateable in the same way a fallback does. This is
deliberate, because the baseline identity pins the model.

### Fallback is off for gate and baseline rollouts

The client retries a transient error (429, 5xx, timeout) twice with backoff. By default it then
makes one round on the fallback model. **Gate and baseline rollouts MUST construct their client
with `allowFallback: false`**, or pass it on each call. There are two reasons:

- A fallback-served rollout is invalid for gating (06 §4.8). Running it gains nothing.
- The fallback is the small model. Calls served by it draw on the small model's 20 RPD, which the
  gate also needs for its own half of the rollouts.

With fallback off, a transient failure that survives the retries throws `FallbackDisabledError`.
In `runReact` this surfaces as an error of kind `deferred`. The error is transient and
resumable. The runner records the rollout as pending and runs it on a later day, which is safe
because rollouts are independent and the baseline identity pins every input. Fallback stays on
by default for the maintainer and proposer outside a gate, where a working answer matters more
than model identity.

### Free-tier limits (`rpm`, `rpd`, `tpm`)

Recorded values, **measured on 2026-11-12** (fact page `wiki/facts/gemini-free.md`):
`gemini-3.6-flash` at **5 RPM and 20 RPD**, both confirmed by the quota ids Google returned in its
429 responses, and `gemini-3.5-flash-lite` at **10 RPM and 190 RPD**, lower bounds from 190
requests that never hit a 429. TPM stays at 250,000 for both (not probed). With these values the
small model fits about eleven 17-request rollouts per day, so its half of a gate finishes in about
three days. The frontier still admits one rollout per day, and it sets the gate's length at about
24 days.

The history below records how the earlier, unverified 5 RPM / 20 RPD default for both models was
chosen.

These values were re-checked on 2026-11-01 and **still could not be verified against a
Google-published table**:

- Google's official page is https://ai.google.dev/gemini-api/docs/rate-limits (last updated
  2026-10-28 UTC). It publishes no per-model free-tier numbers. It says to view a project's active
  limits in AI Studio. Its only free-tier entry, in the spend-based table, reads "N/A".
- The AI Studio page (https://aistudio.google.com/rate-limit) redirects to a Google sign-in, so it
  cannot be read without an account session.
- A third-party copy of the AI Studio free-tier table lists Gemini 3.8 Flash and Gemini 3.6 Flash
  at 5 RPM, 250,000 TPM and 20 RPD each. It also lists 10 RPM and 500 RPD for the Flash-Lite
  models. Source: https://www.scriptbyai.com/gemini-api-free-tier-limits/.
- A developer-forum post reports the same 20 RPD cap for 3.8 Flash:
  https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609.

The conservative default for unverified limits would be 5 RPM and 100 RPD. The reported 20 RPD is
lower than that, so the lower value is recorded. Rate limits are per project, not per key. Daily
quotas reset at midnight Pacific time, which the `RateLimiter` uses as its day key.

The fact page `fact/gemini-free` was seeded on 2026-11-12 and now governs these values (08 §10.6,
15 §5).

### The daily count survives processes

By default a `RateLimiter` counts only in memory, so each new process would start the day at zero.
`FileQuotaStore` (`packages/wiki/src/llm/quota.ts`) keeps the count in
`.greenlight/quota/<model>.json`, which is gitignored. The limiter re-reads and increments that
file under a lock on every request, so two `bench run`s on one machine share one quota.
`seedQuotaFromLedger` raises today's count to the requests recorded in the ledger's `spend`
events, so a fresh CI runner starts from the real spend. `bench run` writes one `spend` event per
model per invocation and names the model (`spend.model`), so each event is charged to that model's
quota only. An event without a model (a ledger written before the field existed) counts against
every model: a conservative upper bound that can stop a gate early, but cannot overspend.

## Budget

The budget is sized for **the first M2 gate**. In that gate only isolation mode runs, because
production mode lands in M3 (14, M1-05: "isolation mode only"). The baseline is re-run in the same gate (06 §1.5).

```
monthlyUsd 0, perGateMaxUsd 0   free tier: the dollar caps stay at 0 (ADR-20)

perGateMaxRollouts 48
  = 4 val tasks          (loop 1, replay 2, wiki 1: bench/splits.json)
  × 3 runs per task
  × 2 models             (the frontier and small gate pair)
  × 1 mode               (isolation only in M2)
  × 2                    (candidate + baseline re-run)
  = 48                   an estimate exactly at the cap runs (checkBudget is strict ">")

perGateMaxRequests 600
  requests per rollout, estimated at 12:
    ~9 model turns       a replay or loop task reads 3–4 files, writes 1–2,
                         runs the check 1–2 times and calls finish
    +3 retry headroom    RequestBudget counts every HTTP attempt, retries included
  + the wiki task's eval judge: 1 call per wiki rollout
    = 12 wiki rollouts (1 task × 3 runs × 2 models × 2) → 12 requests
  = 48 × 12 + 12 = 588 → cap 600  (estimateGateCost with requestsPerRollout 12.25 = 588)

splitAcrossDays true            the gate cannot fit in one day's rpd (below)
```

The ReAct `maxSteps` for the inference agent is **15** (`DEFAULT_MAX_STEPS`): the live smoke showed
10 too tight for the replay tasks. Each rollout's hard request cap is `maxSteps + 2` = **17**
(one request per step plus two retries' headroom; `harness.limits` in the identity). 12 per
rollout stays the *expected* figure the budget above is sized on, but it is no longer an upper
bound: the worst case is 48 × 17 + 12 = 828 requests, so a gate that ran every rollout to its cap
would stop at `perGateMaxRequests` 600 and resume with a fresh cap the next invocation. The live
smoke task used 2 requests for one tool call and `finish`.

**The cap is reserved, which sets the pace.** Before each rollout the runner requires the model's
remaining daily quota to cover the full cap (17, plus 1 on the judge model for a maintainer gate
rollout), so a rollout is never started that the day's quota could cut off mid-way. At 20 RPD
that admits **one rollout per model per day** (a second one only if the first used 3 requests or
fewer), whatever the rollout actually spends: 20 − ~9–12 used leaves 8–11, below 17. The days
table below therefore understates the pace: a gate's 24 rollouts per model take about **24 days**
at 20 RPD (the judge calls fit in the small model's leftover). `--rollout-requests n` lowers the
cap (and the reservation) for faster days at the risk of cutting rollouts short; it is part of the
identity, so baseline and candidate must use the same value.

**Days per gate at 20 RPD per model.** Each model runs half the rollouts. Because the runner
reserves a full rollout cap (`maxSteps + 2` = 17 requests) before starting each rollout, only one
rollout fits per model per day, however few requests it then spends.

| model | rollouts | days at 20 RPD (one rollout per day) |
|---|---|---|
| frontier `gemini-3.6-flash` | 24 | 24 |
| small `gemini-3.5-flash-lite` | 24 (+12 judge calls, which fit in the leftover) | 24 |

The two models draw on separate quotas and run in parallel, so a gate takes **about 24 days**.
`--rollout-requests 10` fits two rollouts per model per day (about 12 days), at the cost of cutting
rollouts short. It is part of the identity, so it must be used for the whole evaluation. Fallback is
off for every rollout, so one model never spends the other's quota.

**Before M3.** Production mode doubles the rollouts to 96. Before then, `perGateMaxRollouts` must
be raised to 96 and `perGateMaxRequests` to 96 × 12 + 24 = 1,176, or about 48 days per gate at
20 RPD under one-rollout-per-day pacing.

**Shortening a gate.** Run fewer runs per task, verify higher free-tier limits (the Flash-Lite
models are reported at 500 RPD), or move to a paid tier through `bench/models.json`.
