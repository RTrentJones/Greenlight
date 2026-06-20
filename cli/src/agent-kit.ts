/**
 * The Greenlight "agentic dev loop kit" — the curated agent context the framework
 * distributes so the loop is a full positive-feedback cycle: the deploy-verify-promote
 * skill, recommended MCP servers (verification/observability), and best-practice skills.
 * See docs/agentic-loop.md. Materialized into a repo by `greenlight agent sync` / `adopt`.
 *
 * The MCP servers themselves now live in the provider-pack registry (`providers.ts`) so a
 * provider declares its token + guide + MCP + skill + TF module in one place; this module
 * keeps the merge/materialize plumbing.
 */

import { type McpServer, mcpForTool } from './providers';

export type { McpServer };

export interface McpConfig {
  mcpServers: Record<string, McpServer>;
}

export interface ToolKitInfo {
  target?: string;
  data?: string;
}

/** Recommended MCP servers for a tool — sourced from the provider packs that apply to it
 * (Cloudflare always; Vercel for `target: vercel`; Supabase read-only for `data: supabase`). */
export function recommendedMcp(tool?: ToolKitInfo): Record<string, string | McpServer> {
  return mcpForTool(tool);
}

/** Merge recommended servers into an existing `.mcp.json` without clobbering entries.
 * Each value is a URL string (→ `{ type: 'http', url }`) or a full server descriptor. */
export function mergeMcpServers(
  existing: McpConfig | null,
  add: Record<string, string | McpServer>,
): McpConfig {
  const out: McpConfig = { mcpServers: { ...(existing?.mcpServers ?? {}) } };
  for (const [name, val] of Object.entries(add)) {
    if (out.mcpServers[name]) continue;
    out.mcpServers[name] = typeof val === 'string' ? { type: 'http', url: val } : val;
  }
  return out;
}
