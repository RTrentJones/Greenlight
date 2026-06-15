/**
 * The Greenlight "agentic dev loop kit" — the curated agent context the framework
 * distributes so the loop is a full positive-feedback cycle: the deploy-verify-promote
 * skill, recommended MCP servers (verification/observability), and best-practice skills.
 * See docs/agentic-loop.md. Materialized into a repo by `greenlight agent sync` / `adopt`.
 */

export interface McpServer {
  type: string;
  url: string;
  /** Optional headers (e.g. a Bearer token via ${ENV} interpolation). */
  headers?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServer>;
}

/** Always-on: Cloudflare is the zone/DNS provider for every Greenlight tool. The
 * aggregate covers Workers/DNS/R2/KV/D1/builds/observability; docs is the Q&A server. */
export const RECOMMENDED_MCP: Record<string, string> = {
  cloudflare: 'https://mcp.cloudflare.com/mcp',
  'cloudflare-docs': 'https://docs.mcp.cloudflare.com/mcp',
};

// Vercel MCP — hosted, OAuth, read-only (authenticate with `/mcp`).
const VERCEL_MCP: Record<string, McpServer> = {
  vercel: { type: 'http', url: 'https://mcp.vercel.com' },
};

// Supabase MCP — hosted, read-only. Needs SUPABASE_ACCESS_TOKEN (+ SUPABASE_PROJECT_REF)
// in the environment; Claude Code expands ${VAR} in url/headers.
const SUPABASE_MCP: Record<string, McpServer> = {
  supabase: {
    type: 'http',
    url: 'https://mcp.supabase.com/mcp?project_ref=${SUPABASE_PROJECT_REF}&read_only=true',
    headers: { Authorization: 'Bearer ${SUPABASE_ACCESS_TOKEN}' },
  },
};

export interface ToolKitInfo {
  target?: string;
  data?: string;
}

/** Recommended MCP servers for a tool: Cloudflare always; Vercel for `target: vercel`;
 * Supabase (read-only) for `data: supabase`. */
export function recommendedMcp(tool?: ToolKitInfo): Record<string, string | McpServer> {
  const out: Record<string, string | McpServer> = { ...RECOMMENDED_MCP };
  if (tool?.target === 'vercel') Object.assign(out, VERCEL_MCP);
  if (tool?.data === 'supabase') Object.assign(out, SUPABASE_MCP);
  return out;
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
