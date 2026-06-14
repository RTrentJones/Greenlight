import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canPromote, promote } from '../promote';

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

describe('promote', () => {
  it('fast-forwards main to develop and restores the original branch', () => {
    git('checkout', '-q', '-b', 'develop');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    const developTip = execFileSync('git', ['rev-parse', 'develop'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    const r = promote(dir); // from develop -> main, no push
    expect(r.promoted).toBe(true);

    const mainTip = execFileSync('git', ['rev-parse', 'main'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(mainTip).toBe(developTip); // main fast-forwarded to develop
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(head).toBe('develop'); // original branch restored
  });

  it('refuses (no-op) when main has diverged', () => {
    git('checkout', '-q', '-b', 'develop');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    git('checkout', '-q', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'hotfix');
    const mainBefore = execFileSync('git', ['rev-parse', 'main'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    const r = promote(dir);
    expect(r.promoted).toBe(false);

    const mainAfter = execFileSync('git', ['rev-parse', 'main'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(mainAfter).toBe(mainBefore); // nothing moved
  });
});
