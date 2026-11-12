import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSkillImpact } from '../../ledger';
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
import { blastRadius, loadControls, materializeCandidate } from '../iterate';

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
