#!/usr/bin/env node
// Guard: plugin/skills/* must be a byte-identical mirror of .claude/skills/* (the marketplace
// plugin is generated from the canonical skills by cli/scripts/copy-assets.mjs). Editing a skill
// without regenerating the plugin would ship stale skills to plugin consumers — this fails CI on
// that drift. Fix: `pnpm build:packages` (runs copy-assets) then commit plugin/skills.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '.claude', 'skills');
const mirror = join(root, 'plugin', 'skills');

/** Relative path -> contents for every file under `dir`. */
function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

const a = snapshot(src);
const b = snapshot(mirror);
const problems = [];
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (!(k in b)) problems.push(`missing in plugin/skills: ${k}`);
  else if (!(k in a)) problems.push(`extra in plugin/skills (not in .claude/skills): ${k}`);
  else if (a[k] !== b[k]) problems.push(`out of sync: ${k}`);
}

if (problems.length) {
  console.error('✘ plugin/skills is out of sync with .claude/skills:');
  for (const p of problems) console.error(`   - ${p}`);
  console.error(
    '\nFix: `pnpm build:packages` (regenerates the mirror), then commit plugin/skills.',
  );
  process.exit(1);
}
console.log(`✔ plugin/skills mirrors .claude/skills (${Object.keys(a).length} files)`);
