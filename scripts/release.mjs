#!/usr/bin/env node
// Lockstep version bump — the mechanical half of a release, automated so it can't drift.
// Writes MODULE_REF (cli/src/version.ts) + the "version" in cli/package.json and every
// packages/*/package.json to <version>, then runs check-all (the lockstep test is the guard).
// Does NOT commit, tag, or push — the OIDC publish stays gated behind a manual tag push, and the
// version bump can be folded into a larger commit. Usage: node scripts/release.mjs <version> [--no-check]
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
const noCheck = process.argv.includes('--no-check');

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/release.mjs <version> [--no-check]   e.g. 0.5.0');
  process.exit(1);
}
const tag = `v${version}`;

// 1) MODULE_REF in cli/src/version.ts (the Terraform module pin that consumers inherit).
const verTs = join(root, 'cli/src/version.ts');
const verSrc = readFileSync(verTs, 'utf8');
// Anchored to the `export const` assignment so a comment mentioning MODULE_REF can't be rewritten.
const nextVerTs = verSrc.replace(
  /export const MODULE_REF = 'v[0-9.]+';/,
  `export const MODULE_REF = '${tag}';`,
);
if (nextVerTs === verSrc) {
  console.error(`could not find MODULE_REF in ${verTs}`);
  process.exit(1);
}
writeFileSync(verTs, nextVerTs);

// 2) every workspace package.json version (cli + packages/*). The root package.json stays 0.0.0.
const pkgRels = [
  'cli/package.json',
  ...readdirSync(join(root, 'packages')).map((p) => `packages/${p}/package.json`),
];
let bumped = 0;
for (const rel of pkgRels) {
  const p = join(root, rel);
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  // Line-anchored to a top-level `"version":` key so a version-like string elsewhere in the JSON
  // (a dependency range, a comment-ish field) can't be matched instead.
  const next = raw.replace(
    /^(\s*"version":\s*")[0-9]+\.[0-9]+\.[0-9]+(-[\w.]+)?(")/m,
    `$1${version}$3`,
  );
  if (next !== raw) {
    writeFileSync(p, next);
    bumped++;
  }
}
console.log(`✔ ${tag}: MODULE_REF + ${bumped} package.json version(s)`);

// 3) gate on a green check-all (the version.test.ts lockstep test lives in here).
if (noCheck) {
  console.log('(--no-check) skipping check-all');
} else {
  console.log('Running check-all …');
  execSync('pnpm run check-all', { cwd: root, stdio: 'inherit' });
}

console.log(
  `\nNext (gated): commit, then\n  git tag ${tag} && git push origin <branch> && git push origin ${tag}`,
);
