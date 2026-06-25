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

// 2) Agent skills: every dir under .claude/skills/ -> cli/assets/skills/ (the loop skill
// + the per-provider skills the registry materializes).
const skillsSrc = join(repoRoot, '.claude', 'skills');
const skillsOut = join(cliDir, 'assets', 'skills');
rmSync(join(cliDir, 'assets'), { recursive: true, force: true });
mkdirSync(skillsOut, { recursive: true });
for (const entry of readdirSync(skillsSrc)) {
  cpSync(join(skillsSrc, entry), join(skillsOut, entry), { recursive: true });
}

// 3) Plugin mirror: .claude/skills/* -> plugin/skills/* (the Claude Code marketplace plugin, a
// COMMITTED pure mirror — `plugin/.claude-plugin` holds the manifest and is left untouched). Done
// here so editing a skill once propagates to the plugin on build; `check-plugin-sync` guards drift.
const pluginSkills = join(repoRoot, 'plugin', 'skills');
rmSync(pluginSkills, { recursive: true, force: true });
mkdirSync(pluginSkills, { recursive: true });
for (const entry of readdirSync(skillsSrc)) {
  cpSync(join(skillsSrc, entry), join(pluginSkills, entry), { recursive: true });
}

console.log('cli: copied templates + skill assets + plugin mirror');
