import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canPromote } from '../promote';

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gl-promote-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.dev');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('canPromote', () => {
  it('allows a fast-forward when main is an ancestor of develop', () => {
    git('checkout', '-q', '-b', 'develop');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    const r = canPromote(dir);
    expect(r.canPromote).toBe(true);
  });

  it('refuses when main has diverged from develop', () => {
    git('checkout', '-q', '-b', 'develop');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    git('checkout', '-q', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'hotfix'); // main now ahead of branch point
    const r = canPromote(dir);
    expect(r.canPromote).toBe(false);
    expect(r.reason).toMatch(/diverged/i);
  });

  it('refuses when a branch is missing', () => {
    const r = canPromote(dir); // no develop branch
    expect(r.canPromote).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });
});
