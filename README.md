# Greenlight

A clone-and-own baseline that turns a domain plus API tokens into a live personal site and a
self-verifying agentic deploy loop, with plug-and-play subdomain tools — **web apps or MCP servers**.
Provider-agnostic and free-tier-first: the blog and each tool target Cloudflare Workers or Vercel,
with OCI as the origin lane for stateful services. You own the files; nothing is welded to one cloud.
The CLI **edits** declarative infra-as-code; **CI/CD applies it**.

## The loop

Every tool (and the blog) ships through the same gated loop — **deploy → verify → promote**:

```
greenlight init --domain you.dev                   # scaffold the manifest + secrets store
greenlight add notes --lane mcp --target oci       # one entry → emitted Terraform + tokens + kit
greenlight verify notes --env beta                 # shared harness: api|mcp|playwright|test|agent-web|eval
greenlight promote notes                            # gated develop -> main fast-forward, after beta verify
```

The `verify` gate is the same code CI **and** the agent run, so changes ship with objective
confidence. See **[docs/architecture.md](docs/architecture.md)** for how it all fits together and
[greenlight-v1.md](greenlight-v1.md) for the spec.

## Two planes over one spine

The manifest (`greenlight.config.ts`) + the CLI + the agent kit drive two related planes:

- **Plane 1 — the infra editor.** `greenlight add`/`adopt`: one manifest entry → emitted Terraform +
  gathered/verified tokens (`secrets gather`, straight to GitHub, never to disk/logs) + a wired agent
  kit. It edits IaC; CI/CD applies it.
- **Plane 2 — the validation gate.** One `verify(baseUrl, spec)` harness, six modes, combinable via an
  array — wired to promotion, not just test-writing.

## Consume it

This repo is the framework. A personal site is a **thin consumer** that depends on the single
published package and owns only its manifest + content (see `RTrentJones.dev`):

```
pnpm add @rtrentjones/greenlight     # the CLI (framework libs bundled in)
```

Terraform modules are git-pinned (`?ref=v0.2.5`, in lockstep with the npm version). The
deploy-verify-promote skill + per-provider skills are distributed as a Claude Code plugin:

```
/plugin marketplace add RTrentJones/greenlight
/plugin install greenlight@greenlight
```

Or, without the plugin: `greenlight agent sync`.

## Status

Framework **built and published** — `@rtrentjones/greenlight@0.2.5` on npm (OIDC trusted publishing)
+ Terraform modules tagged `v0.2.5`. Both planes, the loop, lane templates, CI/CD, the provider-pack
registry, and the OCI free-tier path (network-as-IaC: VCN/subnet/AD all Terraform — the only manual
OCI input is the API key) are in place; `check-all` green. First live tool (BAMCP on free-tier OCI) is
mid-onboarding. MIT.
