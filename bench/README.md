# bench/

The evolution loop's benchmark (vision [06 §4](../docs/vision/06-evolution-loop.md), layout in
[08 §10](../docs/vision/08-data-contracts.md)). M1 ships the fixtures and tasks of the first
iteration (06 §10, 15 §8): two replay tasks whose lessons look opposite, the maintainer task that
must reconcile them, and a loop control task.

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
| `loop/fixture-preview-before-push` | `…-train` (`guestbook`) | `…-val` (`pinboard`) |

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
  guard, an `AbortSignal.timeout` loop, a worker or a child. A process the app starts that never
  joins the clock (a long-lived non-Node child), or a participant that stops answering, fails the
  window. Out of scope: Node-internal timers (socket timeouts), `spawnSync` children, native code,
  and code that attacks the shim itself (the sandbox is the isolation boundary). The env carries
  only a socket path and a timestamp.
- **Production semantics.** The maintainer grader applies the output with the real patch engine
  (`ctx.wiki.applyMaintainerOutput`), not a re-implementation.

| task family | kind | fidelity | what the grader does |
|---|---|---|---|
| keepalive-probe-reaches-store | `app` | runtime | runs the tree's own keepalive Worker (in its own process) over its `targets.json` on a simulated Workers runtime (edge cache, bypassed by `cache: 'no-store' \| 'no-cache' \| 'reload'`; the `no-store` + `cf.cacheTtl` conflict throws) every 3 days for 21 days against the Supabase-shaped fake: not paused, every sweep ran a query, a paused store reads as failing, no user columns read; plus the structural `probeTable` check |
| idle-probe-leaves-store-asleep | `app` | runtime | starts the tree's app from its Dockerfile `CMD` on the fake clock against the Neon-shaped fake, steps a 10-minute idle window (every app timer fires at its simulated time), fires the declared `HEALTHCHECK` on its interval and one keepalive sweep: zero store queries from either and from the idle app, store suspended, liveness 200 with the database stopped, `/health` still reports the database |
| probe-layer-incidents | `maintainer` | structural | the rubric in `graders/_lib/maintainer.mjs`: valid output applied by the real engine, cited claims, no evidence removed, status lifecycle, the liveness-model distinction with the right polarity on each branch citing both incidents, no overgeneral or inverted rule; plus, in real gate grading only, an eval judge (below) |
| fixture-preview-before-push | `trajectory` | runtime | evaluates `task.json` `trajectory.rules` with the rule DSL in `packages/wiki/src/bench/trajectory.ts`; the rules match on shim `meta` (below), never on argv spelling |

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

Check 7, the eval judge (06 §4.6), runs only when a job sets `GraderJob.useJudge` (the runner's real
gate grading) and only after checks 1-6 pass, so the deterministic check is a prefilter and a judge
can only reject. The grader calls `ctx.judge(prompt)` → `{ passed, rationale }` with the fixed
`JUDGE_RUBRIC` (probe exactly the layer at risk, conditional on the liveness model) and the
output's new claims as delimited data; `JUDGE_SCHEMA` is the verdict schema for a structured call.
In a grader child `ctx.judge` is an IPC proxy: the parent answers `{ judge: { id, prompt } }` with
`{ judgeResult: { id, passed, rationale } | { id, error } }` (`runInChild(job, ms, { judge })` does
this). A missing judge, an error or a malformed verdict fails closed. check-graders never sets
`useJudge`: no LLM runs there.

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
| `git push …` | `remote`; `dstRef`, the one remote ref updated, resolved from refspecs (`develop`, `HEAD:develop`, `+HEAD:refs/heads/develop`, `:develop`) or, for a bare push, from `remote.<r>.push`, the effective push.default and the upstream, else `"unknown"` (several refs, `--all`/`--mirror`/`--tags`/`--prune`, a namespace, wildcards, no upstream, config the shim cannot see: `-C` elsewhere, `GIT_DIR`, `GIT_CONFIG_GLOBAL`, `include.path`); `movedRefs`, when given, decides it; `dstRefs`; `delete`, `force`, `dryRun`; `pushed`: a remote ref really moved (`remoteMoved`/`movedRefs`; without them, `exit 0` and not a dry run) |
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

`controls/probe-layer-overgeneral.json` is the first iteration's control arm (06 §10.2 step 4): a
skill patch on `deploy-verify-promote` stating the overgeneral rule of `pairs/probe-layer-val`
`overgeneral-a`. `controls/controls.test.ts` shows it is a well-formed proposal and that an app
following it fails `replay/idle-probe-leaves-store-asleep-val`, so the gate must reject it with
`replay-regression`.

## Runner (`bench/runner/`, `greenlight bench run`)

`greenlight bench run` (packages/wiki/src/bench/runner.ts) runs each rollout in a throwaway sandbox
and grades it somewhere else (06 §4.2). What runs where:

| where | what | sees |
|---|---|---|
| host | the ReAct loop (the only holder of model access: `GEMINI_API_KEY` in the host env, or none when an egress proxy injects it, with `NODE_USE_ENV_PROXY=1`), the shim socket server, the trajectory writer, the origin and tree read-out, the diff, raw/evaluation records | everything |
| rollout container | every agent tool call (`read_file`, `write_file`, `list_dir`, `bash`) via `docker exec` as uid 10000 | tmpfs `/work` (fixture + `.claude/skills/`, fresh git repo), tmpfs `/srv/origin.git` (bare origin), `/opt/real/greenlight` (the built CLI, read-only, inside a root:shim 0750 directory), `/run/greenlight-shim` (read-only; socket 0600 owned by the shim user) |
| grading container | `graders/<id>/grade.mjs` as root (DAC_OVERRIDE/SETUID/SETGID/KILL only), the agent's app as uid 10000 | the exported tree and trajectory (read-only), a staged copy of `tasks/<id>/task.json`, `graders/<id>/`, `graders/_lib/`, `fixtures/` |

Rollout container: `--network none`, `--read-only`, `--cap-drop ALL` + SETUID/SETGID (the
recorder's doas hops), pids/memory/cpu limits, `GREENLIGHT_WIKI=off` (isolation mode). No mount of
`bench/`, graders, mutants, references or the repo source; no secret in any environment.

**Shims.** `git greenlight wrangler vercel gh terraform docker curl` on the agent's PATH are
`shim.sh`, which hands the command to `record.mjs` running as the shim user (`doas -u shim`; the
agent's env travels as data, never as the recorder's env). The recorder reads the git state with
the command's own `-c`/`-C` options and the agent's `GIT_CONFIG_*`, snapshots the bare origin's
refs, runs the real command as the agent through `/opt/runner/run-real` (`doas -u root`, which
immediately `setpriv`s to uid agent with the extra group `shim`), and sends one JSON line to the
socket. The host stamps each event (and each tool call) with one global sequence on arrival and
builds meta with `normalizeShimEvent`; `pushed` is true only when an origin ref really moved.
Commands not installed in the image are recorded with exit 127.

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
(`GraderJob.useJudge`, baseline and candidate grading only, never train rollouts or
check-graders) is relayed to the host, which answers with one structured call on the judge model
(`bench/models.json` `judge`, fallback off, counted in the rollout's cost and spent on the judge
model's own `spend` event).

**Limits are identity.** `--max-steps` (default 15), the per-rollout request cap
(`--rollout-requests`, default max-steps + 2: one request per step plus two retries' headroom)
and the rollout timeout override are `harness.limits` in the BaselineIdentity: a cached 10-step
train run is not reused for `--max-steps 20`, a gate never compares records run under different
limits, and `--resume` refuses an explicitly changed limit (an unset one is the evaluation's own).

**Quota scheduling.** Before each rollout the runner checks the model's remaining daily quota
(`.greenlight/quota/`, seeded from today's `spend` events) against the rollout's request cap
(plus one judge call on the judge model for a maintainer gate rollout). A model below it is
skipped for today and the other keeps running; the model with the most quota left always goes
next, so the models interleave. No rollout ever falls back to another model (train included: a
fallback-served train outcome would be evidence about the wrong model and spend the other's
quota). A rollout deferred anyway (model unavailable with fallback off, quota spent by another
process) defers only its model. The run then returns `deferred` (exit 1) with the keys left per
model (`--json`: `remaining`, `deferredModels`); `--resume <evaluationId>` continues it on a later
day. A deferred rollout's requests are lost (a ReAct run cannot resume mid-way) but still counted
in `spend`; it leaves no raw record.

**Image reproducibility (resume across days).** The Dockerfile pins the base image by digest and
every apk package by version. `harness.imageDigest` is `ctx:sha256:<hash>` over this directory's
content, the shim uid and the installed package list (`apk info -v`), not the local image id,
which changes on every rebuild: a pruned and rebuilt image with the same content resumes; a
drifted package changes the identity. A pin the Alpine mirror no longer serves makes the build fail
instead of drift. Operational discipline for a gate split across days:

- do not `docker image prune`/`docker system prune` the `greenlight-bench-runner:*` images while
  an evaluation is unsealed (a rebuild needs the pinned versions to still be on the mirror);
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
redacted and truncated; transcript, trajectory, diff, grade report and final tree under
`.greenlight/bench/runs/<evaluationId>/<rawId>/`), one `spend` ledger event per model per
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
