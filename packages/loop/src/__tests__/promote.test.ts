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

  it('warns (does not silently swallow) when an origin exists but the fetch fails', () => {
    git('checkout', '-q', '-b', 'develop');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    git('checkout', '-q', 'main');
    git('remote', 'add', 'origin', join(tmpdir(), 'gl-no-such-origin.git')); // unreachable path
    const r = canPromote(dir);
    expect(r.warnings?.some((w) => /could not `git fetch origin`/.test(w))).toBe(true);
  });

  it('does NOT warn about fetch for a purely-local repo (no origin)', () => {
    git('checkout', '-q', '-b', 'develop');
    git('commit', '-q', '--allow-empty', '-m', 'feature');
    const r = canPromote(dir); // no origin remote configured
    expect(r.warnings?.some((w) => /git fetch origin/.test(w))).not.toBe(true);
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

  it('promotes the origin (verified) commit even when a local develop is stale (the dev-machine footgun)', () => {
    // The footgun: `git push origin HEAD:develop` advances origin/develop but never moves a LOCAL
    // develop ref. A later promote that preferred the (stale) local develop would silently
    // fast-forward main to an OLD commit and report success. Promote must use origin/develop.
    const origin = mkdtempSync(join(tmpdir(), 'gl-origin-'));
    const work = mkdtempSync(join(tmpdir(), 'gl-work-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git('remote', 'add', 'origin', origin);
      git('push', '-q', 'origin', 'main');
      git('checkout', '-q', '-b', 'develop');
      git('commit', '-q', '--allow-empty', '-m', 'feature-1');
      git('push', '-q', 'origin', 'develop');

      // A working clone with BOTH branches local — local develop sits at feature-1.
      execFileSync('git', ['clone', '-q', origin, work]);
      const wgit = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { stdio: 'ignore' });
      const wout = (...a: string[]) =>
        execFileSync('git', ['-C', work, ...a], { encoding: 'utf8' }).trim();
      wgit('config', 'user.email', 't@e.dev');
      wgit('config', 'user.name', 't');
      wgit('checkout', '-q', 'develop'); // materialize a local develop at feature-1
      wgit('checkout', '-q', 'main');
      const staleLocalDevelop = wout('rev-parse', 'develop');

      // origin/develop advances to feature-2 from elsewhere; the clone's local develop stays behind.
      git('commit', '-q', '--allow-empty', '-m', 'feature-2');
      git('push', '-q', 'origin', 'develop');
      const verifiedTip = execFileSync('git', ['rev-parse', 'develop'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
      expect(verifiedTip).not.toBe(staleLocalDevelop);

      // promote() (via canPromote) fetches + prefers origin/develop, so it promotes feature-2.
      const r = promote(work, { push: true });
      expect(r.promoted).toBe(true);
      expect(r.warnings?.some((w) => /local "develop".*differs from origin\/develop/.test(w))).toBe(
        true,
      );

      wgit('fetch', '-q', 'origin', 'main', 'develop');
      const originMain = wout('rev-parse', 'origin/main');
      expect(originMain).toBe(verifiedTip); // main got the VERIFIED tip, not the stale local one
      expect(originMain).not.toBe(staleLocalDevelop);
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
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
