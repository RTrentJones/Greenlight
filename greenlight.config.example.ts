import { defineConfig } from '@rtrentjones/greenlight-shared';

/**
 * Example manifest — the single source of truth for a Greenlight setup
 * (docs/archive/greenlight-v1.md §4). `greenlight init` copies this to `greenlight.config.ts`
 * and rewrites `domain` + tokens for your setup (§15.3). This file ships with the
 * baseline and MUST stay generic — no real domain (the seam check enforces it).
 */
export default defineConfig({
  domain: 'example.dev',
  alerts: { sink: 'github-issue' },
  blog: { lane: 'astro', target: 'workers', data: 'none' },
  tools: [
    // Sample MCP server (Node streamable-HTTP, the BAMCP/oci shape) — proves the
    // protocol loop. Run `pnpm --filter @rtrentjones/greenlight-ping-mcp start` then
    // `greenlight verify ping-mcp --url http://127.0.0.1:8787/mcp`.
    {
      name: 'ping-mcp',
      lane: 'mcp',
      target: 'oci',
      data: 'none',
      auth: 'none',
      access: 'public',
      envs: ['beta', 'prod'],
    },
    // More examples (uncomment + adjust):
    //
    // A stateful MCP server on OCI (BAMCP shape):
    // { name: "bamcp", lane: "mcp", target: "oci", data: "none", auth: "none", access: "public", envs: ["beta", "prod"] },
    //
    // A Next.js + Supabase app on Vercel (HeistMind shape):
    // { name: "heistmind", lane: "next", target: "vercel", data: "supabase", auth: "oauth", access: "public", envs: ["beta", "prod"] },
  ],
});
