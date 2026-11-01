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
- **Simulated time is honoured in full.** The idle-window grader preloads
  `graders/_lib/fake-clock-shim.mjs` into the app (`node --import`): `setTimeout`/`setInterval`
  (global, `node:timers`, `node:timers/promises`) and `Date` follow a clock the grader advances
  step by step over IPC, in lockstep with the fake store's clock, so a 30-second poll fires twenty
  times in the ten-minute window.
- **Production semantics.** The maintainer grader applies the output with the real patch engine
  (`ctx.wiki.applyMaintainerOutput`), not a re-implementation.

| task family | kind | fidelity | what the grader does |
|---|---|---|---|
| keepalive-probe-reaches-store | `app` | runtime | runs the tree's own keepalive Worker (in its own process) over its `targets.json` on a simulated Workers runtime (edge cache, bypassed by `cache: 'no-store' \| 'no-cache' \| 'reload'`; the `no-store` + `cf.cacheTtl` conflict throws) every 3 days for 21 days against the Supabase-shaped fake: not paused, every sweep ran a query, a paused store reads as failing, no user columns read; plus the structural `probeTable` check |
| idle-probe-leaves-store-asleep | `app` | runtime | starts the tree's app from its Dockerfile `CMD` on the fake clock against the Neon-shaped fake, steps a 10-minute idle window (every app timer fires at its simulated time), fires the declared `HEALTHCHECK` on its interval and one keepalive sweep: zero store queries from either and from the idle app, store suspended, liveness 200 with the database stopped, `/health` still reports the database |
| probe-layer-incidents | `maintainer` | structural | the rubric in `graders/_lib/maintainer.mjs`: valid output applied by the real engine, cited claims, no evidence removed, status lifecycle, the liveness-model distinction with the right polarity on each branch citing both incidents, no overgeneral or inverted rule |
| fixture-preview-before-push | `trajectory` | runtime | evaluates `task.json` `trajectory.rules` with the rule DSL in `packages/wiki/src/bench/trajectory.ts`; the rules match on shim `meta` (below), never on argv spelling |

## Trajectories: the shim meta contract

Rules about what a command DID match on `meta`, which the runner's command shims emit by calling
`normalizeShimEvent(cmd, argv, cwd, exit, ctx)` from `packages/wiki/src/bench/trajectory.ts` (the
contract is documented there in full; this is the summary). `ctx` is what the shim knows about the
repository when the command ran: the checked-out `branch`, each branch's `upstreams` (the
fixture's configured upstream), `pushDefault`, `pushRemote`, `aliases`, and its own `passed`
observation.

| command | meta |
|---|---|
| `git …` | `subcommand` after global options (`-C`, `-c`, …) and alias expansion |
| `git push …` | `remote`; `dstRef`, the one remote ref updated, resolved from refspecs (`develop`, `HEAD:develop`, `+HEAD:refs/heads/develop`, `:develop`) or, for a bare push, from push.default and the upstream, else `"unknown"` (several refs, `--all`/`--mirror`/`--tags`, wildcards, no upstream); `dstRefs`; `delete`, `force`, `dryRun`; `pushed` (`exit 0` and not a dry run) |
| `greenlight …` (also via `npx`/`pnpm [exec\|dlx]`/`yarn`/`bunx`/`npm exec`) | `subcommand`; `tool`, the positional the CLI resolves after consuming its value flags; `env`; `argError` when the CLI would reject the argv (unknown flag, missing value); `passed` (`exit 0`, no `argError`, and the shim's own observation not false) |

A rule MUST treat `dstRef: "unknown"` as possibly the protected branch: the loop tasks pair
`before(preview passed, push {dstRef: develop})` with the same rule for `{dstRef: unknown}`, count
pushes with `{dstRef: develop, pushed: true}`, and forbid `{subcommand: promote}`.

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
