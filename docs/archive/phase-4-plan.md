# Phase 4 — The MCP loop (second loop subject)

> **Parent:** [greenlight-v1.md](greenlight-v1.md) §16 Phase 4. **Goal:** prove the `mcp` protocol loop end-to-end on a throwaway MCP server, with the `_template-mcp` lane and per-tool verify specs wired. Unlike the blog deploy, this is **fully validatable locally** — the verify runs over HTTP, no cloud creds.

## What was built

- **`tools/ping-mcp`** — a throwaway MCP server exposing a `ping` tool, plus a `verify.config.ts` (`expectTools: ['ping']`, `call: ping`). Added to the example manifest (`mcp` → `oci`).
- **`_template-mcp`** — real content: the `oci`/Node shape (`oci/server.ts` + `Dockerfile`) as the recommended path, and a `workers/README.md` documenting the edge option + its caveat.
- **`verifyMcp`** now always records a `tools/list responded` check (handshake + list proven even with no `expectTools`).
- **CLI** — `greenlight verify` loads a per-tool `verify.config.ts` (via jiti) when present, else the lane default; `greenlight deploy` prints the `/mcp` connect URL for mcp-lane tools.

## Decision: Node (oci) shape, not Workers `agents`

The plan's `mcp → workers` "cheap dev target" hit a wall: Cloudflare's `agents` package (`McpAgent`/`createMcpHandler`) pulls heavy transitive deps (`ai`, `react`) and its bundle does a dynamic `import("ai")` that `wrangler` can't resolve without an `ai` alias — far too much overhead for a minimal server.

**Resolution:** the throwaway and the primary template are the **Node streamable-HTTP shape** (the same shape BAMCP/`oci` uses — `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`, session-managed). It runs locally with `node`/`tsx`, so the **cheap dev path is "run the Node server locally + `verify --url`"** — which needs neither OCI nor Workers nor creds. The `workers` shape remains documented as an optional edge path (with the `ai`-alias caveat). This keeps the "prove the loop without a live OCI box" goal while dropping the bloat.

## Loop proof (ran locally, no creds)

```
PORT=8799 tsx tools/ping-mcp/src/server.ts
greenlight verify ping-mcp --url http://127.0.0.1:8799/mcp
  ✔ initialize handshake
  ✔ tools/list responded (1 tools)
  ✔ tools/list includes "ping"
  ✔ tools/call ping
  ✔ PASS
```

The full protocol sequence runs against a real MCP server, driven by the CLI loading the per-tool spec. (The in-process Phase 1 mcp test still covers the harness in CI.)

## Acceptance — met

- `verify ping-mcp` runs the full protocol check (initialize → tools/list → call) and passes against the real server.
- `_template-mcp` has real, copy-ready content; per-tool `verify.config.ts` mechanism works.
- `greenlight deploy` prints the mcp connect URL.
- `pnpm run check-all` green.

## Deferred

- Real cloud MCP deploy (oci Docker + Tunnel, or the workers shape) → needs the OCI host / creds (Phase 5/6). The adapter `deploy` for `oci` stays a skeleton until then; the loop is proven locally regardless.
