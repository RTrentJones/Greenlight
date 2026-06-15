import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type McpConfig, type ToolKitInfo, mergeMcpServers, recommendedMcp } from '../agent-kit';
import { skillAssetDir } from '../asset-paths';

const CLAUDE_BLOCK = `## Greenlight loop (deploy → verify → promote)

This repo uses Greenlight. Ship changes through the deploy-verify-promote skill:
branch → change → deploy preview → \`greenlight verify\` → beta → verify → \`greenlight promote\` → prod → verify.

Agentic kit:
- Skill: \`.claude/skills/deploy-verify-promote/SKILL.md\` (the loop).
- MCP servers: \`.mcp.json\` recommends the relevant providers — run \`/mcp\` to authenticate.
    Vercel is OAuth; Supabase needs \`SUPABASE_ACCESS_TOKEN\` (+ \`SUPABASE_PROJECT_REF\`) in your env.
- Best-practice skills (one-time, user scope):
    \`claude plugin marketplace add cloudflare/skills && claude plugin install cloudflare@cloudflare\`
`;

/**
 * Materialize the agentic dev loop kit into `dir`: the deploy-verify-promote skill,
 * a merged `.mcp.json` (recommended MCP servers, tailored to the tool's target/data),
 * and a CLAUDE.md loop block. Shared by `agent sync` (cwd) and `adopt` (the target
 * repo). Never clobbers app files.
 */
export function materializeAgentKit(dir: string, tool?: ToolKitInfo): void {
  const src = skillAssetDir();
  if (!existsSync(src)) throw new Error(`skill asset not found at ${src}`);
  const dest = resolve(dir, '.claude/skills/deploy-verify-promote');
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log('✔ .claude/skills/deploy-verify-promote/SKILL.md');

  const mcpPath = resolve(dir, '.mcp.json');
  const existingMcp = existsSync(mcpPath)
    ? (JSON.parse(readFileSync(mcpPath, 'utf8')) as McpConfig)
    : null;
  const servers = recommendedMcp(tool);
  writeFileSync(mcpPath, `${JSON.stringify(mergeMcpServers(existingMcp, servers), null, 2)}\n`);
  console.log(`✔ .mcp.json (${Object.keys(servers).length} recommended MCP server(s))`);

  const claudePath = resolve(dir, 'CLAUDE.md');
  const marker = 'Greenlight loop (deploy → verify → promote)';
  const existing = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  if (existing.includes(marker)) {
    console.log('· CLAUDE.md already has the loop block');
  } else {
    writeFileSync(claudePath, existing ? `${existing.trimEnd()}\n\n${CLAUDE_BLOCK}` : CLAUDE_BLOCK);
    console.log(`✔ CLAUDE.md (${existing ? 'appended' : 'created'})`);
  }
}

/**
 * `greenlight agent sync` — materialize the kit into the current repo (the §15.7
 * fallback for environments not using the Greenlight Claude Code plugin).
 */
export async function agentCommand(args: string[]): Promise<void> {
  if (args[0] !== 'sync') {
    console.log(
      'usage: greenlight agent sync   # write the loop skill + .mcp.json + CLAUDE.md block',
    );
    process.exit(args[0] ? 1 : 0);
  }
  materializeAgentKit(process.cwd());
  console.log(
    '\nNote: the Greenlight Claude Code plugin (user scope) is the preferred path; this sync is the fallback.\nRun `/mcp` to authenticate the MCP servers.',
  );
}
