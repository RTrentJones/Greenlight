import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { skillAssetDir } from '../asset-paths';

const CLAUDE_BLOCK = `## Greenlight loop (deploy → verify → promote)

This repo uses Greenlight. Ship changes through the deploy-verify-promote skill:
branch → change → deploy preview → \`greenlight verify\` → beta → verify → \`greenlight promote\` → prod → verify.
See \`.claude/skills/deploy-verify-promote/SKILL.md\`.
`;

/**
 * \`greenlight agent sync\` — materialize the deploy-verify-promote skill +
 * a CLAUDE.md loop block into the current repo, from the CLI-bundled skill asset.
 * The §15.7 fallback for environments not using the Greenlight Claude Code plugin.
 */
export async function agentCommand(args: string[]): Promise<void> {
  if (args[0] !== 'sync') {
    console.log(
      'usage: greenlight agent sync   # write the loop skill + CLAUDE.md block into this repo',
    );
    process.exit(args[0] ? 1 : 0);
  }

  const cwd = process.cwd();
  const src = skillAssetDir();
  if (!existsSync(src)) throw new Error(`skill asset not found at ${src}`);

  const dest = resolve(cwd, '.claude/skills/deploy-verify-promote');
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log('✔ wrote .claude/skills/deploy-verify-promote/SKILL.md');

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
    '\nNote: the Greenlight Claude Code plugin (user scope) is the preferred path; this sync is the fallback.',
  );
}
