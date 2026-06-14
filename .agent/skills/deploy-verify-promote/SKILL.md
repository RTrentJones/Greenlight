---
name: deploy-verify-promote
description: Ship a change through Greenlight's loop — branch, deploy to preview/beta, verify with the shared harness, then gated-promote develop→main to prod. Use when shipping or promoting a Greenlight tool or the blog.
---

# deploy-verify-promote

Run the Greenlight loop for one manifest entry. The verify harness and promote guard
are the same code CI runs — see [.agent/CLAUDE.md](../../CLAUDE.md) for the URL scheme.

## Input

- `<name>` — a manifest entry: `blog`, or a tool name from `greenlight.config.ts`.

## Procedure

1. **Branch** — `git checkout -b <type>/<slug>` (e.g. `post/hello`, `fix/mcp-auth`).
2. **Preview** — push; the target's git integration produces a preview deploy. Verify it
   (CI uses `runLoop`; standalone: `pnpm greenlight verify <name> --env preview`).
3. **Beta** — merge to `develop` → beta deploy. `pnpm greenlight verify <name> --env beta`.
   The mode is chosen by lane: `api`/`playwright` for web, `mcp` for MCP servers.
4. **Promote** — `pnpm greenlight promote <name>`. This checks the fast-forward guard
   (`develop → main`). If it refuses (diverged `main`), reconcile and retry — never force-push.
5. **Prod** — after promote, `pnpm greenlight verify <name> --env prod`.

## Pass/fail

`verify` exits non-zero if any check fails; the report lists each check. Do not promote
a tool whose beta verify is failing.

## Notes

- Connect URL for MCP tools is the tool URL + `/mcp`; `verify --env` handles this by lane.
- Real per-target deploys are wired in phases (greenlight-v1.md §16); the loop, verify,
  and promote guard are stable now.
