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

  it('promotes when develop exists only as a remote-tracking ref (the CI checkout case)', () => {
    // Build a bare origin with main + develop, then a fresh clone with ONLY main checked out —
    // exactly what actions/checkout gives the promote workflow (no local `develop`).
    const origin = mkdtempSync(join(tmpdir(), 'gl-origin-'));
    const ci = mkdtempSync(join(tmpdir(), 'gl-ci-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git('remote', 'add', 'origin', origin);
      git('push', '-q', 'origin', 'main');
      git('checkout', '-q', '-b', 'develop');
      git('commit', '-q', '--allow-empty', '-m', 'feature');
      git('push', '-q', 'origin', 'develop');

      execFileSync('git', ['clone', '-q', '--branch', 'main', origin, ci]);
      const cgit = (...a: string[]) => execFileSync('git', ['-C', ci, ...a], { stdio: 'ignore' });
      cgit('config', 'user.email', 't@e.dev');
      cgit('config', 'user.name', 't');
      cgit('fetch', '-q', '--no-tags', 'origin', 'main', 'develop'); // as the workflow does
      // Sanity: no local develop, only origin/develop.
      expect(() => cgit('rev-parse', '--verify', '--quiet', 'develop')).toThrow();

      expect(canPromote(ci).canPromote).toBe(true); // resolves origin/develop
      const r = promote(ci, { push: true });
      expect(r.promoted).toBe(true);

      // Verify through the (non-bare) clone's remote-tracking refs — re-fetch to see the pushed main.
      cgit('fetch', '-q', 'origin', 'main', 'develop');
      const developTip = execFileSync('git', ['-C', ci, 'rev-parse', 'origin/develop'], {
        encoding: 'utf8',
      }).trim();
      const originMain = execFileSync('git', ['-C', ci, 'rev-parse', 'origin/main'], {
        encoding: 'utf8',
      }).trim();
      expect(originMain).toBe(developTip); // origin/main fast-forwarded to develop
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(ci, { recursive: true, force: true });
    }
  });
});
