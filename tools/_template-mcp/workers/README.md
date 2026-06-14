# `_template-mcp/workers` (optional shape)

Remote MCP on Cloudflare Workers via Cloudflare's [`agents`](https://www.npmjs.com/package/agents) package (`McpAgent` for Durable-Object session state, or `createMcpHandler` for a stateless fetch handler).

**Status / caveat (Phase 4):** `agents` pulls heavy transitive deps (`ai`, `react`) and its bundle does a dynamic `import("ai")` that `wrangler` fails to resolve without an `alias` entry — e.g. in `wrangler.jsonc`:

```jsonc
{ "alias": { "ai": "./src/ai-stub.ts" } }
```

For a simple server this overhead isn't worth it — use the [`../oci`](../oci) Node shape, which proves the same protocol loop locally (`greenlight verify <name> --url http://127.0.0.1:8787/mcp`) with no exotic deps. Reach for `workers` only when you specifically need edge hosting + DO-backed sessions.

Sketch (stateless handler):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'agents/mcp';

const server = new McpServer({ name: 'my-mcp', version: '0.0.0' });
server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
const mcp = createMcpHandler(server);

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return new URL(request.url).pathname === '/mcp'
      ? mcp(request, env, ctx)
      : new Response('connect at /mcp', { status: 404 });
  },
};
```
