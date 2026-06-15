import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type McpConfig, RECOMMENDED_MCP, mergeMcpServers } from '../agent-kit';
import { skillAssetDir } from '../asset-paths';

const CLAUDE_BLOCK = `## Greenlight loop (deploy → verify → promote)

This repo uses Greenlight. Ship changes through the deploy-verify-promote skill:
branch → change → deploy preview → \`greenlight verify\` → beta → verify → \`greenlight promote\` → prod → verify.

Agentic kit:
- Skill: \`.claude/skills/deploy-verify-promote/SKILL.md\` (the loop).
- MCP servers: \`.mcp.json\` recommends Cloudflare's — run \`/mcp\` to authenticate.
- Best-practice skills (one-time, user scope):
    \`claude plugin marketplace add cloudflare/skills && claude plugin install cloudflare@cloudflare\`
`;

/**
 * \`greenlight agent sync\` — materialize the agentic dev loop kit into the current
 * repo: the deploy-verify-promote skill, a \`.mcp.json\` recommending the loop's MCP
 * servers, and a CLAUDE.md block. The §15.7 fallback for non-plugin environments.
 */
export async function agentCommand(args: string[]): Promise<void> {
  if (args[0] !== 'sync') {
    console.log(
      'usage: greenlight agent sync   # write the loop skill + .mcp.json + CLAUDE.md block',
    );
    process.exit(args[0] ? 1 : 0);
  }

  const cwd = process.cwd();

  // 1) The loop skill.
  const src = skillAssetDir();
  if (!existsSync(src)) throw new Error(`skill asset not found at ${src}`);
  const dest = resolve(cwd, '.claude/skills/deploy-verify-promote');
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log('✔ wrote .claude/skills/deploy-verify-promote/SKILL.md');

  // 2) Recommended MCP servers (merge, never clobber).
  const mcpPath = resolve(cwd, '.mcp.json');
  const existingMcp = existsSync(mcpPath)
    ? (JSON.parse(readFileSync(mcpPath, 'utf8')) as McpConfig)
    : null;
  writeFileSync(
    mcpPath,
    `${JSON.stringify(mergeMcpServers(existingMcp, RECOMMENDED_MCP), null, 2)}\n`,
  );
  console.log(
    `✔ wrote .mcp.json (${Object.keys(RECOMMENDED_MCP).length} recommended MCP server(s))`,
  );

  // 3) CLAUDE.md loop block.
  const claudePath = resolve(cwd, 'CLAUDE.md');
  const marker = 'Greenlight loop (deploy → verify → promote)';
  const existing = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  if (existing.includes(marker)) {
    console.log('· CLAUDE.md already has the loop block');
  } else {
    writeFileSync(claudePath, existing ? `${existing.trimEnd()}\n\n${CLAUDE_BLOCK}` : CLAUDE_BLOCK);
    console.log(`✔ ${existing ? 'appended loop block to' : 'created'} CLAUDE.md`);
  }

  console.log(
    '\nNote: the Greenlight Claude Code plugin (user scope) is the preferred path; this sync is the fallback.\nRun `/mcp` to authenticate the MCP servers.',
  );
}
