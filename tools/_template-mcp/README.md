# `_template-mcp`

Lane template for **MCP servers** — verify mode `mcp` (initialize → `tools/list` → call → auth assertion). Materialized into a tool by `greenlight add`. Two target shapes:

## `oci` — Node streamable-HTTP server (recommended; the BAMCP shape)

A plain Node HTTP server using `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`), containerized and run behind a Cloudflare Tunnel in prod. Best for stateful servers or ones needing local binaries/filesystem (e.g. samtools). See [oci/server.ts](oci/server.ts) + [oci/Dockerfile](oci/Dockerfile). This is the reference implementation — `tools/ping-mcp` is an instance of it.

Local dev / loop proof (no cloud):
```
PORT=8787 node oci/server.ts            # or `pnpm --filter <pkg> start`
greenlight verify <name> --url http://127.0.0.1:8787/mcp
```

## `workers` — remote MCP on the edge (optional)

Cloudflare's `agents` package (`McpAgent` / `createMcpHandler`) can host a remote MCP on Workers. **Caveat:** `agents` pulls heavy transitive deps (`ai`, `react`) and currently needs an `ai` alias in `wrangler` config to bundle. For a simple server, prefer the `oci`/Node shape above; reach for `workers` only when you specifically want edge hosting + Durable-Object session state.

## Verify spec

Ship a `verify.config.ts` (default export) so `greenlight verify` asserts the real contract:
```ts
export default { mode: 'mcp', expectTools: ['<tool>'], call: { name: '<tool>' } };
```

## Auth

`auth: none` only for public read-only servers. Mutating/private servers default to `bearer`/`oauth` (docs/archive/greenlight-v1.md §6/§14).
