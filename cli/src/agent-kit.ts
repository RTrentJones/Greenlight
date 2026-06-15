/**
 * The Greenlight "agentic dev loop kit" — the curated agent context the framework
 * distributes so the loop is a full positive-feedback cycle: the deploy-verify-promote
 * skill, recommended MCP servers (verification/observability), and best-practice skills.
 * See docs/agentic-loop.md. Materialized into a repo by `greenlight agent sync`.
 */

/** Recommended remote MCP servers (Cloudflare). The aggregate covers Workers/DNS/
 * R2/KV/D1/builds/observability; docs is the documentation Q&A server. */
export const RECOMMENDED_MCP: Record<string, string> = {
  cloudflare: 'https://mcp.cloudflare.com/mcp',
  'cloudflare-docs': 'https://docs.mcp.cloudflare.com/mcp',
};

export interface McpConfig {
  mcpServers: Record<string, { type: string; url: string }>;
}

/** Merge recommended servers into an existing `.mcp.json` without clobbering entries. */
export function mergeMcpServers(
  existing: McpConfig | null,
  add: Record<string, string>,
): McpConfig {
  const out: McpConfig = { mcpServers: { ...(existing?.mcpServers ?? {}) } };
  for (const [name, url] of Object.entries(add)) {
    if (!out.mcpServers[name]) out.mcpServers[name] = { type: 'http', url };
  }
  return out;
}
