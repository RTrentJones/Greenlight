import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkProposalContent, purposeRadiusChange } from '../../bundle';
import { appendEvents, renderSkillImpact } from '../../ledger';
import { loadWiki } from '../../load';
import {
  LedgerEventSchema,
  MAINTAINER_OUTPUT_JSON_SCHEMA,
  MaintainerOutputSchema,
  PROPOSER_ACTION_FIELDS,
  PROPOSER_OUTPUT_JSON_SCHEMA,
  ProposerOutputSchema,
  checkProposalHistory,
  normalizeProposerOutput,
  sealEvent,
} from '../../schema';
import { acquireLock, blastRadius, loadControls, materializeCandidate, pinTree } from '../iterate';

/** Unit cases for `bench iterate` (roadmap M2-01/M2-04) that need no rollout: the hand-written
 * JSON Schemas stay in step with the zod contracts, the review annotation's place in the stage
 * machine, blast radius defaults and the control arm loader. The end-to-end iteration is in
 * cli/src/__tests__/bench-iterate.test.ts. */

const BENCH = resolve(__dirname, '../../../../../bench');

describe('model-facing JSON Schemas (one place, beside the zod schemas)', () => {
  it('MaintainerOutput: the same top-level keys, all required', () => {
    const zodKeys = Object.keys(
      (MaintainerOutputSchema as unknown as { _def: { schema: { shape: object } } })._def.schema
        .shape,
    ).sort();
    expect(Object.keys(MAINTAINER_OUTPUT_JSON_SCHEMA.properties).sort()).toEqual(zodKeys);
    expect([...MAINTAINER_OUTPUT_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
  });

  it('ProposerOutput: every field of every action is a property, and nothing else', () => {
    const fromZod = new Set<string>();
    for (const o of ProposerOutputSchema.options)
      for (const k of Object.keys(o.shape)) fromZod.add(k);
    expect(Object.keys(PROPOSER_OUTPUT_JSON_SCHEMA.properties).sort()).toEqual([...fromZod].sort());
    for (const o of ProposerOutputSchema.options) {
      const action = (o.shape.action as { value: string }).value;
      expect([...(PROPOSER_ACTION_FIELDS[action] ?? [])].sort()).toEqual(
        Object.keys(o.shape).sort(),
      );
    }
  });

  it('normalizeProposerOutput drops the fields the action does not take', () => {
    const flat = {
      action: 'no_action',
      reason: 'nothing to change',
      outlet: '',
      edits: [],
      patterns: [],
    };
    expect(ProposerOutputSchema.safeParse(flat).success).toBe(false);
    expect(ProposerOutputSchema.parse(normalizeProposerOutput(flat))).toEqual({
      action: 'no_action',
      reason: 'nothing to change',
    });
    const patch = normalizeProposerOutput({
      action: 'patch',
      outlet: 'skill',
      name: 'provider-neon',
      edits: [{ file: 'SKILL.md', op: 'append', target: '', text: 'x' }],
      patterns: ['pattern/neon-never-sleeps'],
      reason: '',
    });
    expect(ProposerOutputSchema.safeParse(patch).success).toBe(true);
  });
});

describe('the review annotation (08 §8)', () => {
  const e = (stage: string) => ({ stage }) as never;
  it('follows any stage, final ones included, and never moves the stage machine', () => {
    expect(checkProposalHistory([e('candidate-rejected'), e('review')])).toEqual([]);
    expect(checkProposalHistory([e('no-action'), e('review'), e('review')])).toEqual([]);
    expect(checkProposalHistory([e('candidate-accepted'), e('review'), e('merged')])).toEqual([]);
    expect(checkProposalHistory([e('candidate-rejected'), e('review'), e('merged')])).toEqual([
      'stage "merged" cannot follow "candidate-rejected"',
    ]);
    expect(checkProposalHistory([e('review')])).toEqual([
      'stage "review" cannot open a proposal\'s history',
    ]);
  });

  it('a review event needs a reason and its review; review rides only review and withdrawn', () => {
    const base = { ts: '2026-11-12T00:00:00Z', proposalId: 'p' };
    expect(
      LedgerEventSchema.safeParse(
        sealEvent({ ...base, stage: 'review', reason: 'ok', review: { decision: 'accept' } }),
      ).success,
    ).toBe(true);
    expect(
      LedgerEventSchema.safeParse(sealEvent({ ...base, stage: 'review', reason: 'ok' })).success,
    ).toBe(false);
    expect(
      LedgerEventSchema.safeParse(
        sealEvent({ ...base, stage: 'review', review: { decision: 'accept' } }),
      ).success,
    ).toBe(false);
    expect(
      LedgerEventSchema.safeParse(
        sealEvent({
          ...base,
          stage: 'withdrawn',
          reason: 'owner review (reject): no',
          review: { decision: 'reject', iteration: 'iter-x' },
        }),
      ).success,
    ).toBe(true);
    expect(
      LedgerEventSchema.safeParse(
        sealEvent({ ...base, stage: 'no-action', reason: 'r', review: { decision: 'accept' } }),
      ).success,
    ).toBe(false);
  });

  it('skill-impact keeps the stage-machine stage and shows the review', () => {
    const events = [
      sealEvent({ ts: '2026-11-12T00:00:00Z', proposalId: 'p', stage: 'no-action', reason: 'r' }),
      sealEvent({
        ts: '2026-11-13T00:00:00Z',
        proposalId: 'p',
        stage: 'review',
        reason: 'agree',
        review: { decision: 'accept' },
      }),
    ];
    const md = renderSkillImpact(events);
    expect(md).toContain('| no-action |');
    expect(md).toContain('owner review 2026-11-13: accept');
  });
});

describe('iterate helpers', () => {
  it('blast radius: the larger of the 06 §5.4 table and the accepted PURPOSE.md', () => {
    expect(blastRadius('provider-neon', undefined)).toBe('medium');
    expect(blastRadius('deploy-verify-promote', undefined)).toBe('high');
    expect(
      blastRadius('provider-neon', '---\nskill: provider-neon\nblast-radius: low\n---\n'),
    ).toBe('low');
    expect(
      blastRadius('provider-neon', '---\nskill: provider-neon\nblast-radius: high\n---\n'),
    ).toBe('high');
    // A PURPOSE.md never lowers a skill the table names.
    expect(blastRadius('deploy-verify-promote', '---\nskill: x\nblast-radius: low\n---\n')).toBe(
      'high',
    );
  });

  it('a candidate is never built from a non-canonical name', () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-names-'));
    try {
      const skills = join(root, 'skills');
      for (const n of ['provider-neon', 'deploy-verify-promote']) {
        mkdirSync(join(skills, n), { recursive: true });
        writeFileSync(join(skills, n, 'SKILL.md'), `---\nname: ${n}\n---\n# ${n}\n`);
      }
      const edits = [{ op: 'append' as const, file: 'SKILL.md', text: 'x' }];
      for (const name of ['deploy-verify-promote/', 'provider-neon/../deploy-verify-promote']) {
        const r = materializeCandidate(
          skills,
          { action: 'patch', outlet: 'skill', name, edits, patterns: ['p'] },
          join(root, 'cand'),
        );
        expect(r.ok, name).toBe(false);
        expect(
          ProposerOutputSchema.safeParse({
            action: 'patch',
            outlet: 'skill',
            name,
            edits,
            patterns: ['p'],
          }).success,
        ).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads the M2-03 control arm with its expectation', () => {
    const controls = loadControls(BENCH, 'controls');
    expect(controls.map((c) => c.file)).toEqual([join('controls', 'probe-layer-overgeneral.json')]);
    expect(controls[0]?.arm.expect).toEqual({
      decision: 'reject',
      reason: 'replay-regression',
      task: 'replay/idle-probe-leaves-store-asleep-val',
    });
    expect(controls[0]?.arm.proposal).toMatchObject({
      action: 'patch',
      name: 'deploy-verify-promote',
    });
    expect(loadControls(BENCH, 'no-such-dir')).toEqual([]);
  });
});

describe('resume hardening (second review)', () => {
  const REPO = resolve(BENCH, '..');

  it('blast radius: a PURPOSE.md edit may not move the parsed key or the frontmatter', () => {
    const fm = '---\nskill: x\nblast-radius: high\nowner: o\n---\nbody\n';
    expect(purposeRadiusChange(fm, fm.replace('body', 'new body'))).toBeNull();
    // Closing the block early moves blast-radius out of it although the line is unchanged.
    expect(purposeRadiusChange(fm, fm.replace('skill: x\n', 'skill: x\n---\n'))).toMatch(/keys/);
    expect(purposeRadiusChange(fm, fm.replace(/^---\n/, ''))).toMatch(/frontmatter block/);
    expect(purposeRadiusChange(fm, fm.replace(/\n/g, '\r\n'))).toMatch(/frontmatter block/);
    expect(purposeRadiusChange(fm, fm.replace('high', 'low'))).toMatch(/blast-radius value/);
    expect(purposeRadiusChange(fm, fm.replace('high', '"high"'))).toBeNull();

    const skills = mkdtempSync(join(tmpdir(), 'iterate-radius-'));
    try {
      cpSync(join(REPO, '.claude', 'skills', 'provider-neon'), join(skills, 'provider-neon'), {
        recursive: true,
      });
      writeFileSync(join(skills, 'provider-neon', 'PURPOSE.md'), fm.replace('x', 'provider-neon'));
      const patch = (edits: unknown[]) =>
        checkProposalContent({
          output: {
            action: 'patch',
            outlet: 'skill',
            name: 'provider-neon',
            edits,
            patterns: ['pattern/probe-touches-wrong-layer'],
          },
          wiki: loadWiki(join(REPO, 'wiki')),
          skillsDir: skills,
          templatesDir: join(REPO, 'tools'),
        });
      const moved = patch([
        { op: 'insert_after', file: 'PURPOSE.md', target: 'skill: provider-neon\n', text: '---\n' },
      ]);
      expect(moved.ok).toBe(false);
      expect(!moved.ok && moved.errors.join('\n')).toMatch(
        /PURPOSE\.md: the edit changes the frontmatter keys/,
      );
      const fine = patch([{ op: 'append', file: 'PURPOSE.md', text: '\nmore\n' }]);
      expect(fine.ok, JSON.stringify(fine)).toBe(true);
    } finally {
      rmSync(skills, { recursive: true, force: true });
    }
  });

  it('pinTree: a commit that does not resolve is an error, never pinned literally', () => {
    expect(() => pinTree(REPO, { commit: 'no-such-ref-anywhere' }, 'o/r')).toThrow(
      /is not a commit/,
    );
    expect(pinTree(REPO, { commit: 'HEAD' }, 'o/r').key).toMatch(/^commit:[0-9a-f]{40}$/);
  });

  it('pinTree: a directory is pinned by its contents, never by git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-pin-dir-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'one');
      const a = pinTree(REPO, { dir, ref: 'pr:o/r#1' }, 'o/r');
      expect(a.key).toMatch(/^dir:.*@sha256:[0-9a-f]{64}#pr:o\/r#1$/);
      expect(a.tree).toMatchObject({ dir, ref: 'pr:o/r#1' });
      writeFileSync(join(dir, 'a.txt'), 'two');
      expect(pinTree(REPO, { dir, ref: 'pr:o/r#1' }, 'o/r').key).not.toBe(a.key);
      expect(pinTree(REPO, { dir }, 'o/r').key).not.toContain('unpinned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the lock is never reentrant: a lock naming this process is live, whatever its token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-lock-self-'));
    try {
      const release = acquireLock(dir);
      expect(() => acquireLock(dir)).toThrow(/already locked by this process/);
      release();
      writeFileSync(
        join(dir, '.lock'),
        JSON.stringify({ host: hostname(), pid: process.pid, token: 'not-ours' }),
      );
      expect(() => acquireLock(dir)).toThrow(/already locked by this process/);
      expect(existsSync(join(dir, '.lock'))).toBe(true);
      // The same pid with another start time is a reused pid: stale.
      writeFileSync(
        join(dir, '.lock'),
        JSON.stringify({ host: hostname(), pid: process.pid, start: 'not-our-start', token: 'x' }),
      );
      acquireLock(dir)();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the lock is taken atomically and released compare-and-delete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iterate-lock-'));
    try {
      const release = acquireLock(dir);
      // Another live pid on this host is a running holder.
      writeFileSync(join(dir, '.lock'), JSON.stringify({ host: hostname(), pid: process.ppid }));
      expect(() => acquireLock(dir)).toThrow(/is running in process/);
      // Someone else's lock now (a holder that broke ours): our release leaves it alone.
      writeFileSync(join(dir, '.lock'), JSON.stringify({ host: 'h', pid: 1, token: 'other' }));
      release();
      expect(existsSync(join(dir, '.lock'))).toBe(true);
      expect(() => acquireLock(dir)).toThrow(/on host h.*--break-lock/);
      const mine = acquireLock(dir, () => {}, { breakLock: true });
      mine();
      expect(existsSync(join(dir, '.lock'))).toBe(false);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appendEvents repairs a torn trailing line under the lock, and keeps a whole one', () => {
    const root = mkdtempSync(join(tmpdir(), 'iterate-torn-'));
    try {
      const ev = (n: number) =>
        sealEvent({
          ts: `2026-11-1${n}T00:00:00.000Z`,
          proposalId: `prop-00000000000${n}`,
          stage: 'no-action',
          change: { kind: 'no_action' },
          reason: 'r',
        });
      appendEvents(root, [ev(1)]);
      appendFileSync(join(root, 'ledger.jsonl'), '{"eventId":"tor');
      const r = appendEvents(root, [ev(2)], { repairTornTail: true });
      expect(r.repaired).toBe('{"eventId":"tor');
      const text = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
      const ids = text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).eventId);
      expect(ids).toEqual([ev(1).eventId, ev(2).eventId]);
      // A complete last line that only lacks its newline is kept.
      writeFileSync(join(root, 'ledger.jsonl'), text.trimEnd());
      const kept = appendEvents(root, [ev(3)], { repairTornTail: true });
      expect(kept.repaired).toBeUndefined();
      const lines = readFileSync(join(root, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
