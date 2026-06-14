# Greenlight

A clonable baseline that turns a domain plus API tokens into a live personal site and a self-verifying AI deploy loop, with plug-and-play subdomain tools. Provider-agnostic: the blog and each tool can target Cloudflare Workers or Vercel, with OCI as the origin lane for stateful services. You own the files; nothing is welded to one cloud.

## The loop

Every tool (and the blog) ships through the same gated loop — **deploy → verify → promote**:

```
greenlight init --domain you.dev          # scaffold the manifest + secrets store
greenlight add notes --lane mcp --target oci   # scaffold a tool from a lane template
greenlight verify notes --env beta        # run the shared verify harness (api | playwright | mcp)
greenlight promote notes                  # gated develop -> main fast-forward, after beta verify
```

The `verify` gate is the same code CI and the agent run, so a change is shipped with objective confidence — see [docs/](docs/) for the per-phase build plans and [greenlight-v1.md](greenlight-v1.md) for the full spec.

## Consume it

This repo is the framework. A personal site is a **thin consumer** that depends on the published `@rtrentjones/greenlight*` packages and owns only its manifest + content (see `RTrentJones.dev`). The deploy-verify-promote skill is distributed as a Claude Code plugin:

```
/plugin marketplace add RTrentJones/greenlight
/plugin install greenlight@greenlight
```

Or, without the plugin: `greenlight agent sync`.

## Status

Phases 0–7 built and locally verified (manifest, the loop, lane templates, CI/CD, CLI, Terraform module, packaging + plugin). `npm publish` and the first live Cloudflare deploy are the remaining creds-gated steps. MIT.
