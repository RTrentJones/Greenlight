import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWorkspaceMember } from '../commands/add';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gl-add-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ws = () => readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');

describe('registerWorkspaceMember', () => {
  it('creates pnpm-workspace.yaml with the member when absent', () => {
    registerWorkspaceMember(root, 'tools/site');
    expect(ws()).toContain('packages:');
    expect(ws()).toContain('- "tools/site"');
  });

  it('appends to an existing packages list, preserving prior members', () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    registerWorkspaceMember(root, 'tools/site');
    expect(ws()).toContain('- "apps/*"');
    expect(ws()).toContain('- "tools/site"');
  });

  it('is idempotent when the member is already listed', () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "tools/site"\n');
    registerWorkspaceMember(root, 'tools/site');
    expect(ws().match(/tools\/site/g)?.length).toBe(1);
  });

  it('no-ops when a tools/* glob already covers it', () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "tools/*"\n');
    registerWorkspaceMember(root, 'tools/site');
    expect(ws()).not.toContain('tools/site');
  });
});
