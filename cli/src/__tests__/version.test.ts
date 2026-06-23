import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODULE_REF } from '../version';

// Resolve the repo root from this file's location (robust to the test runner's cwd).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const readVer = (rel: string) =>
  (JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as { version: string }).version;

// Every publishable/bundled workspace package, discovered (so a new package is auto-covered).
const workspacePkgs = [
  'cli/package.json',
  ...readdirSync(join(repoRoot, 'packages'))
    .map((d) => `packages/${d}/package.json`)
    .filter((p) => existsSync(join(repoRoot, p))),
];

describe('version lockstep (enforces the invariant the silent 0.2.4 drift broke)', () => {
  const cliVersion = readVer('cli/package.json');

  it('MODULE_REF (the Terraform module tag) matches the published CLI version', () => {
    expect(MODULE_REF).toBe(`v${cliVersion}`);
  });

  it('every workspace package is at the same version as the CLI', () => {
    for (const p of workspacePkgs) {
      expect(readVer(p), `${p} should match cli ${cliVersion}`).toBe(cliVersion);
    }
  });
});
