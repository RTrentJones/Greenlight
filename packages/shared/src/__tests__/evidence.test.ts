import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EvidenceRefSchema,
  IdentitySchema,
  RawRecordSchema,
  installedSkills,
  newRawId,
  runIdentity,
  sha256,
  skillsUsedFromEnv,
  treeIdentity,
  truncateExcerpt,
} from '../evidence';

// Vision 08 §5 / roadmap M0-02; acceptance cases from 13 §2.9.

const H = 'a'.repeat(64);
const SHA = 'b'.repeat(40);

function identity(over: Record<string, unknown> = {}) {
  return {
    tool: 'blog',
    env: 'preview',
    sourceRepo: 'owner/repo',
    gitSha: SHA,
    dirty: false,
    wrapperRev: { sha: SHA, verifyConfigHash: H },
    runId: 'local:1',
    attempt: 1,
    skills: { installed: {}, used: 'unknown' },
    ...over,
  };
}

function record(over: Record<string, unknown> = {}) {
  return {
    ...identity(),
    rawId: '20261101T120301Z-ab12cd34',
    kind: 'preview',
    passed: true,
    startedAt: '2026-11-01T12:03:01.000Z',
    durationMs: 10,
    refs: ['pr:owner/repo#12'],
    retained: {
      verdict: 'passed',
      excerpt: '',
      hashes: { excerpt: H },
      fetchedAt: '2026-11-01T12:03:02.000Z',
    },
    ...over,
  };
}

describe('schemas', () => {
  it('accepts a valid identity and record', () => {
    expect(IdentitySchema.safeParse(identity()).success).toBe(true);
    expect(RawRecordSchema.safeParse(record()).success).toBe(true);
  });

  it('requires treeHash iff dirty', () => {
    expect(IdentitySchema.safeParse(identity({ dirty: true })).success).toBe(false);
    expect(IdentitySchema.safeParse(identity({ dirty: true, treeHash: H })).success).toBe(true);
    expect(IdentitySchema.safeParse(identity({ treeHash: H })).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(RawRecordSchema.safeParse(record({ extra: 1 })).success).toBe(false);
  });

  it('requires a bench block iff kind is bench, with env bench', () => {
    expect(RawRecordSchema.safeParse(record({ kind: 'bench' })).success).toBe(false);
    const bench = {
      task: 'replay/x',
      split: 'train',
      model: 'gemini-3.8-flash',
      mode: 'isolation',
      skillSetHash: H,
      evaluationId: 'e1',
      run: 1,
      seed: 's',
    };
    expect(RawRecordSchema.safeParse(record({ kind: 'bench', env: 'bench', bench })).success).toBe(
      true,
    );
    expect(RawRecordSchema.safeParse(record({ kind: 'bench', bench })).success).toBe(false);
    expect(RawRecordSchema.safeParse(record({ bench })).success).toBe(false);
  });

  it('bounds the retained excerpt', () => {
    const r = record({
      retained: {
        verdict: 'failed',
        excerpt: 'x'.repeat(15_001),
        hashes: { excerpt: H },
        fetchedAt: '2026-11-01T12:03:02.000Z',
      },
    });
    expect(RawRecordSchema.safeParse(r).success).toBe(false);
  });

  it('validates evidence refs', () => {
    for (const ok of [
      'issue:o/r#55',
      'pr:o/r#28',
      'commit:o/r@217d1f0',
      'run:o/r/123',
      'raw:20261101T120301Z-ab12cd34',
      'post:https://x.dev/a',
    ]) {
      expect(EvidenceRefSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['issue:55', 'commit:o/r@xyz', 'raw:nope', 'http://x']) {
      expect(EvidenceRefSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gl-ev-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  function repo() {
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    g('add', '.');
    g('commit', '-qm', 'init');
  }

  it('newRawId has the documented shape and is unique', () => {
    const a = newRawId(new Date('2026-11-01T12:03:01.123Z'));
    expect(a).toMatch(/^20261101T120301Z-[0-9a-f]{8}$/);
    expect(newRawId()).not.toBe(newRawId());
  });

  it('truncateExcerpt keeps the tail within the budget and marks the cut', () => {
    const t = truncateExcerpt(`${'h'.repeat(20_000)}TAIL`, 15_000);
    expect(t.length).toBe(15_000);
    expect(t.endsWith('TAIL')).toBe(true);
    expect(t.startsWith('…[truncated')).toBe(true);
    expect(truncateExcerpt('short')).toBe('short');
  });

  it('treeIdentity: clean tree has no treeHash; two dirty trees at one HEAD differ', () => {
    repo();
    const clean = treeIdentity(dir);
    expect(clean.dirty).toBe(false);
    expect(clean.treeHash).toBeUndefined();
    writeFileSync(join(dir, 'a.txt'), 'two');
    const d1 = treeIdentity(dir);
    writeFileSync(join(dir, 'a.txt'), 'three');
    const d2 = treeIdentity(dir);
    expect(d1.gitSha).toBe(clean.gitSha);
    expect(d2.gitSha).toBe(clean.gitSha);
    expect(d1.dirty && d2.dirty).toBe(true);
    expect(d1.treeHash).not.toBe(d2.treeHash);
  });

  it('treeIdentity: untracked non-ignored files count; ignored files do not', () => {
    repo();
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    const base = treeIdentity(dir);
    writeFileSync(join(dir, 'ignored.txt'), 'x');
    expect(treeIdentity(dir).treeHash).toBe(base.treeHash);
    writeFileSync(join(dir, 'new.txt'), 'x');
    expect(treeIdentity(dir).treeHash).not.toBe(base.treeHash);
  });

  it('treeIdentity outside a repo yields a null sha', () => {
    expect(treeIdentity(dir)).toEqual({ gitSha: null, dirty: false });
  });

  it('installedSkills reads version and content hash', () => {
    mkdirSync(join(dir, '.claude/skills/loop'), { recursive: true });
    const text = '---\nname: loop\nversion: "3"\n---\nbody';
    writeFileSync(join(dir, '.claude/skills/loop/SKILL.md'), text);
    expect(installedSkills(dir)).toEqual({ loop: { version: '3', contentHash: sha256(text) } });
  });

  it('skillsUsedFromEnv is unknown unless an observer reported valid stamps', () => {
    expect(skillsUsedFromEnv({})).toBe('unknown');
    expect(skillsUsedFromEnv({ GREENLIGHT_SKILLS_USED: 'not json' })).toBe('unknown');
    expect(skillsUsedFromEnv({ GREENLIGHT_SKILLS_USED: '{"loop":{"version":"3"}}' })).toBe(
      'unknown',
    );
    const ok = JSON.stringify({ loop: { version: '3', contentHash: H } });
    expect(skillsUsedFromEnv({ GREENLIGHT_SKILLS_USED: ok })).toEqual({
      loop: { version: '3', contentHash: H },
    });
  });

  it('runIdentity uses the CI run and attempt when present', () => {
    expect(runIdentity({ GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' })).toEqual({
      runId: 'gha:42',
      attempt: 2,
    });
    expect(runIdentity({}).runId).toMatch(/^local:[0-9a-f]{16}$/);
  });
});
