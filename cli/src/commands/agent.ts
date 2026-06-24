import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type McpConfig, type ToolKitInfo, mergeMcpServers, recommendedMcp } from '../agent-kit';
import { skillAssetDir } from '../asset-paths';
import { loadManifest, resolveEntry } from '../manifest';
import { packsForTool } from '../providers';

const CLAUDE_BLOCK = `## Greenlight loop (deploy → verify → promote)

This repo uses Greenlight. Deliver every change through the ONE model (same shape for web + MCP
tools — the deploy-verify-promote skill has the lane×target matrix):
branch → change → \`greenlight preview <name>\` (local gate) → add it to the tool's verify.config →
push (CI gates on the tool's own tests) → deploy → \`greenlight verify <name> --env prod\`.
Web tools also get beta + \`greenlight promote\`; oci is direct-to-prod (the local gate is the
pre-prod safety). \`greenlight status <name>\` shows the run chain; \`greenlight doctor\` flags drift.

Agentic kit:
- Skill: \`.claude/skills/deploy-verify-promote/SKILL.md\` (the one model + the matrix).
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

  // Per-provider skills — copy the skill of each provider pack that applies to this tool
  // (Cloudflare/HCP/GitHub always; Vercel/Supabase/OCI by target/data). Missing skill
  // assets are skipped (forward-compatible with packs that don't ship one).
  for (const pack of packsForTool(tool)) {
    if (!pack.skill) continue;
    const skillSrc = skillAssetDir(pack.skill);
    if (!existsSync(skillSrc)) continue;
    const skillDest = resolve(dir, '.claude/skills', pack.skill);
    mkdirSync(skillDest, { recursive: true });
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log(`✔ .claude/skills/${pack.skill}/SKILL.md`);
  }

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
      'usage: greenlight agent sync [<name>]\n' +
        '  (no name)  write the generic loop kit into THIS repo (the fallback)\n' +
        "  <name>     load the manifest and sync that tool's kit into its dir, with the\n" +
        '             target-specific provider skills (oci/vercel/supabase), not just the always-on ones',
    );
    process.exit(args[0] ? 1 : 0);
  }

  // Tool-aware sync: a named tool gets its target/data from the manifest so `packsForTool` includes
  // the target-specific provider skills. Bare `agent sync` (no name) only materializes the always-on
  // packs into cwd — fine for a single-tool repo, but it MISSES oci/vercel/supabase on a re-sync.
  const name = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
  if (name) {
    const { config } = await loadManifest();
    const entry = resolveEntry(config, name);
    const dir = resolve(process.cwd(), entry.dir ?? '.');
    materializeAgentKit(dir, { lane: entry.lane, target: entry.target, data: entry.data });
    console.log(
      `\nSynced the kit for "${name}" → ${entry.dir ?? '.'} (lane=${entry.lane}, target=${entry.target}, data=${entry.data}).`,
    );
    return;
  }

  materializeAgentKit(process.cwd());
  console.log(
    '\nNote: the Greenlight Claude Code plugin (user scope) is the preferred path; this sync is the fallback.\nRun `/mcp` to authenticate the MCP servers.',
  );
}
