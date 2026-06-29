# Plan — Neon (data) + Agents (tool category)

> **SHIPPED** — both aims are built and live: Neon (`data: neon`, on `tracer`) and the `agent` lane
> (on `muse`). This is the original build plan, kept as the design record.
>
> Forward design for the two (then-)§14 aims, planned together because they share one seam (the
> **provider-pack registry** + [adding-a-provider.md](adding-a-provider.md)) and compose into one
> dogfood: an **agent** tool that persists its state to **Neon**. Build Neon first (well-defined,
> unblocks stateful agents); agents second (needs the design pass below).

## Why together

Greenlight's two extension axes are **`data`** (the store) and **`lane`** (what a tool is). Neon
extends `data`; agents extend `lane`. Both go through the same registry where a provider declares its
`{ token, guide, MCP, skill, TF module }` in one place ([cli/src/providers.ts](../cli/src/providers.ts)).
Doing them in sequence validates that seam from two angles — and the natural first agent **needs a
place to keep state**, which is exactly what Neon gives (scale-to-zero Postgres, no keepalive). So
the joint dogfood is one tool that exercises both new axes at once.

---

## Part 1 — Neon (a new `data` backend)

**The model.** One Neon project; **a branch per env** (git-style: `main`→prod, `develop`→beta,
each PR→an ephemeral copy-on-write branch), **scale-to-zero** so there's **no keepalive** (the design
doc's stated reason Neon is the default Postgres). This is strictly better than the Supabase model
(project-per-env + a 7-day-pause keepalive heartbeat) for anything that doesn't need Supabase's
bundled auth+storage+realtime.

**What to build** (the [adding-a-provider.md](adding-a-provider.md) checklist, Neon as the worked example):

1. **Provider pack** — add a `neon` entry to [providers.ts](../cli/src/providers.ts): token
   `NEON_API_KEY` (+ the project id once created), a get-the-key guide, the **Neon MCP server** for
   the agent kit, a `provider-neon` skill, and a pointer to the TF module.
2. **TF module** `infra/modules/neon`: a `neon_project` + a `neon_branch` per env, using the Neon
   Terraform provider. Outputs the **pooled** (pgbouncer) and **direct** connection strings per env.
   Pooled is the default for serverless (Vercel) callers; direct for migrations.
3. **Schema** — add `'neon'` to the `data` enum in [packages/shared](../packages/shared/src/schema.ts);
   tools set `data: 'neon'`.
4. **Wiring** — emit the per-env `DATABASE_URL` (pooled) + `DIRECT_URL` to the tool: Vercel env vars
   (per target) for a `next`/`vercel` tool, container env for `oci`. The branch a given env points at
   is the env's Neon branch.
5. **Migrations** — Neon tools run migrations against the env's branch; the new **`migrations scan`
   gate** (v0.2.24) runs in their CI before apply. A PR's ephemeral branch is the safe place to test a
   migration before it touches `main`.
6. **Liveness exemptions** — `doctor`'s keepalive-coverage check ([doctor.ts](../cli/src/commands/doctor.ts))
   must **not** flag `data: 'neon'` (it has no pause), and the keepalive Worker shouldn't target it.
   Only `data: supabase` + `target: oci` keep needing keepalive.
7. **Docs** — fill in Neon as the concrete walkthrough in `adding-a-provider.md` (validates the guide
   by building from it).

**Dogfood + sequence.** Stand up Neon on a throwaway `next`/`vercel`/`neon` tool first (proves
branch-per-env + the wiring end to end), then it's a real option for HeistMind-class apps. A
**HeistMind Supabase→Neon migration** is a *possible* later payoff (drops the keepalive heartbeat) but
it's a real data migration — keep it out of scope for the first cut; the win is making Neon *available*.

**Open decisions:** which Neon TF provider (official `terraform-provider-neon` vs community); whether
PR-ephemeral branches auto-delete on PR close (a Worker/Action cleanup, like Vercel previews);
pooled-vs-direct default per target.

---

## Part 2 — Agents (a new tool category)

§14 frames this as the least-defined aim ("an agents lane/target beyond MCP — the same loop, a
fitting verify mode; `eval` is the seed"). This is a **design spike first**, then a thin build. The
plan is to resolve these decisions, not pre-commit code.

**What an agent tool *is* (vs MCP).** An MCP server *exposes* tools to a client. An agent tool *is*
the client/orchestrator — it has a goal, loops, and calls LLMs + tools (possibly including our own MCP
servers, e.g. an agent that uses BAMCP's genomics tools). It's a deployed program that does a task.

**Decisions to resolve:**

1. **Lane, not target.** An agent is a *kind of program* (like `mcp`/`next`), so it's a **`lane`**; it
   runs *on* a target. Default target **`workers`** (a Cron Trigger — scheduled, scale-to-zero, free,
   exactly the keepalive pattern) for scheduled/event agents; **`oci`** for stateful/long-running ones.
2. **Trigger model.** Three shapes the lane template should cover: **scheduled** (cron), **event**
   (webhook / `repository_dispatch`), **on-demand** (an HTTP endpoint). Most first agents are scheduled.
3. **Verify mode.** Reuse/extend the LLM-judged plane: trigger the agent on a **fixture task** and
   judge the outcome — `eval` is the seed (call the agent, score its output against a rubric); a thin
   **`agent-task`** mode could assert the agent reached a goal state (the non-UI sibling of
   `agent-web`). Bound the cost with the **`agent-web` subscription driver** (§14, `claude -p`) so
   verify doesn't burn API credits each run.
4. **Runtime + template.** A `_template-agents` lane built on the Claude Agent SDK (or `@anthropic-ai/sdk`),
   with the agent loop + a tool-call surface. The pack declares `ANTHROPIC_API_KEY` (or the
   subscription path) as its token.
5. **State → Neon.** A stateful agent needs memory/results storage — `data: 'neon'`. This is the
   compose point: the first agent is `lane: agents` + `target: workers` + `data: neon`.
6. **Safety + auth.** An agent that *acts* (writes, posts, spends) inherits the mutating-MCP rules:
   never unauthenticated, scoped tokens, and — for anything destructive — a human-in-the-loop gate.

**A minimal first agent (the dogfood).** Pick one small, genuinely-useful scheduled agent — e.g. a
weekly "what changed across my tools" digest, or an agent that drafts a blog-post outline from recent
commits — `agents`/`workers`/`neon`, verified by an `eval` fixture. Small enough to prove the lane +
the Neon compose, useful enough to keep on (the blog was the loop's first subject; this is the agent
lane's).

**Open decisions:** `eval`-extended vs a new `agent-task` verify mode; subscription-driver vs
API-key for the verify LLM; whether the agent runtime is bundled (a template) or referenced (an SDK
dep); how a human-in-the-loop gate is expressed for acting agents.

---

## Sequencing & effort

| Step | Effort | Risk | Unblocks |
|---|---|---|---|
| **Neon provider pack + TF module** | Medium | Low (well-trodden: a new `data` pack) | stateful tools without keepalive |
| **Neon dogfood (throwaway tool) + docs** | Small | Low | proves branch-per-env + adding-a-provider.md |
| **Agents design spike** (resolve the decisions above) | Small (a design note) | — | a buildable agents lane |
| **`_template-agents` + verify mode + pack** | Medium | Medium (new category, cost/safety) | the agent lane |
| **First agent dogfood** (`agents`/`workers`/`neon`) | Medium | Medium | proves both axes + their compose |

**Recommended order:** Neon pack → Neon dogfood + docs → agents design spike → agents template/verify →
first agent (on Neon). Neon is the lower-risk, higher-certainty win and is a prerequisite for a
stateful agent; agents get a deliberate design pass before any code. Each ships through the normal
deploy→verify→promote loop and a lockstep release.
