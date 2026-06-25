import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { infraRefs, installedVersion, rewriteInfraRefs } from '../refs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gl-bump-'));
  mkdirSync(join(root, 'infra'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const tf = (name: string, ref: string) =>
  writeFileSync(
    join(root, 'infra', name),
    `module "x" {\n  source = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/neon?ref=${ref}"\n}\n`,
  );

describe('infraRefs', () => {
  it('collects the distinct ?ref pins across infra/*.tf', () => {
    tf('a.tf', 'v0.4.0');
    tf('b.tf', 'v0.4.1');
    expect(infraRefs(root).sort()).toEqual(['v0.4.0', 'v0.4.1']);
  });
  it('is empty when there is no infra dir', () => {
    rmSync(join(root, 'infra'), { recursive: true });
    expect(infraRefs(root)).toEqual([]);
  });
});

describe('rewriteInfraRefs', () => {
  it('rewrites every pin to the target (accepts bare or v-prefixed)', () => {
    tf('a.tf', 'v0.2.27');
    tf('b.tf', 'v0.4.1');
    expect(rewriteInfraRefs(root, '0.5.0').sort()).toEqual(['a.tf', 'b.tf']);
    expect(infraRefs(root)).toEqual(['v0.5.0']);
    expect(readFileSync(join(root, 'infra/a.tf'), 'utf8')).toContain('?ref=v0.5.0');
  });
  it('is idempotent — no change when already aligned', () => {
    tf('a.tf', 'v0.5.0');
    expect(rewriteInfraRefs(root, 'v0.5.0')).toEqual([]);
  });
});

describe('installedVersion', () => {
  it('reads the installed @rtrentjones/greenlight version', () => {
    const pkgDir = join(root, 'node_modules/@rtrentjones/greenlight');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '0.5.0' }));
    expect(installedVersion(root)).toBe('0.5.0');
  });
  it('returns undefined when not installed', () => {
    expect(installedVersion(root)).toBeUndefined();
  });
});
