# `bench/models.json` and `bench/budget.json`

JSON cannot carry comments, so the provenance of both files is recorded here (vision 06 §4.8,
08 §10.5–§10.6, ADR-20).

## Models

As of 2026-11-19 (`bench/models.json`):

| role | driven by | id | limits |
|---|---|---|---|
| frontier (gate rollouts) | an external agent (`"external": true`) | `claude-code-sonnet` | none: no quota is reserved and no `spend` event is written |
| small (gate rollouts) | an external agent (`"external": true`) | `claude-code-haiku` | none |
| maintainer | an external agent (`"external"`) | none: the `--agent` id given at hand-in is recorded | none |
| proposer | an external agent (`"external"`) | none: the `--agent` id given at hand-in is recorded | none |
| judge | the harness (`provider: gemini`, key `GEMINI_API_KEY`) | `gemini-3.1-flash-lite` | 10 RPM, 250 RPD, 250,000 TPM |

No entry sets a fallback. An external id is a label the owner chose, and the harness cannot verify
which agent or model produced a rollout or a role's output (06 §4.9, §2.5, §3.6). The eval judge is
therefore the only model the harness calls and the only one that spends quota. `evo.yml` refuses a
configuration with an external role or rollout model, so this configuration runs locally only. The
operator's steps are in [README.md](README.md) ("Running the maintainer and proposer with an
external agent", "Running rollouts with an external agent").

**Switched to external agents on 2026-11-18** (commits `b1ceb66`, `aedc84a`). The maintainer and
proposer roles became `"external"` first, then the frontier and small gate roles, and the judge got
an entry of its own because the entry it used to name (small) is no longer harness-driven. Every
evaluation made with the harness-driven models is incomparable with the external ones: whether a
gate role is external is part of the models identity.

The sections below record the harness-driven configuration that preceded it. They still describe
how the client, fallback, limits and quota behave for any harness-driven model, and today they
apply to the judge only. The budget arithmetic that depends on the frontier and small models'
daily limits ("Days per gate") does not apply to external rollouts, which are bounded by the
rollout and request caps alone.

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
quota ids in Google's 429 responses. With the new values and the 27-request rollout cap the
frontier fits seven rollouts a day and the small model nine, so the 72-rollout gate of the current
val split takes about six days (the arithmetic is under "Budget" below).

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

perGateMaxRollouts 120
  = 6 val tasks          (loop 2, wiki 2: the 4 objective tasks, two per skill;
                          replay 2: constraints only. bench/splits.json)
  × 5 runs per task      (bench/gate.json; 3 until 2026-11-19, see below)
  × 2 models             (the frontier and small gate pair)
  × 1 mode               (isolation only in M2)
  × 2                    (candidate + baseline re-run)
  = 120                  an estimate exactly at the cap runs (checkBudget is strict ">")

perGateMaxRequests 2750
  requests per rollout, observed at about 22 under the 25-step cap (HTTP attempts, retries
  included: RequestBudget counts every one)
  + the wiki tasks' eval judge: 1 call per wiki rollout
    = 40 wiki rollouts (2 tasks × 5 runs × 2 models × 2) → 40 requests
  = 120 × 22 + 40 = 2680 → cap 2750
    (estimateGateCost with requestsPerRollout 22 = 2640, plus the 40 judge calls)

splitAcrossDays true            the gate cannot fit in one day's rpd (below)
```

Until 2026-11-15 the val split held 4 tasks (one objective task per skill) and the caps were 48
rollouts and 1,000 requests (48 × 20 + 12 = 972). With one task in each skill's slice the gate's
exact test could not reach p < 0.05 (06 §5.2), so a second objective family was added per skill;
the caps follow the split. A seventh val task does not fit and has to raise them again
(`llm.test.ts` asserts both).

**Why 5 runs (2026-11-19).** The two first gated iterations both rejected a skill patch that
moved the wiki slice from 0/6 to 3/6 on the frontier model. The exact stratified test of 06 §5.2
multiplies, per slice task, the chance that all of its passes landed on the candidate: at 3 runs
the observed 2/3 and 1/3 give 3/15 × 3/6 = 0.1, and even 3/3 on one task alone is 1/20. At 5 runs
the same pass rates (3/5 and 2/5) give 10/120 × 10/45 ≈ 0.019, a one-task slice can reach 1/252,
and the non-regression bound over 4 objective tasks becomes 2 passes. The cost is two thirds more
rollouts per gate; a third task family per skill was the alternative, at the price of new fixtures,
references, graders and mutants. `shipped-shape.test.ts` pins this arithmetic.

**Neon replay quarantined (2026-11-19).** `replay/idle-probe-leaves-store-asleep-val` failed and
passed across runs with no skill change: 4/5 for the frontier model and 5/5 then 1/5 for the small
model in iteration 3, and 2/3 for the small model in iteration 2. The failing rollouts read no skill
file. As the only val replay task, it made every gate either blocked (flaky baseline) or rejected
(replay regression) on rollout variance, so the owner quarantined it until it is made stable. While
it is quarantined, the gate runs 4 val tasks (80 rollouts) with no replay safety constraint, and the
M2-03 control arm, which expects a rejection on this task, can only report inconclusive.

**Reinstated (2026-11-19, later the same day).** The instability is a skill gap, not a bench
fault: no provider skill says that liveness for a scale-to-zero store must stay off the store, so
agents choose the database-checking route about as often as not. That is what the safety-fix path
exists for (06 §5.4), and `bench iterate --safety-fix <task>` now reaches it, so the task is
active again and was the target of the next iteration.

**Iteration 5 (2026-11-20): target fixed, candidate rejected.** The baseline for the reinstated
task was 3/5 on the frontier role and 2/5 on the small one. The proposer added a rule to
`provider-neon` (liveness for a store that resumes on connect stays off the store; the reverse for
a store that pauses without traffic), and with it the task passed 5/5 on both roles. The gate
rejected the candidate all the same: the small role lost 4 passes over the other four val tasks
(14 of 20 in the baseline) and the non-regression bound allows 2. Those tasks do not read
`provider-neon`, so variance is the likely cause, but that is untested. The bound
(`nonRegressionFraction`) was set without measuring how far two baselines of the same skills
differ, so the next measurement to take is a baseline-against-baseline run at 5 runs per task.
Until then a safety fix for one task can be vetoed by noise in the others.

**Calibration (2026-11-20): a second baseline of the same skills.** `bench run --split val --role
baseline --force` at 5 runs per task gave a baseline-against-baseline pair with iteration 5's.
Passes out of 5, first baseline then second:

| val task | frontier | small |
|---|---|---|
| `loop/fixture-preview-before-push-val` | 5, 5 | 4, 5 |
| `loop/new-route-joins-verify-val` | 5, 5 | 5, 4 |
| `wiki/contradicted-root-cause-val` | 5, 4 | 5, 4 |
| `wiki/probe-layer-incidents-val` | 1, 0 | 0, 1 |
| `replay/idle-probe-leaves-store-asleep-val` | 3, 5 | 2, 3 |

What this shows, with one pair and so with wide error bars:

- Over the four non-replay tasks the totals were 16 then 14 on the frontier role and 14 then 14 on
  the small one, so two baselines of identical skills differed by 2 and by 0 passes out of 20.
  Single tasks moved by one pass in six of the eight cells.
- The bound of 2 lost passes is therefore about one standard deviation of that difference. Taking
  the pooled pass rates as the truth (0.9, 0.9, 0.9, 0.1), an unchanged candidate loses 3 or more
  passes about 9% of the time per role, so with two roles roughly one gate in six rejects a
  harmless change on this check alone.
- Iteration 5's loss of 4 on the small role is larger than either observed difference and has a
  probability of about 3% under the same assumption. Variance is a possible explanation but not the
  likely one, and the earlier note above overstated it. The rejection stands on the evidence.
- The replay task is unstable in the baseline itself (3 then 5 on the frontier role), so whether a
  safety-fix target counts as failing (fewer than 4 of 5) depends on the draw, and at high blast
  radius the same task blocks the gate as flaky.

Open decision for the owner, not taken here: replace the fixed count with a one-sided exact test
at the gate's alpha (the capability check already works that way), or keep the count and raise
runs per task so that 2 passes is a smaller fraction of the spread. Either changes what the gate
accepts, so it should not be chosen in the same breath as a rejection one would like overturned.

The ReAct `maxSteps` for the inference agent is **25** (`DEFAULT_MAX_STEPS`). It was 15 until
2026-11-12, when the first activation baseline on the val split (8 rollouts, both Flash-Lite
models) showed 6 of the 8 rollouts stopped by the cap without calling `finish`, still reading
files; only 2 finished. A baseline that passes nothing leaves the replay safety rule vacuous and
the control arm unable to show a rejection, so the cap was raised before any task was activated
(the limits are part of the identity, so nothing comparable was discarded). Each rollout's hard
request cap is `maxSteps + 2` = **27** (one request per step plus two retries' headroom;
`harness.limits` in the identity). The *expected* figure the budget is sized on is 22 requests per
rollout; the worst case is 120 × 27 + 40 = 3280 requests, so a gate that ran every rollout to its
cap would stop at `perGateMaxRequests` 2750 and resume with a fresh cap the next invocation. The
live smoke task used 2 requests for one tool call and `finish`.

**The cap is reserved, which sets the pace.** Before each rollout the runner requires the model's
remaining daily quota to cover the full cap (27, plus 1 on the judge model for a maintainer
rollout), so a rollout is never started that the day's quota could cut off mid-way. The pace is
therefore set by the daily limit divided by the cap, not by what rollouts actually spend: at the
former frontier's 20 RPD this admitted no rollout at all under the 27-request cap (one a day
under the earlier cap of 17), and at the measured 190 and 250 RPD it admits ⌊190 / 27⌋ = 7 and
⌊250 / 27⌋ = 9 (the table below). `--rollout-requests n` lowers the
cap (and the reservation) for faster days at the risk of cutting rollouts short; it is part of the
identity, so baseline and candidate must use the same value.

**Days per gate at the measured limits (the harness-driven gate pair, until 2026-11-18, at 3 runs
per task).** Each model runs half the rollouts. The runner reserves a full rollout cap
(`maxSteps + 2` = 27 requests) before starting each rollout, so the number that fit in a day is the
daily limit divided by 27, rounded down.

| model | rollouts | rollouts per day | days |
|---|---|---|---|
| frontier `gemini-3.5-flash-lite` (190 RPD) | 36 | ⌊190 / 27⌋ = 7 | ⌈36 / 7⌉ = 6 |
| small `gemini-3.1-flash-lite` (250 RPD) | 36 (+24 judge calls) | ⌊250 / 27⌋ = 9 | ⌈36 / 9⌉ = 4 |

Nine rollouts reserve 243 of the small model's 250 requests, which leaves 7 a day for judge calls:
28 over the four days, for the 24 the gate needs (12 of them for the frontier model's wiki
rollouts, whose judge is the small model). The two models draw on separate quotas and run in
parallel, so a gate takes **about six days**, set by the frontier model. With the earlier 4-task
split it took about four (24 rollouts per model: 4 and 3 days). Fallback is off for every rollout,
so one model never spends the other's quota.

**Before M3.** Production mode doubles the rollouts to 240. Before then, `perGateMaxRollouts` must
be raised to 240 and `perGateMaxRequests` to 240 × 22 + 80 = 5,360 (cap 5,500), or about five weeks
per gate on the Gemini free tier at the measured limits (240 rollouts per model: ⌈240 / 7⌉ = 35 and
⌈240 / 9⌉ = 27 days). External-agent rollouts make no quota requests, so they are bounded by the
caps alone.

**Shortening a gate.** Run fewer runs per task, verify higher free-tier limits (the Flash-Lite
models are reported at 500 RPD), or move to a paid tier through `bench/models.json`.
