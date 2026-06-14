// Copy the lane templates + the agent skill INTO the CLI package so a published/installed
// CLI can scaffold tools (`greenlight add`) and materialize the skill (`greenlight agent sync`)
// without the repo present. Runs before tsup (see cli `build` script). Outputs are gitignored.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliDir, '..');

// 1) Lane templates: tools/_template-* -> cli/templates/_template-*
const templatesOut = join(cliDir, 'templates');
rmSync(templatesOut, { recursive: true, force: true });
mkdirSync(templatesOut, { recursive: true });
for (const entry of readdirSync(join(repoRoot, 'tools'))) {
  if (entry.startsWith('_template-')) {
    cpSync(join(repoRoot, 'tools', entry), join(templatesOut, entry), { recursive: true });
  }
}

// 2) Agent skill: .claude/skills/deploy-verify-promote -> cli/assets/skills/deploy-verify-promote
const skillSrc = join(repoRoot, '.claude', 'skills', 'deploy-verify-promote');
const skillOut = join(cliDir, 'assets', 'skills', 'deploy-verify-promote');
rmSync(join(cliDir, 'assets'), { recursive: true, force: true });
mkdirSync(dirname(skillOut), { recursive: true });
cpSync(skillSrc, skillOut, { recursive: true });

console.log('cli: copied templates + skill assets');
