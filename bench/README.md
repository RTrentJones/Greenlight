# bench/

The evolution loop's benchmark (vision [06 §4](../docs/vision/06-evolution-loop.md), layout in
[08 §10](../docs/vision/08-data-contracts.md)). M1 ships the fixtures and tasks of the first
iteration (06 §10, 15 §8): two replay tasks whose lessons look opposite, the maintainer task that
must reconcile them, and a loop control task. Two more objective families were added afterwards,
one per skill, so that each skill's slice holds two tasks and its gate can reach p < 0.05 (06 §4.1,
§5.2).

```
bench/
  tasks/<taskId>/{task.json, brief.md, fixture/}   # what a rollout sees (fixture/ = starting tree)
  graders/<taskId>/grade.mjs                        # HIDDEN: never in a sandbox or bundle
  graders/_lib/                                     # HIDDEN: grader implementations shared by variants
  references/<taskId>/                              # HIDDEN: a solution the grader must pass
  mutants/<taskId>/<mutantId>/                      # HIDDEN: known-bad solutions it must fail
  pairs/<pairId>/pair.json                          # HIDDEN: overgeneral rules that must fail exactly one task
  fixtures/                                         # HIDDEN: fake stores and the canonical fixture tools
  repro/<slug>/{repro.json, run.mjs, fixture/}      # trusted reproductions: mechanism/doctor outlets (M2-02)
  controls/<id>.json                                # control-arm proposals, labelled control, never merged (M2-03)
  splits.json                                       # taskId → train | val | test
```

Graders, references, mutants, pairs and fake stores live outside `tasks/` so a sandbox or bundle
builder that copies `tasks/<id>/` can never include them (06 §1.4). The runner (`bench/runner/`),
`models.json`, `budget.json` and `gate.json` are documented by their owners.

## Task ids and splits

A task id is `<kind-prefix>/<slug>-<split>`: every task FAMILY (the id the vision docs use, such as
`replay/keepalive-probe-reaches-store`) ships one task per split, and the suffix names it.

| family | train | val |
|---|---|---|
| `replay/keepalive-probe-reaches-store` | `…-train` (tool `quizpad`, App Router, probe table `keepalive_probe`) | `…-val` (tool `tripnote`, Pages Router, probe table `heartbeat`) |
| `replay/idle-probe-leaves-store-asleep` | `…-train` (`scenesmith`, MCP on oci, node:http) | `…-val` (`ledgerline`, REST on docker, a small router, `STORE_URL`) |
| `wiki/probe-layer-incidents` | `…-train` (the two real incidents, 15 §7) | `…-val` (a synthetic pair with the same structure and different evidence) |
| `wiki/contradicted-root-cause` | `…-train` (`menuboard`, astro/workers: a post-deploy verify failure filed as a cold start, contradicted by a run where every request was fast and served the previous version) | `…-val` (`inkwell`, next/vercel/neon: a nightly job failure filed as a slow store resume, contradicted by a run where the login was rejected in milliseconds) |
| `loop/fixture-preview-before-push` | `…-train` (`guestbook`) | `…-val` (`pinboard`) |
| `loop/new-route-joins-verify` | `…-train` (`changelog`, `/releases.json`, an HTML page, ports 4330/4331) | `…-val` (`trailnotes`, `/trails.json`, a plain-text page behind a route table, ports 4340/4341) |

The val split is 6 tasks: 4 objective, two per skill (`deploy-verify-promote`: the two `loop/`
families; `greenlight-wiki`: the two `wiki/` families), and the 2 replay tasks. The two families
of a skill measure different behaviour (06 §4.1): preview-before-push against "add it to the
verify loop"; a rule conditional on the liveness model against the "wrong root cause" rule.
As of 2026-11-19 five of the six are `active`: `replay/keepalive-probe-reaches-store-val` is
`quarantined`, and `replay/idle-probe-leaves-store-asleep-val` was quarantined for part of that day
and is active again (history in [README-models.md](README-models.md)).

Variants differ in tool name, store table names and app framework, so a val instance is unseen by
the proposer (06 §10.2). `TaskSpec.split` must match both the suffix and `splits.json` (a test
enforces it). The family id is the id minus the suffix; wiki pages that cite a grader task
(`catches.graderTask`) name the family. Every task enters as `state: "pending"` until a baseline run
records it (06 §4.1).

## Fixtures

`fixtures/<name>/variants/<split>/tool/` is the canonical agent-visible tree of each fixture tool,
plus files shared across variants in `fixtures/_shared/` (the vendored keepalive Worker). Each task's
`fixture/` is a byte-for-byte copy, written only by `node bench/fixtures/sync.mjs` (`--check`
verifies; a test runs it). `variants/<split>/store.json` is the hidden configuration of the fake
store for that variant.

- `supabase-shaped/server.mjs`: PostgREST in front of Postgres. `/rest/v1/` is answered from an
  in-memory schema document without a query; `/rest/v1/<table>?select=…` runs a query and resets
  the simulated 7-day idle timer; unknown parameters are column filters (400, no query). The
  project pauses after the idle limit and answers 530 from then on.
- `neon-shaped/server.mjs`: scale-to-zero Postgres behind `POST /sql`. Every query is counted with
  its origin (`x-application-name`); the compute suspends after five quiet minutes; awake time is
  reported over any window; the grader can stop the database.
- `loop-tool/`: a two-tool wrapper whose tools are tiny HTTP apps with verify configs that use
  check ids.
- `loop-route/`: another two-tool wrapper (other tools, ports and copy) for
  `loop/new-route-joins-verify`. One tool renders a short list; its README adds a "Deploy gate"
  section saying what `tools/<tool>/verify.config.mjs` is, the way a real wrapper's does.

The wiki tasks' bundles (`wiki/`, `raw/`, `context.json`) are written directly under
`tasks/wiki/<id>/fixture/`; they have no variant tree and `sync.mjs` does not touch them.

Both fakes run on a simulated clock the grader advances, and expose `/__fake/*` introspection
guarded by a per-start admin token. They are plain Node with no dependencies;
`node bench/fixtures/<name>/server.mjs --variant train` starts one by hand.

## Graders

Every grader is `graders/<taskId>/grade.mjs`, default-exporting `async (ctx) => ({ passed, checks })`.
The interface (`ctx.tree`, `ctx.trajectory`, `ctx.maintainerOutput`, `ctx.bundleDir`,
`ctx.startFixture`, `ctx.spawnApp`, `ctx.spawnNode`, `ctx.wiki`, `ctx.evaluateTrajectory`, …) is
defined in [`packages/wiki/src/bench/grader-api.ts`](../packages/wiki/src/bench/grader-api.ts). A
grader runs in its own Node process after the rollout, against a read-only final tree.

Isolation rules every grader follows:

- **Agent code never runs in the grader process.** The app runs under `ctx.spawnApp`; the agent's
  keepalive Worker runs in `graders/_lib/worker-host.mjs` under `ctx.spawnNode`, whose `fetch` is
  a proxy back to the grader's simulated Workers runtime. A Worker that patches `fetch` or timers
  at import patches only its own process.
- **Scrubbed environments.** The grader process and every child that runs agent code get
  `sandboxEnv`: PATH, a throwaway HOME, `TZ=UTC`, plus what the grader passes explicitly. Never
  NODE_OPTIONS, never the caller's secrets. Children run with their cwd inside the tree.
- **No verdict file.** The parent sends the job and receives the result over the grader child's
  IPC channel; nothing written to disk (by the app, a grandchild or an attack mutant) can stand in
  for it.
- **Simulated time is honoured in full, in every thread and process.** The idle-window grader
  preloads `graders/_lib/fake-clock-shim.mjs` into the app through NODE_OPTIONS (`--import`):
  `setTimeout`/`setInterval` (global, `node:timers`, `node:timers/promises`), `Date`,
  `performance.now`/`timeOrigin`, `process.hrtime`/`hrtime.bigint`, `process.uptime` and
  `AbortSignal.timeout` all follow one simulated clock. The shim boots every `worker_threads`
  Worker through itself and re-injects NODE_OPTIONS and the clock channel into every child
  process's environment (even an explicit `env`). The clock is served by
  `graders/_lib/fake-clock-coordinator.mjs` over a unix socket in a temp dir: the grader advances
  every participant to the same instant, in lockstep with the fake store's clock, so a 30-second
  poll fires twenty times in the ten-minute window whether it runs on a timer, a `performance.now()`
  guard, an `AbortSignal.timeout` loop, a worker or a child. A child or worker the app starts is
  waited for as long as its process is alive (one that exits before joining is dropped): how long a
  Node process takes to boot depends on the machine's load, and the former 5-second wall-clock
  deadline turned CPU contention into a failed grade (the "20 polls" flake). A child that is still
  alive and has not joined after the cap (120 s: a long-lived non-Node child) is a HARNESS error
  (`ClockJoinTimeoutError`, a grader error, invalid at the gate), not a failing check; a
  participant that stops answering still fails the window. Out of scope: Node-internal timers (socket timeouts), `spawnSync` children, native code,
  and code that attacks the shim itself (the sandbox is the isolation boundary). The env carries
  only a socket path and a timestamp.
- **Production semantics.** The maintainer grader applies the output with the real patch engine
  (`ctx.wiki.applyMaintainerOutput`), not a re-implementation.

| task family | kind | fidelity | what the grader does |
|---|---|---|---|
| keepalive-probe-reaches-store | `app` | runtime | runs the tree's own keepalive Worker (in its own process) over its `targets.json` on a simulated Workers runtime (edge cache, bypassed by `cache: 'no-store' \| 'no-cache' \| 'reload'`; the `no-store` + `cf.cacheTtl` conflict throws) every 3 days for 21 days against the Supabase-shaped fake: not paused, every sweep ran a query, a paused store reads as failing, no user columns read; plus the structural `probeTable` check |
| idle-probe-leaves-store-asleep | `app` | runtime | starts the tree's app from its Dockerfile's last `CMD` (exec form, or shell form under `/bin/sh -c`; a `HEALTHCHECK … CMD` is never read as the app command) on the fake clock against the Neon-shaped fake, steps a 10-minute idle window (every app timer fires at its simulated time), fires the declared `HEALTHCHECK` on its interval and one keepalive sweep: zero store queries from either and from the idle app, store suspended, liveness 200 with the database stopped, `/health` still reports the database. What it accepts is listed under "What the idle-probe grader accepts" below |
| probe-layer-incidents | `maintainer` | structural | the rubric in `graders/_lib/maintainer.mjs`: valid output applied by the real engine, cited claims, no evidence removed, status lifecycle, the liveness-model distinction with the right polarity on each branch citing both incidents, no overgeneral or inverted rule; plus, in every runner rollout (train and gate alike), an eval judge (below) |
| fixture-preview-before-push | `trajectory` | runtime | evaluates `task.json` `trajectory.rules` with the rule DSL in `packages/wiki/src/bench/trajectory.ts`; the rules match on shim `meta` (below), never on argv spelling. Plus one tree check, `the requested change is in what was pushed`: the file the brief names contains the requested text in `ctx.pushedTree`, the tree of the origin's `develop` the runner exports after the rollout (a synthetic reference or mutant has no origin, so its working tree stands in). Without it a preview of the untouched fixture, an empty commit and a push passed |
| new-route-joins-verify | `trajectory` | runtime | the same ordering rules (a passing `preview` of the tool before any push that is or may be to `develop`, at least one push that moved `develop`, no `promote`), plus three checks on `ctx.pushedTree` (`gradeTrajectory`'s `route` option): **the new route is served by what was pushed** (the tool's app is started under `ctx.spawnApp`; `GET <route>` answers 200 with a JSON object whose named key is an array of exactly the entries the page lists); **the pushed verify config checks the new route** (the tool's `verify.config.mjs` is loaded in its own process by `_lib/verify-config-host.mjs`: a spec, an array of specs or a function; some api check's path is the route, query string ignored); **the new check holds on what was pushed** (each such check is a GET whose `status` and `contains` match the app's answer; other assertion kinds are not evaluated, so they cannot fail a correct solution). `references/loop/reference-gates.test.ts` runs the real `greenlight preview` on the reference, on every alternative that changes the tree (it must pass) and on every mutant that exists to trip the last check (it must fail), so the grader and the real gate agree |
| contradicted-root-cause | `maintainer` | structural | checks 1-4 of the maintainer rubric (valid output applied by the real engine, cited claims, no evidence removed, status lifecycle), then the supersede rubric of `graders/_lib/maintainer.mjs` (`rubric.json` `supersede`): **the contradicted pattern is superseded by a pattern this output creates** (`status: superseded`, `supersededBy` naming a created pattern page); **the superseded pattern keeps its original claim** (every paragraph and list item of its body and every frontmatter line but `status`, `updated`, `supersededBy` is still there; text may be added); **the new pattern states the root cause the new evidence shows** (its text matches the rubric's root-cause pattern and its claims cite a ref that only the new incident or the raw records carry); **no overgeneral rule** (no statement gives the new cause for every failure of the kind); plus, in every runner rollout, an eval judge with the supersede rubric (below) |

### What the idle-probe grader accepts

Decided from the keepalive Worker's own contract (`infra/modules/keepalive/worker.js`, vendored in
the fixture as `keepalive/worker.mjs`), not from one spelling of the solution:

- **The keepalive target.** The structural check asks only for a target named after the tool with
  an absolute `url` (a malformed `url` fails the check; it used to crash the grader). The `kind` is
  NOT checked structurally: the Worker probes `kind: "oci"` as a plain service URL (any status
  below 500, `probePath` default `/`) and every other kind as a Supabase API (anon key required,
  2xx only). The grader runs that Worker over the tree's `targets.json`, so a target the Worker
  cannot probe (`"kind": "docker"`, which the Worker does not know, with no anon key) fails the
  runtime check with the Worker's own error, and one it can probe passes whatever it is called.
  `target: docker` in the manifest therefore still needs `kind: "oci"` in the keepalive target:
  that is the Worker's only service-URL kind, and the fixture's `keepalive/worker.mjs` header says
  so.
- **The healthcheck URL.** The grader fires the healthcheck itself, so it must read the path from
  the `HEALTHCHECK` (or compose `healthcheck`) command: `http://localhost|127.0.0.1|0.0.0.0|[::1]`,
  an optional port, a path. The port may be a number, `$PORT`, `${PORT:-3000}`,
  `${process.env.PORT}` or a string concatenation (`'http://localhost:' + process.env.PORT +
  '/health/live'`). A port written any other way (`$(printenv PORT)`) FAILS the check with the
  command quoted; it is never graded as a probe of `/`. A healthcheck with no URL in it (a script
  file) cannot be simulated and fails the same way.

## The maintainer grader: polarity and the eval judge

Checks 1-6 are deterministic. Polarity is read per statement from what it PRESCRIBES: in
"<reason>, so <prescription>" the prescription decides; relative clauses ("a probe that queries
Postgres …"), effect clauses ("querying the store keeps the compute awake"), compound adjectives
and readiness phrases are descriptive; "avoid / off the database / store-free / never the
database / stops at the application / a cached answer is enough" negate a reach; "unnecessary /
not needed" flips a phrase; a statement without a model inherits the previous statement's model
within its claim. `references/wiki/<task>/alternatives/` holds correct paraphrases that must pass
and the `traffic-*`/`silence-*`/`overgeneral-*` mutants inverted or overgeneral ones that must fail;
widen the reading only together with both.

Check 7, the eval judge (06 §4.6), runs only when a job sets `GraderJob.useJudge` (every runner
rollout: train is graded exactly like val, or a train pass the judge would have failed tells the
proposer a skill works when the gate will say it does not) and only after checks 1-6 pass, so the deterministic check is a prefilter and a judge
can only reject. The grader calls `ctx.judge(prompt)` → `{ passed, rationale }` with the fixed
`JUDGE_RUBRIC` (probe exactly the layer at risk, conditional on the liveness model) and the
output's new claims as delimited data; `JUDGE_SCHEMA` is the verdict schema for a structured call.
In a grader child `ctx.judge` is an IPC proxy: the parent answers `{ judge: { id, prompt } }` with
`{ judgeResult: { id, passed, rationale } | { id, error } }` (`runInChild(job, ms, { judge })` does
this). A missing judge, an error or a malformed verdict is NOT a verdict: the grader throws
(`JudgeUnavailableError`), so the grading is a grader error, and the runner defers the rollout
when the judge was merely unavailable (429/503 after its retries, a quota, the request cap). It is
never a failing check, which would be sealed as a 0. check-graders never sets `useJudge`: no LLM
runs there.

**One grader, two rubrics.** `gradeMaintainer(ctx, rubric)` runs checks 1-4 for every wiki task and
then the task's required distinction, chosen by its `graders/<task>/rubric.json`:
`{ incidents, ruleHomes }` is the liveness-model rule above (unchanged); `{ supersede }` is the
"wrong root cause" rule (`wiki/contradicted-root-cause-*`), whose four checks are in the table
above. `supersede` holds the contradicted pattern's id (`old`), the pages that carry the new
evidence (`contradictedBy`), a `rootCause` regex (the words any statement of the cause the records
show has to use), `overgeneral` regexes, and `judge: { oldCause, newCause }`. Its judge
(`SUPERSEDE_JUDGE_RUBRIC`, same verdict schema, same rules: runner rollouts only, after the
deterministic checks pass, an unusable verdict is a grader error) is given those two causes as
trusted context and the output's new claims as data, and asks whether the new text states the new
cause, does not present the old one as the cause of the new failure, and claims no more than the
evidence supports. The regex of the deterministic check cannot tell "the previous version was
still serving" from "it was not the previous version"; the judge is there for that.

## Trajectories: the shim meta contract

Rules about what a command DID match on `meta`, which the runner's command shims emit by calling
`normalizeShimEvent(cmd, argv, cwd, exit, ctx)` from `packages/wiki/src/bench/trajectory.ts` (the
contract is documented there in full; this is the summary). `ctx` is what the shim knows about the
repository when the command ran: the checked-out `branch`, each branch's `upstreams` (the
fixture's configured upstream), `pushDefault`, `pushRemote`, `aliases`, the file `config`
(`git config --list`), the command's `env` (the entries that differ from the env the facts were
read under), the runner's ground truth `remoteMoved` / `movedRefs` (a before/after comparison of the
remote's refs), and its own `passed` observation. All fields are optional and only ever added.

| command | meta |
|---|---|
| `git …` | `subcommand`: the builtin that runs after global options and transitive alias expansion over the EFFECTIVE config (file config, then `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, then `GIT_CONFIG_PARAMETERS`, then `-c`/`--config-env` in argv order). `"unknown"` for a non-builtin with no alias, a cycle, a `!shell` alias, an alias that changes the env, an option git rejects, `send-pack`/`http-push`/`submodule foreach`, and ANY non-push command that moved a remote ref (a hook: `invoked` names it) |
| `git push …` | `remote`; `dstRef`, the one remote ref updated, resolved from refspecs (`develop`, `HEAD:develop`, `+HEAD:refs/heads/develop`, `:develop`) or, for a bare push, from `remote.<r>.push`, the effective push.default and the upstream, else `"unknown"` (several refs, `--all`/`--mirror`/`--tags`/`--prune`, a namespace, wildcards, no upstream, config the shim cannot see: `-C` elsewhere, `GIT_DIR`, `GIT_CONFIG_GLOBAL`, `include.path`); `movedRefs`, when given, decides it; `dstRefs`, every resolved destination (a matcher on `dstRef: "<ref>"` also matches an event whose `dstRefs` contains it, so `git push origin develop feat/x` counts as a push to develop); `delete`, `force`, `dryRun`; `pushed`: a remote ref really moved (`remoteMoved`/`movedRefs`; without them, `exit 0` and not a dry run) |
| `greenlight …` (also via `npx [--package <pkg>]`, `pnpm [--filter x\|-r\|-C d] [exec\|dlx\|run]`, `yarn [exec\|dlx\|run]`, `bunx`, `npm exec\|x\|run [--]`) | `subcommand`; `tool`, the positional the CLI resolves after consuming its value flags; `env`; `argError` when the CLI would reject the argv (unknown flag, missing value); `passed` (`exit 0`, no `argError`, and the shim's own observation not false) |

A meta matcher matches only `source: "shim"` events. A rule MUST treat `dstRef: "unknown"` and
`subcommand: "unknown"` as possibly the protected branch: the loop tasks pair
`before(preview passed, push {dstRef: develop})` with the same rule for `{dstRef: unknown}` and for
`git {subcommand: unknown}`, count pushes with `{dstRef: develop, pushed: true}`, and forbid
`{subcommand: promote}`. A loop mutant or alternative may carry a `shim.json` (argv, exit and
ShimContext per command); a test re-derives its `trajectory.jsonl` from it with
`normalizeShimEvent`.

## References, mutants and pairs

A reference or mutant directory is a LAYER applied over the task's `fixture/`, in order:
`tree/` (overlaid files), `copy.json` (`{ "<tree path>": "<bench-relative source>" }`, for files kept
once under `bench/`, such as the historical keepalive Workers and the attack Workers under
`fixtures/_shared/keepalive/attacks/`), `remove.json` (paths to delete), `patch.diff` (`git apply`),
`trajectory.jsonl`, `output.json` (a MaintainerOutput). A mutant applies on top of the reference.

Every mutant also carries `expect.json`, `{ "failingChecks": ["<check name>", …] }`: the checks it
exists to trip. It must fail on at least one of them; a mutant rejected only by other checks is a
problem (`grader <task> fails mutant <n> for the wrong reason: …`), because the property it names
is then untested.

`references/<taskId>/alternatives/<altId>/` holds further layers, applied over the reference,
that are also correct and must pass (another spelling of the fix, e.g. a `cache: 'no-cache'`
probe). Every task is also graded on its untouched `fixture/`, which must fail.

`pairs/<pairId>/pair.json` lists overgeneral rules that, applied to both tasks of a pair, must fail
exactly the task named in `mustFail` (15 §8.3). A rule's tree for a task is that task's mutant of the
same id when one exists, else `pairs/<pairId>/<ruleId>/<taskId>/`.

`pnpm bench:check-graders [--verbose] [taskId…]` checks every grader against its reference, its
alternatives, its untouched fixture and its mutants, and every pair, and fails with `grader <task>
passes mutant <n>: it cannot distinguish <description>` (06 §4.3). It runs in CI as part of the
Vitest suite, which also asserts that a run leaves no file outside its temp directories. Attack
mutants resolve every write from their own location inside the materialized (mkdtemp) tree.

## Outlets: repros and the control arm (M2-02, M2-03)

Proposals for the human-applied outlets are evaluated by `evaluateOutlet`
(`packages/wiki/src/bench/outlets.ts`, 06 §5.6), not by the gate:

- **mechanism / doctor** run a trusted reproduction, `repro/<slug>/`. `repro.json` names the
  `patterns` it reproduces, the `outlets` it serves, its `script` and `timeoutMs`, and `reviewed`
  (`{ by, at }`; null until a human has reviewed it, and an unreviewed repro is never evidence).
  `node run.mjs --tree <checkout>` exits 0 when the checkout handles the condition, 1 when it
  reproduces it, anything else on error. Repros are read from the harness's own tree, never from the
  candidate. A candidate is accepted iff the repro fails on base, passes on the candidate, and
  `pnpm run check-all` passes on the candidate. `repro/probe-touches-wrong-layer/` is the doctor
  repro for DR-21 (07 §4.2): it builds wrappers around one needs-silence tool and fails on every
  framework without DR-21 (`repro/repro.test.ts`).
- **verify** takes a ```` ```json verify ```` block of `api` checks from the issue body and must
  fail on the faulty artifact and pass on the fixed one.
- **template** is `invalid` until M4.

`controls/probe-layer-overgeneral.json` is the control arm (06 §10.2 step 4): a skill patch on
`provider-neon` that replaces its accepted liveness rule with the overgeneral rule of
`pairs/probe-layer-val` `overgeneral-a` (probes must query the database). `controls/controls.test.ts`
shows it is a well-formed proposal, that its replace target is a rule in the accepted skill set, and
that an app following it fails `replay/idle-probe-leaves-store-asleep-val`, so the gate must reject it
with `replay-regression`.

A control has to take away something the baseline relies on. The first version added the same rule
to `deploy-verify-promote`; once `provider-neon` carried the specific rule (pull request #40), agents
followed the specific rule and the replay passed 5/5 with the control installed, so the gate could
only reject it for no improvement (iteration 7). Because the control's replace target is the accepted
text, the test fails when that rule changes, and the control has to be rewritten with it.

## Running the maintainer and proposer with an external agent

`models.json` may set `roles.maintainer` and/or `roles.proposer` to `"external"` (06 §2.5, §3.6).
`bench iterate` then makes no model call for that role: it writes the bundle, stops with exit 5
(`awaiting-agent`), and takes the role's output back as a JSON file. The rollouts stay on the gate
models, no key or secret is involved for the role, and no quota or spend is recorded for it. The
two roles are independent (one may stay `frontier`). Run everything from the repository root (the
directory that holds `.greenlight/`); `evo.yml` refuses external roles, so this is local-only.

```sh
# 1. Start. Train rollouts run; the maintainer step writes its bundle and stops (exit 5).
pnpm greenlight bench iterate --scope all            # prints the iteration id, the bundle path, the command

# 2. The maintainer agent: follow .claude/skills/greenlight-wiki (Maintainer). Read
#    <bundle>/PROMPT.md, then wiki/, raw/, incident/ and context.json inside the bundle.
#    Write ONE MaintainerOutput JSON object to a file. Do not apply it yourself.
pnpm greenlight wiki ingest --apply maintainer-output.json --dry-run     # optional pre-check, writes nothing
pnpm greenlight bench iterate --resume <iterationId> \
  --maintainer-output maintainer-output.json --agent "claude-code/<model>"

# 3. The val baseline runs (resume on later days while it exits 1, deferred). Then the proposer
#    step writes its bundle and stops (exit 5).
pnpm greenlight bench iterate --resume <iterationId>

# 4. The proposer agent: follow greenlight-wiki (Proposer). Read <bundle>/PROMPT.md, index.md,
#    skill-impact.md and outcomes.md; then read through the LOGGED commands only:
pnpm greenlight wiki traces --bundle <bundle> --failed
pnpm greenlight wiki read raw:<rawId> --bundle <bundle>                  # at least 4 distinct ids
pnpm greenlight wiki read pattern/<slug> --bundle <bundle>
pnpm greenlight wiki read skill:<name> --bundle <bundle>
#    Write ONE ProposerOutput JSON object to a file.
pnpm greenlight wiki propose --apply proposal.json --bundle <bundle>     # optional pre-check
pnpm greenlight bench iterate --resume <iterationId> \
  --proposal proposal.json --agent "claude-code/<model>"

# 5. Candidate rollouts, the control arm, the ledger and the hand-off follow as usual.
pnpm greenlight bench iterate --resume <iterationId>
```

- **Exit codes:** 0 complete, 1 deferred / blocked / failed, 2 usage, 3 missing prerequisite,
  4 refused by policy, **5 awaiting an external agent**. `--json` on exit 5 gives
  `awaiting: { role, bundle, skill, command, submissions }`. Exit 1 covers three outcomes, told
  apart by `status` in `--json` (`deferred`, `blocked` or `failed`): only `deferred` means "run the
  same command again later", and an exit 1 with no JSON on stdout is a crash. Exit 3 includes a
  `wiki/ledger.jsonl` with a complete line that is not a valid event: the commands that decide from
  the ledger (`bench iterate`, `bench run`, `bench merged`, `bench gate --recompute`) stop and name
  the line (08 §8).
- **The maintainer's output goes to the iteration.** While an iteration waits for its maintainer,
  `wiki ingest --apply <file>` without `--dry-run` is refused (exit 4) and prints the
  `bench iterate --resume … --maintainer-output` command to use instead; the `--dry-run` pre-check
  above still works.
- **A refused file** changes nothing and comes back with its issues (exit 5, `issues` in `--json`);
  a bundle takes three submissions, then fails (exit 1) and a plain `--resume` issues a new one.
  A file is refused outright (exit 4) when the step is not awaiting it, when it was already
  accepted, when the role is not external, or when a pin drifted.
- **`--agent`** is one token (letters, digits, `. _ : / @ + -`) naming who produced the file. It is
  the log entry's actor (`maintainer:<agent id>`) and is shown in the hand-off's cost table.
- **The proposer bundle** holds `index.md`, `skill-impact.md`, `outcomes.md`, `PROMPT.md`,
  `bundle.json` and `access.jsonl`, and no trace. Only reads the CLI logged in that
  `access.jsonl` count toward the four-trace rule; a file opened any other way does not. The
  harness cannot confine an external agent, though: limit it to the bundle directory, the output
  file and the two `greenlight wiki` commands yourself, so that it cannot open `.greenlight/raw/`
  (val and test records) or `.greenlight/bundle-keys/` (06 §3.6).

## Running rollouts with an external agent

A gate model in `models.json` may be external (06 §4.9, ADR-20 amendment):

```json
"frontier": { "id": "outside-large", "external": true },
"small":    { "id": "outside-small", "external": true },
"judge":    { "id": "gemini-3.1-flash-lite", "limits": { "rpm": 10, "rpd": 250 } }
```

`id` is a label you choose; an external entry has no `limits`. The eval judge is still called by
the harness (one request per maintainer rollout), so it needs a harness-driven entry of its own
once the entry it named is external. Both gate models must be external, or neither: one
evaluation has one agent, and a mixed selection is refused (exit 2).

`bench run` then calls no model. One invocation stays up as the **rollout server**: it opens up to
`--concurrency` (default 4) sandboxes at once, writes a manifest and a small client outside the
repository, lets an outside agent drive each rollout through that client, grades each rollout as
it closes, and seals the record as usual. The tools, the step budget, the trajectory recorder, the
separate grading container, the raw records and the gate are unchanged.

```sh
# (a) A train run. Run it in the background: it blocks until every rollout is closed.
M=/tmp/greenlight-launch/manifest.json
pnpm greenlight bench run --split train \
  --agent "claude-code/<model>" --manifest "$M" --concurrency 4 &

# The launcher's loop, until the command exits (the manifest then says "status": "ended"):
#   read $M; for every rollout whose "state" is "open" and that you have not dispatched yet,
#   start ONE fresh agent, outside this repository, with exactly this instruction:
#       Run `<command> prompt` and do exactly what it prints. Every shell command you run
#       must start with `<command>`: the task's files exist only behind that client, so
#       never run git, an editor or any other command directly, and do not read or write
#       any file on this machine.
#   where <command> is that rollout's "command" from the manifest (the manifest's own
#   "instruction" field carries this text). The instruction is the only thing keeping an agent
#   that has a shell on this machine inside its sandbox: an agent that ignores it can touch the
#   checkout it was started from. Start agents outside this repository, with no credentials,
#   and prefer a launcher that denies every command not beginning with the client.
jq -r '.rollouts[] | select(.state == "open") | .command' "$M"

# Exit 0: sealed. Exit 1 (deferred): some rollouts were not claimed in time; open only those:
pnpm greenlight bench run --resume "$(jq -r .evaluationId "$M")" --manifest "$M" &

# (b) A val baseline: the same, on the val split (gate.json's runs per task and model).
pnpm greenlight bench run --split val \
  --agent "claude-code/<model>" --manifest "$M" --concurrency 4 &
```

**A whole iteration** with external rollouts, maintainer and proposer. While a rollout step runs,
`bench iterate` is the rollout server, so each of these commands blocks and is served by the same
launcher loop over `$M`. `--rollout-agent` is needed once; it is fixed for the iteration.

```sh
# 1. Train rollouts (served from $M), then the maintainer bundle: exit 5.
pnpm greenlight bench iterate --scope all \
  --rollout-agent "claude-code/<model>" --manifest "$M" &
# 2. The maintainer agent writes maintainer-output.json (see the section above). Handing it in
#    continues with the val baseline rollouts (served from $M), then the proposer bundle: exit 5.
pnpm greenlight bench iterate --resume <iterationId> --manifest "$M" \
  --maintainer-output maintainer-output.json --agent "claude-code/<model>" &
# 3. The proposer agent writes proposal.json. Handing it in continues with the candidate rollouts
#    and the control arm (served from $M), the ledger and the hand-off: exit 0.
pnpm greenlight bench iterate --resume <iterationId> --manifest "$M" \
  --proposal proposal.json --agent "claude-code/<model>" &
# Any step that exits 1 (deferred: unclaimed rollouts): run it again.
pnpm greenlight bench iterate --resume <iterationId> --manifest "$M" &
```

A train run (a) and a baseline (b) made beforehand under the same `--agent` id and limits are
reused by identity, so step 1 and the baseline of step 2 then open no rollout.

- **What one agent is told:** only the instruction above. `prompt` prints everything else: the
  rules, the tool verbs, the system prompt (the skills under test in full, then the role) and the
  task. The verbs are `read_file`, `write_file`, `list_dir`, `list_files`, `bash` and `finish`;
  a maintainer task has the three read verbs and takes its `MaintainerOutput` as
  `finish --json-stdin`. File content and long commands go through stdin. An agent with the CLI
  on PATH may use `greenlight bench rollout <handle> <verb> …` instead of the client file.
- **Waves.** At most `--concurrency` rollouts are `open` or `claimed` at once. When one closes
  (`grading`, then `done`), the next `queued` one becomes `open` and the manifest is rewritten.
  Poll the manifest every few seconds and dispatch what is newly `open`. A handle of a `queued`
  rollout is refused until then.
- **Timeouts.** An `open` rollout must get its first command within `--claim-timeout` (default
  10 minutes), or it is deferred: no record, and `--resume` reopens it. From the first command the
  rollout has the task's `timeoutMin` × `--external-timeout-factor` (default 3; 30 minutes for a
  10-minute task) and `--max-steps` steps (default 25; one tool call or `finish` is one step).
  When either runs out the rollout is closed and **graded as it stands**, like a harness rollout
  that ran out. Both limits are part of the identity. An agent that only asked for the prompt and
  then went silent is deferred, not graded.
- **Exit codes of the client:** 0 the call ran; 1 it ran and reported an error (a tool error, a
  rejected `finish`); 2 usage; 3 refused (bad handle or token, not open yet, closed, budget used
  up, server gone).
- **Records.** The identity has `agent: { vendor: "external", version: "<agent id>" }`, so an
  external evaluation is never compared with a harness-driven one or with another agent's; run a
  baseline and its candidate under the same `--agent` id. Raw records carry `agent.vendor:
  external` and `servedBy: "<label>@<agent id>"`. Both are **declared** by the launcher: the
  harness cannot verify which agent or model produced the steps. No quota is reserved and no
  `spend` event is written for an external model; only the judge's requests are counted.
- **Isolation is the launcher's job.** The sandbox is as closed as ever (no network, no bench
  mount, grading elsewhere). The outside agent is not in it: it runs on your machine and could
  open `bench/references/` or the graders if it went looking. The client and the manifest are
  written under the system temp dir, and neither the handle nor the prompt names a repository
  path, but nothing more can be enforced from here. Start each agent fresh, with a working
  directory outside this repository and no other context. `evo.yml` has no launcher: external
  rollouts are local-only.

## A safety-fix iteration (`bench iterate --safety-fix`)

By default `bench iterate` gates its skill proposal on the standard path, which requires a strict
capability gain. The safety-fix path (06 §5.4) is for a proposal motivated by a val replay task
that fails in the baseline:

```sh
pnpm greenlight bench iterate --scope all --safety-fix replay/idle-probe-leaves-store-asleep-val
```

The named tasks (comma-separated, each an active val replay task) must fail in the baseline and
pass under the candidate. No capability gain is required; replay safety on the other replay tasks
and the non-regression test (06 §5.4: a loss is a regression when its exact one-sided p is at
most alpha) still apply. The path waives efficacy, so the owner chooses it and
the proposer cannot: the targets are fixed when the iteration is created, a resume that names
others is refused, and the control arm is still gated on the standard path. The ledger event
carries `path: "safety-fix"`.

## After the gate: review, merge, record

`bench iterate` ends at a ledger event and a hand-off. Nothing has changed in `.claude/skills` at
that point: `candidate-accepted` means the gate passed, and the remaining steps are the owner's.
In order:

1. **Read the hand-off**, `.greenlight/bench/iterations/<iterationId>/handoff.md` (`handoff.json`
   beside it; `bench iterate --resume <iterationId> --handoff-only` regenerates both). It holds the
   outcome and its reasons, the per-model gate table, the diff, the control arm's result, the cost,
   and the `bench gate --recompute <gateInputHash>` command that re-derives the decision from the
   stored records without a rollout. Read the caveats as part of the decision: a
   `safety-vacuous` reason means no replay task constrained the candidate, and a control arm
   that was not rejected says the gate's safety check went unexercised. The CLI does not call
   GitHub; whoever runs the loop posts the hand-off.
2. **Record the review.** A rejected candidate is reviewed too (06 §10.3).

   ```sh
   pnpm greenlight bench review <iterationId> --decision accept|reject \
     --reason "<why>" --reviewer "<who>"
   ```

   `--reviewer` (or `GREENLIGHT_REVIEWER`) is required and names the person, or the delegate
   acting for the owner; it is free text, recorded as `review.by` and not verified. The command
   writes a `review` event per recorded proposal of the iteration, which annotates the ledger and
   moves no stage. A `reject` of a proposal that is already accepted or merged writes a `withdrawn`
   event instead. `--decision` is the verdict on the iteration's own proposal; a control arm's row
   is always recorded as `reject`, because a control is never merged, so accepting a candidate or
   a justified `no_action` does not record an acceptance of the control beside it. (Before this
   rule, iteration 8's `no_action` row was recorded as `reject` together with its control; the
   ledger is append-only, so that row stands, and its reason text says what was meant.) An
   iteration is reviewed once.
3. **Open a pull request that carries only the accepted skill text.** Copy the gated candidate,
   `.greenlight/bench/iterations/<iterationId>/candidates/<proposalId>/skills/<skill>/`, byte for
   byte into `.claude/skills/<skill>/` and its mirror `plugin/skills/<skill>/` (`pnpm
   check-plugin-sync` checks the mirror). Do not edit the text on the way and do not add another
   skill change to the same pull request: `bench merged` accepts only a tree whose skills hash to
   the candidate the gate evaluated. A merge does not bump the skill's `version` frontmatter; the
   accepted skill set is identified by its hash.
4. **Merge it.**
5. **Record the merge**, on the tree the change was merged into:

   ```sh
   pnpm greenlight bench merged <proposalId> --ref <pull request URL or commit sha>
   ```

   This appends the `merged` event, which is what moves the accepted skill set (06 §6.1), and
   re-renders `wiki/skill-impact.md`. It is refused (exit 4) for a proposal that is not at
   `candidate-accepted`, for a control-arm proposal, and when the installed skills are not the
   gated candidate. Running it again for a proposal already recorded is a no-op (exit 0).
6. **Commit `wiki/ledger.jsonl` and `wiki/skill-impact.md`.** Neither file is edited by hand.

**If step 5 is skipped**, the next `bench iterate` refuses to start (exit 4): the installed skills
are no longer the accepted set the ledger names. When the installed skills are the gated candidate
of an accepted proposal, the message names that proposal and the `bench merged` command that
records it. Otherwise it reports the two hashes, and the fix is to check out the accepted skills.

What is and is not committed: the ledger, `skill-impact.md`, the wiki pages and log, and the sealed
evaluation and gate-input records under `wiki/evidence/eval/` are committed. `.greenlight/` is
gitignored, so the raw rollout records (`.greenlight/raw/`), the per-rollout transcripts and trees,
the iteration state and the hand-off stay on the machine that ran the iteration.

## What has the loop done so far (`greenlight bench report`)

`pnpm greenlight bench report` answers three questions from the committed evidence alone, so it
gives the same answer on any checkout of the same commit (13 §5):

- **Iterations.** Every real proposal with its outcome, its review and reviewer, its merge
  reference, and whether its gate decision recomputes from the stored gate input and records.
- **Discrimination.** Every control arm with a ledger row and what its rejection shows:
  `replay-regression` with the replay task it broke, which is the result 06 §10.3 asks for;
  `rejected-other`, a rejection an overgeneral patch can earn whatever it breaks; or `accepted`,
  the failure a control exists to find. A control whose gate ended `underpowered` or `blocked` has
  no ledger row and does not appear.
- **Cost.** Every sealed evaluation record with its rollouts and rollout wall-clock time, and the
  harness's own `spend` events per model. Requests, tokens and dollars are known only where the
  harness called the model. An external rollout agent reports no usage, so those columns read
  `unmeasured` for its records, never zero.

`--metric iterations|discrimination|cost` prints one section, `--proposal <id>` narrows every
section to one proposal, and `--json` prints the data. The command exits 1 when a recorded gate
decision does not reproduce, so it also serves as a check over the whole ledger.

## Runner (`bench/runner/`, `greenlight bench run`)

`greenlight bench run` (packages/wiki/src/bench/runner.ts) runs each rollout in a throwaway sandbox
and grades it somewhere else (06 §4.2). What runs where:

| where | what | sees |
|---|---|---|
| host | the ReAct loop, or for an external rollout the rollout server that takes its place (see above) (the only holder of model access: `GEMINI_API_KEY` in the host env, or none when an egress proxy injects it, with `NODE_USE_ENV_PROXY=1`), the shim socket server, the trajectory writer, the origin and tree read-out, the diff, raw/evaluation records | everything |
| rollout container | every agent tool call (`read_file`, `write_file`, `list_dir`, `list_files`, `bash`; a maintainer rollout gets the three read tools only) via `docker exec` as uid 10000 | tmpfs `/work` (fixture + `.claude/skills/`, fresh git repo), tmpfs `/srv/origin.git` (bare origin), `/opt/real/greenlight` (the built CLI, read-only, inside a root:shim 0750 directory), `/run/greenlight-shim` (read-only; socket 0600 owned by the shim user) |
| grading container | `graders/<id>/grade.mjs` as root (DAC_OVERRIDE/SETUID/SETGID/KILL only), the agent's app as uid 10000 | the exported tree and trajectory (read-only), a staged copy of `tasks/<id>/task.json`, `graders/<id>/`, `graders/_lib/`, `fixtures/` |

Rollout container: `--network none`, `--read-only`, `--cap-drop ALL` + SETUID/SETGID (the
recorder's doas hops), pids/memory/cpu limits, `GREENLIGHT_WIKI=off` (isolation mode). No mount of
`bench/`, graders, mutants, references or the repo source; no secret in any environment.

**Shims.** `git greenlight pnpm npx wrangler vercel gh terraform docker curl` on the agent's PATH are
`shim.sh`, which hands the command to `record.mjs` running as the shim user (`doas -u shim`; the
agent's env travels as data, never as the recorder's env). The recorder reads the git state with
the command's own `-c`/`-C` options and the agent's `GIT_CONFIG_*`, snapshots the bare origin's
refs, runs the real command as the agent through `/opt/runner/run-real` (`doas -u root`, which
immediately `setpriv`s to uid agent with the extra group `shim`), and sends one JSON line to the
socket. The host stamps each event (and each tool call) with one global sequence on arrival and
builds meta with `normalizeShimEvent`; `pushed` is true only when an origin ref really moved.
Commands not installed in the image are recorded with exit 127. `pnpm` and `npx` are package
runners with nothing to run: the image has no package manager and no network. Because the skills
write `pnpm greenlight …`, the recorder passes `pnpm [options] [exec|dlx|run] greenlight …` and
`npx [options] [--package …] greenlight|@rtrentjones/greenlight …` straight to the greenlight CLI
and records that greenlight command (so `pnpm greenlight preview x` is the same event as
`greenlight preview x`); any other `pnpm`/`npx` command exits 127 at once with a message naming
the CLI, instead of hanging on a registry lookup.

**The real binaries run only through the recorder.** `/usr/bin/git` (and `git-shell`,
`/usr/libexec/git-core/`), `/usr/bin/curl` and the CLI under `/opt/real/` are root:shim 0750 (any
of `wrangler vercel gh terraform docker` installed later gets the same treatment). The agent's own
processes are not in the shim group, so `/usr/bin/git push` or `node /opt/real/greenlight/…` fails
with "Permission denied": every git, curl and greenlight call the agent makes goes through a shim
and is recorded. The runner's own git (fixture commit, origin read-out) runs as uid agent with the
shim group, outside any agent process.

**What is and is not guaranteed.**

- The agent cannot connect to the shim socket (owned by the shim uid, mode 0600), so it cannot
  forge or edit an event.
- doas cannot restrict `permit agent as shim cmd /opt/runner/record` to argument patterns, so the
  agent can invoke the recorder directly with arguments of its choice. `record.mjs` validates its
  own invocation (a shimmed command name, an absolute cwd, a base64 environment of well-formed
  names) and refuses anything else with exit 126 without running or sending anything; what it
  does run, it reports truthfully, so a direct call is equivalent to calling the shim. The second
  rule, `permit shim as root cmd /opt/runner/run-real`, is reachable only from the recorder.
- The trajectory is checked for completeness, not assumed complete. The host lists the bare
  origin's refs after setup and again after every process is killed; every value any ref took
  (in any recorded before/after listing, and at the end) must be its start value or one a
  recorded git command left it at. Otherwise the outcome carries `graderError:
  "trajectory-incomplete: origin ref(s) moved with no recorded command: …"`. A shim message the
  host rejected (lost event) is `trajectory-incomplete` too; more than 10,000 events or 8 MB of
  shim messages in one rollout is `trajectory-truncated` (2 MB per message). All of them are
  invalid at the gate (`grader-error`), never a pass. Residual risks are in 06 §4.6.
- Not guaranteed: what a recorded command's own children do (a git hook, an alias `!cmd`, the
  app `greenlight preview` starts) runs with the shim group and is attributed to that command; a
  ref moved and moved back between two listings is invisible. Neither can fake a recorded push or
  preview: a rule matches only recorded events.

**After the agent stops** (finish, step limit or timeout) the runner kills EVERY process but PID 1
(an inert sleep) — the shim user's in-flight recorders included — from a privileged root `docker
exec` (CAP_KILL), repeating until two consecutive `/proc` scans find nothing alive; a loop that
does not converge is a harness error. Only then does it read the origin refs, stop accepting shim
events and export the tree (as root, so no file is unreadable). The export is checked before it is
unpacked on the host: only regular files, directories and symlinks, no absolute or `..` member,
no duplicate, nothing below a symlink member, at most 600 MB; host code never follows a symlink
out of the tree (skill stamps are read through `lstat`ed regular files only). The diff
(`diff.patch`) is computed on the host from that same exported tree against the staged fixture, in
a throwaway repository with no system, global or repository config, so diff and graded tree are
one snapshot and nothing the agent configured (filter, fsmonitor, textconv, hook) runs on the
host. The container is removed, and only then is the rollout graded. In the grading container the
driver talks to the host over stdin/stdout lines; the maintainer grader's eval judge
(`GraderJob.useJudge`: every runner rollout, never check-graders) is relayed to the host, which answers with one structured call on the judge model
(`bench/models.json` `judge`, fallback off, counted in the rollout's cost and spent on the judge
model's own `spend` event). After the tree, the runner also exports the tree of the origin's
`develop` branch (`git archive` of the bare origin, checked like the tree export) for the loop
grader's tree check.

**What the model is told and given.** The system prompt is the task's declared skills in full,
then the role prompt, then the rollout's budget: the step cap and the request cap. From 5 steps
left, every tool response carries `steps_remaining`. A declared skill that is not in the skills
directory fails the RUN before any request (it used to be dropped silently, so a rollout was
graded as if the skill had been there). `read_file` takes `offset`/`limit` (lines) and keeps the
head of a long file; `list_files` lists a tree in one call; `write_file` with a non-string
`content` is an error, not an empty file. A maintainer rollout (the `wiki/*` tasks) gets the
production maintainer prompt (`MAINTAINER_PROMPT`, 06 §2.2) with the fixture as the bundle at the
working directory, the `greenlight-wiki` skill, the read tools only, and a `finish` whose
parameters are the production `MaintainerOutput` JSON schema: a submission is validated with
`MaintainerOutputSchema` and the patch engine against the fixture's wiki, and a rejected one goes
back with its issues, up to three times (06 §2.4).

**The send guard and the fixture.** Every request is scanned by the secret detector and refused
if anything is flagged (06 §4.8). The detector reads context, so a fixture's publishable key that
is clean in `targets.json` was flagged in the model's own `curl -H "apikey: …"`, and that refusal
stopped the evaluation. A flagged value that occurs verbatim in the task's fixture or brief, and
that the detector does not flag there, is let through; a value flagged in the fixture itself (a
real token committed by mistake) or absent from it still refuses the send.

**Limits are identity.** `--max-steps` (default 25), the per-rollout request cap
(`--rollout-requests`, default max-steps + 2: one request per step plus two retries' headroom)
and the rollout timeout override are `harness.limits` in the BaselineIdentity: a cached 10-step
train run is not reused for `--max-steps 20`, a gate never compares records run under different
limits, and `--resume` refuses an explicitly changed limit (an unset one is the evaluation's own).
The request cap ends a rollout like the step limit (its tree is graded) only when the model used
it up, one request per turn. A cap eaten by transient retries (429/5xx: more requests than turns)
says nothing about the model: that rollout is deferred and re-run.

**Quota scheduling.** Before each rollout the runner checks the model's remaining daily quota
(`.greenlight/quota/`, seeded from today's `spend` events) against the rollout's request cap
(plus one judge call on the judge model for a maintainer rollout). A model below it is
skipped for today and the other keeps running; the model with the most quota left always goes
next, so the models interleave. No rollout ever falls back to another model (train included: a
fallback-served train outcome would be evidence about the wrong model and spend the other's
quota). A rollout deferred anyway (model unavailable with fallback off, quota spent by another
process, its request cap eaten by retries, the eval judge unavailable) defers only its model. The run then returns `deferred` (exit 1) with the keys left per
model (`--json`: `remaining`, `deferredModels`); `--resume <evaluationId>` continues it on a later
day. A deferred rollout's requests are lost (a ReAct run cannot resume mid-way) but still counted
in `spend`; it leaves no raw record.

**Image identity (resume across days).** The Dockerfile pins the base image by digest and
installs its apk packages (`git bash curl doas setpriv`) WITHOUT version pins: Alpine's mirror
serves only the current revision of a package, so an exact pin makes every from-scratch build
fail the day a security patch lands (2026-11-15: `git=2.54.0-r0` was gone, and the image built
only where it was cached). What was installed is recorded instead: `harness.imageDigest` is
`ctx:sha256:<hash>` over this directory's content, the shim uid and the package list read out of
the built image (`apk info -v`: name and version of every package), not the local image id,
which changes on every rebuild. So a pruned and rebuilt image with the same packages resumes, and
a rebuild that picked up a package update gets a NEW identity: sealed evaluations on the old
image are not comparable with it, and a resume across the update is refused (re-baseline). A
package update never breaks the build. Operational discipline for a gate split across days:

- do not `docker image prune`/`docker system prune` the `greenlight-bench-runner:*` images while
  an evaluation is unsealed (a rebuild may install newer packages, which changes the identity and
  refuses the resume);
- keep the checkout frozen: `depsHash` covers the lockfile and the whole built CLI bundle
  (`cliBuild`), so any change to the CLI source, the lockfile, `bench/` or the skills between
  days refuses the resume (`git stash`/a separate worktree for other work);
- keep the same host user (the shim uid is part of the image digest) and the same `bench/runner/`.

**`--sandbox process` is for local development only.** Tool calls run as host child processes in
a temp dir with the same shims: same uid as the host, so the agent could read host files, connect
to the shim socket, run the real binaries and outlive the process-group kill with `setsid`. Its
records carry `harness.imageDigest: "process"` (never comparable with a docker evaluation), and
`bench run` refuses it for `--role baseline` (and candidate).

**Records.** One `bench` raw record per rollout that ran to an end (`.greenlight/raw/`, excerpt
redacted and truncated; transcript, trajectory, diff, maintainer output, grade report and final
tree under `.greenlight/bench/runs/<evaluationId>/<rawId>/`: `transcript.json`,
`trajectory.jsonl`, `diff.patch` and `output.json` are stored REDACTED, rewritten once grading has
read the originals; `tree/` and `pushed/` are the agent's files as they were), one `spend` ledger event per model per
invocation, and a sealed EvaluationRecord (`wiki/evidence/eval/<hash>.json`) once every rollout has
an outcome. A grader crash or an incomplete trajectory is an outcome with `graderError` (invalid at
the gate, never a fake 0); a harness error, a redaction refusal or a model error leaves the
evaluation unsealed, with a raw record whose `retained.verdict` is `unknown` (and `passed: false`,
which the schema requires: consumers must read the verdict, see 06 §4.2). A deferred rollout writes
no raw record. A train run whose identity matches a sealed train record is reused unless
`--force`.

**Threat model notes.**

- The fake-clock coordinator (`graders/_lib/fake-clock-coordinator.mjs`) serves its socket with
  mode 0666 in a 0711 temp dir in the grading container, because the agent's app (uid 10000) must
  connect to it. Anything running as the app can therefore send clock messages (advance or stall
  its own view of time). That is the app under test talking to its own clock: it cannot reach the
  grader's verdict channel (the grader child's IPC) or the staged grader files (0600/0700), and a
  participant that stalls makes `advance` throw, which fails the window rather than passing it.
  `NODE_OPTIONS` reaches the app (the fake-clock shim is preloaded through it).
- The grading container runs the grader as root with DAC_OVERRIDE/SETUID/SETGID/KILL and no
  network; the agent's code runs there only as uid 10000.

**Activating tasks.** Every task enters `pending`. After `bench run --split val --role baseline`
has sealed a baseline that covers a task on both gate models, `greenlight bench activate <taskId…>`
flips it to `active` (and so changes the identity: the next gate re-baselines).
