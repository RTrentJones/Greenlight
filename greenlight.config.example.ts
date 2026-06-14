import { defineConfig } from '@rtrentjones/greenlight-shared';

/**
 * Example manifest — the single source of truth for a Greenlight setup
 * (greenlight-v1.md §4). `greenlight init` copies this to `greenlight.config.ts`
 * and rewrites `domain` + tokens for your setup (§15.3). This file ships with the
 * baseline and MUST stay generic — no real domain (the seam check enforces it).
 */
export default defineConfig({
  domain: 'example.dev',
  alerts: { sink: 'github-issue' },
  blog: { lane: 'astro', target: 'workers', data: 'none' },
  tools: [
    // Add tools with `greenlight add`. Examples (uncomment + adjust):
    //
    // A throwaway MCP server on the edge (dev target for the protocol loop):
    // { name: "throwaway-mcp", lane: "mcp", target: "workers", data: "none", auth: "none", access: "public", envs: ["preview", "beta"] },
    //
    // A stateful MCP server on OCI (BAMCP shape):
    // { name: "bamcp", lane: "mcp", target: "oci", data: "none", auth: "none", access: "public", envs: ["beta", "prod"] },
    //
    // A Next.js + Supabase app on Vercel (HeistMind shape):
    // { name: "heistmind", lane: "next", target: "vercel", data: "supabase", auth: "oauth", access: "public", envs: ["beta", "prod"] },
  ],
});
