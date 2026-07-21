# Greenlight

[![ci](https://github.com/RTrentJones/Greenlight/actions/workflows/ci.yml/badge.svg)](https://github.com/RTrentJones/Greenlight/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rtrentjones/greenlight)](https://www.npmjs.com/package/@rtrentjones/greenlight)
[![license](https://img.shields.io/npm/l/@rtrentjones/greenlight)](LICENSE)

An **opinionated, free-tier-first paved road** for deploying and verifying the personal tools you
build with a coding agent — a blog plus plug-and-play subdomain tools, **web apps or MCP servers** —
each shipped through one gated loop. A single TypeScript manifest turns a domain plus API tokens into
readable Terraform, wired CI, onboarded secrets, and a commit-aware verify harness, **pre-assembled**
for a specific near-zero-cost stack (Cloudflare Workers · Vercel · OCI · Neon/Supabase) so you don't
have to integrate those pieces yourself.

There's no new cloud primitive here and no PaaS in the middle. The value is the **assembly**: the
infra editor, secret onboarding, agent kit, and verification gate are generated *together*, and the
Terraform + workflows land in a repo **you own** — nothing hidden behind a control plane.

**You don't fork this repo — you install the CLI.** `greenlight init` scaffolds a thin **wrapper repo
you own** (your manifest + content) that depends on the published `@rtrentjones/greenlight` package
and updates via `pnpm update`. The CLI **edits** declarative infra-as-code (Terraform you can read);
your **CI/CD applies it**.

## Quick start

```
npx -y @rtrentjones/greenlight init --domain you.dev   # scaffold the wrapper + gather base keys
pnpm greenlight add notes --lane mcp --target oci      # add a tool: emit infra + gather ITS keys
git push                                               # CI (infra.yml) runs `terraform apply`
pnpm greenlight verify notes --env prod                # the shared harness proves it
```

Full walkthrough: **[docs/getting-started.md](docs/getting-started.md)**.

## Scope, honestly

Greenlight is a **paved road, not a general platform** — deliberately narrow where that buys
reliability and a one-command setup:

- **Targets are a fixed, curated matrix**, not "any provider": Astro→Workers, Next→Vercel,
  MCP→Workers/OCI/Docker, agent→Workers, with `d1`/`kv`/`supabase`/`neon` for data. The adapter seam
  is extensible, but you pick from that set.
- **CI is GitHub Actions.** The workflows Greenlight emits are GitHub-Actions-specific.
- **The agent kit is Claude Code** — skills + MCP recommendations shipped as a plugin. A human or an
  agent commit ships through the *identical* loop; Greenlight doesn't execute the agent, it gives one
  a safe, gated road to drive.
- **Artifact-identity enforcement is opt-in per tool.** The `api`-mode gate asserts that the deployed
  commit matches the one being gated — *when the tool serves `{ sha }` at `/__version`* (bake
  `GREENLIGHT_SHA` into the build). A tool that doesn't expose it still passes, health-checked but
  identity-unverified.

If you want a broad, multi-provider IaC engine, reach for **SST** or **Pulumi**. Greenlight's bet is
the opposite: one taste-driven assembly of a zero-/near-zero-cost topology, with the verify gate
wired straight to promotion — the integration you'd otherwise build and maintain yourself.

## Reviewer path (5 minutes)

1. **Architecture in 3 min** — [docs/architecture.md](docs/architecture.md) (one spine, two planes).
2. **See a real consumer** — [RTrentJones.dev](https://github.com/RTrentJones/RTrentJones.dev) (the
   thin wrapper) driving two live tools: [BAMCP](https://github.com/RTrentJones/BAMCP)
   (`mcp`/`oci`, [live](https://bamcp.rtrentjones.dev/mcp) — 401 = up + OAuth-gated) and
   [HeistMind](https://github.com/RTrentJones/HeistMind) (`next`/`vercel`,
   [live](https://heistmind.rtrentjones.dev)).
3. **Run the gate** — `pnpm install && pnpm run check-all` (typecheck + lint + tests + seam + boundaries).
4. **Try it cold, no cloud creds** — [docs/demo.md](docs/demo.md) (`init --no-tokens` → `config` →
   `doctor` → `add … --no-tokens` → `preview`).
5. **Proof** — [npm](https://www.npmjs.com/package/@rtrentjones/greenlight) ·
   [releases](https://github.com/RTrentJones/Greenlight/releases) ·
   [security model](docs/security.md).

> Monorepo note: the repo root is private orchestration (`name: greenlight`, `0.0.0`); the
> **published package is [`cli/`](cli/package.json)** → `@rtrentjones/greenlight`.

## The loop

Every tool (and the blog) ships through the same gated loop — **deploy → verify → promote**. The
`verify` gate is the same code CI **and** the agent run, so changes ship against objective checks
rather than a hand-run smoke test:

```
branch → change → preview → verify → develop/beta → verify → promote (gated develop→main) → prod → verify
```

See **[docs/architecture.md](docs/architecture.md)** for how it all fits together and
[greenlight-v2.md](greenlight-v2.md) for the spec.

## Two planes over one spine

The manifest (`greenlight.config.ts`) + the CLI + the agent kit drive two related planes:

- **Plane 1 — the infra editor.** `greenlight add`/`adopt`: one manifest entry → emitted Terraform +
  gathered/verified tokens (`secrets gather`, straight to GitHub, never to disk/logs) + a wired agent
  kit. It edits IaC; CI/CD applies it.
- **Plane 2 — the validation gate.** One `verify(baseUrl, spec)` harness, six modes (`api`, `mcp`,
  `playwright`, `test`, `agent-web`, `eval`), combinable via an array — wired to promotion, not just
  test-writing.

## How you consume it

This repo is the **framework** (one published npm package + git-tagged Terraform modules + a Claude
Code plugin). Your site is a **thin wrapper you own** — created by `greenlight init`, depending on
the package, owning only its manifest + content (the live example is `RTrentJones.dev`). You update
the mechanics with `pnpm update @rtrentjones/greenlight`; you never merge framework code.

The deploy-verify-promote + per-provider skills ship as a Claude Code plugin (or `greenlight agent sync`):

```
/plugin marketplace add RTrentJones/greenlight
/plugin install greenlight@greenlight
```

## Status

Framework **built, published, and live** — `@rtrentjones/greenlight` on npm (OIDC trusted publishing)
+ Terraform modules tagged in lockstep. Both planes, the loop, lane templates, CI/CD, the
provider-pack registry, the OCI free-tier path (network-as-IaC), and per-tool secret onboarding are
in place; `check-all` green. **Two real tools run on it end to end:** BAMCP (`mcp`/`oci`, free A1
container instance) and HeistMind (`next`/`vercel`/`supabase`), each as a wrapper-centric subrepo
with a green verify gate. MIT.
