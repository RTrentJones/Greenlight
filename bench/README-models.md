# `bench/models.json` and `bench/budget.json`

JSON cannot carry comments, so the provenance of both files is recorded here (vision 06 §4.8,
08 §10.5–§10.6, ADR-20).

## Models

| role | entry | id | fallback |
|---|---|---|---|
| maintainer, proposer | frontier | `gemini-3.5-flash-lite` | — |
| judge | small | `gemini-3.1-flash-lite` | — |

**Switched again on 2026-11-12** (ADR-20 amendment, trigger 2). The measured limits put
`gemini-3.6-flash` at 20 RPD, one 17-request rollout a day, and no bench task had a baseline yet,
so the first M2 gate projected far past 30 days. The frontier was the only bottleneck, so it was
replaced: `gemini-3.5-flash-lite` became the frontier and `gemini-3.1-flash-lite`, measured the
same day, became the small model. The maintainer and proposer follow the frontier role. Both ids
passed `bench models --check` and the live smoke test on 2026-11-12.

**Earlier switch, 2026-11-04** (ADR-20 amendment, trigger 2). `gemini-3.8-flash`, the original
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
`gemini-3.5-flash-lite` at **10 RPM and 190 RPD** and `gemini-3.1-flash-lite` at **10 RPM and 250
RPD**, lower bounds from runs of 190 and 250 requests that never hit a 429. TPM stays at 250,000
(not probed). The former frontier, `gemini-3.6-flash`, measured 5 RPM and 20 RPD, both named by the
quota ids in Google's 429 responses. With the new values and the 27-request rollout cap the frontier fits
seven rollouts a day and the small model nine, so a 48-rollout gate takes about four days instead
of about 24.

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

perGateMaxRequests 1000
  requests per rollout, estimated at 20:
    ~17 model turns      the 2026-11-12 activation baseline: most rollouts read 8–12 files
                         before acting, and 6 of 8 used all 15 steps
    +3 retry headroom    RequestBudget counts every HTTP attempt, retries included
  + the wiki task's eval judge: 1 call per wiki rollout
    = 12 wiki rollouts (1 task × 3 runs × 2 models × 2) → 12 requests
  = 48 × 20 + 12 = 972 → cap 1000  (estimateGateCost with requestsPerRollout 20.25 = 972)

splitAcrossDays true            the gate cannot fit in one day's rpd (below)
```

The ReAct `maxSteps` for the inference agent is **25** (`DEFAULT_MAX_STEPS`). It was 15 until
2026-11-12, when the first activation baseline on the val split (8 rollouts, both Flash-Lite
models) showed 6 of the 8 rollouts stopped by the cap without calling `finish`, still reading
files; only 2 finished. A baseline that passes nothing leaves the replay safety rule vacuous and
the control arm unable to show a rejection, so the cap was raised before any task was activated
(the limits are part of the identity, so nothing comparable was discarded). Each rollout's hard
request cap is `maxSteps + 2` = **27** (one request per step plus two retries' headroom;
`harness.limits` in the identity). The *expected* figure the budget is sized on is 20 requests per
rollout; the worst case is 48 × 27 + 12 = 1308 requests, so a gate that ran every rollout to its
cap would stop at `perGateMaxRequests` 1000 and resume with a fresh cap the next invocation. The live
smoke task used 2 requests for one tool call and `finish`.

**The cap is reserved, which sets the pace.** Before each rollout the runner requires the model's
remaining daily quota to cover the full cap (17, plus 1 on the judge model for a maintainer gate
rollout), so a rollout is never started that the day's quota could cut off mid-way. The pace is
therefore set by the daily limit divided by the cap, not by what rollouts actually spend: at the
former frontier's 20 RPD this admitted one rollout a day, and at the measured 190 and 250 RPD it
admits 11 and 14 (the table below). `--rollout-requests n` lowers the
cap (and the reservation) for faster days at the risk of cutting rollouts short; it is part of the
identity, so baseline and candidate must use the same value.

**Days per gate at the measured limits.** Each model runs half the rollouts. The runner reserves a
full rollout cap (`maxSteps + 2` = 27 requests) before starting each rollout, so the number that fit
in a day is the daily limit divided by 27, rounded down.

| model | rollouts | rollouts per day | days |
|---|---|---|---|
| frontier `gemini-3.5-flash-lite` (190 RPD) | 24 | 7 | 4 |
| small `gemini-3.1-flash-lite` (250 RPD) | 24 (+12 judge calls) | 9 | 3 |

The two models draw on separate quotas and run in parallel, so a gate takes **about four days**.
Before 2026-11-12, with `gemini-3.6-flash` at 20 RPD, the same gate took about 24 days. Fallback is
off for every rollout, so one model never spends the other's quota.

**Before M3.** Production mode doubles the rollouts to 96. Before then, `perGateMaxRollouts` must
be raised to 96 and `perGateMaxRequests` to 96 × 12 + 24 = 1,176, or about 48 days per gate at
20 RPD under one-rollout-per-day pacing.

**Shortening a gate.** Run fewer runs per task, verify higher free-tier limits (the Flash-Lite
models are reported at 500 RPD), or move to a paid tier through `bench/models.json`.
