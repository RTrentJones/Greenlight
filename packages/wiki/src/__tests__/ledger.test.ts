import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LedgerWriteError, appendEvent, proposalHistory, renderSkillImpact } from '../ledger';
import { loadWiki } from '../load';
import { type LedgerEvent, sealEvent } from '../schema';
import { ledgerEvents, writeTree } from './fixtures';

// Vision 08 §8: harness-only, append-only ledger; skill-impact.md rendered from it.

const event = {
  ts: '2026-10-06T09:00:00.000Z',
  writer: 'harness' as const,
  proposalId: 'p-010',
  stage: 'no-action' as const,
  reason: 'nothing to change',
};

describe('appendEvent', () => {
  it('seals an unsealed event, appends it as one line, and loads back', () => {
    const root = writeTree({});
    const first = appendEvent(root, event);
    appendEvent(root, { ...event, proposalId: 'p-011' });
    expect(first.eventId).toBe(sealEvent({ ...event }).eventId);
    const lines = readFileSync(join(root, 'ledger.jsonl'), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const wiki = loadWiki(root);
    expect(wiki.ledgerErrors).toEqual([]);
    expect(wiki.ledger.map((e) => e.proposalId)).toEqual(['p-010', 'p-011']);
  });

  it('accepts an already sealed event and keeps earlier lines untouched', () => {
    const root = writeTree({ 'ledger.jsonl': 'earlier line without newline' });
    const sealed = sealEvent({ ...event });
    expect(appendEvent(root, sealed)).toEqual(sealed);
    const text = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    expect(text.startsWith('earlier line without newline\n{')).toBe(true);
  });

  it.each([
    ['a non-harness writer', { ...event, writer: 'human' }, /only the harness writes the ledger/],
    ['a missing writer', { ...event, writer: undefined }, /only the harness/],
    [
      'a schema-invalid event',
      { ...event, reason: undefined },
      /reason: a no-action event needs a reason/,
    ],
    ['an unknown field', { ...event, note: 'x' }, /Unrecognized key/],
    ['a forged eventId', { ...event, eventId: 'f'.repeat(64) }, /eventId must be the sha256/],
  ])('refuses %s and writes nothing', (_n, bad, msg) => {
    const root = writeTree({});
    expect(() => appendEvent(root, bad as unknown as LedgerEvent)).toThrow(LedgerWriteError);
    expect(() => appendEvent(root, bad as unknown as LedgerEvent)).toThrow(msg);
    expect(existsSync(join(root, 'ledger.jsonl'))).toBe(false);
  });

  it('records invalid lines on load instead of throwing', () => {
    const root = writeTree({});
    appendEvent(root, event);
    const file = join(root, 'ledger.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n\n{"writer":"bot"}\n`);
    const wiki = loadWiki(root);
    expect(wiki.ledger).toHaveLength(1);
    expect(wiki.ledgerErrors).toEqual([
      { line: 2, message: 'not valid JSON' },
      { line: 4, message: 'writer must be "harness": only the harness writes the ledger' },
    ]);
  });
});

describe('proposalHistory', () => {
  it("returns one proposal's events, its latest stage and stage-machine problems", () => {
    const events = ledgerEvents();
    expect(proposalHistory(events, 'p-001')).toMatchObject({ latest: 'merged', problems: [] });
    expect(proposalHistory(events, 'p-001').events.map((e) => e.stage)).toEqual([
      'candidate-accepted',
      'merged',
    ]);
    expect(proposalHistory(events, 'p-404')).toEqual({
      proposalId: 'p-404',
      events: [],
      latest: undefined,
      problems: [],
    });
  });

  it('reports an out-of-order history', () => {
    const merged = sealEvent({
      ts: '2026-10-01T00:00:00.000Z',
      proposalId: 'p-x',
      stage: 'merged',
    });
    expect(proposalHistory([merged], 'p-x').problems).toEqual([
      'stage "merged" cannot follow "start"',
    ]);
  });
});

describe('renderSkillImpact', () => {
  it('renders one row per proposal newest first, controls apart, per model × mode evidence', () => {
    expect(renderSkillImpact(ledgerEvents())).toMatchInlineSnapshot(`
      "# Skill impact

      <!-- rendered from ledger.jsonl by \`greenlight wiki render\`; do not edit by hand -->

      ## Proposals

      | date | proposal | skill / outlet | patterns | path | latest stage | evidence |
      |---|---|---|---|---|---|---|
      | 2026-10-04 | p-003 | — | — | — | no-action | — |
      | 2026-10-02 | p-001 | deploy-verify-promote (skill) | pattern/probe-cached | standard | merged | candidate-accepted: model-a isolation/val: capability 0.50→0.75 (+0.25, p=0.04), replay 4/4 → pass<br>candidate-accepted: model-b production/val: capability 0.50→0.40 (-0.10), replay 3/4, 1 regressed → fail |

      ## Controls

      | date | proposal | skill / outlet | patterns | path | latest stage | evidence |
      |---|---|---|---|---|---|---|
      | 2026-10-03 | p-002 | deploy-verify-promote (skill) | — | standard | candidate-rejected | — |
      "
    `);
  });

  it('marks a change accepted without bench or template evidence as unmeasured', () => {
    const accepted = sealEvent({
      ts: '2026-10-01T00:00:00.000Z',
      proposalId: 'p-m',
      stage: 'candidate-accepted',
      path: 'neutral',
      reason: 'owner-reviewed',
      skill: 'provider-neon',
      evidence: {
        kind: 'repro',
        base: 'commit:owner/repo@abcdef1',
        candidate: 'commit:owner/repo@abcdef2',
        reproTask: 'replay/x',
      },
    });
    expect(renderSkillImpact([accepted])).toContain(
      '| 2026-10-01 | p-m | provider-neon | — | neutral | candidate-accepted | candidate-accepted: repro replay/x, fails on commit:owner/repo@abcdef1, passes on commit:owner/repo@abcdef2<br>**unmeasured** |',
    );
  });

  it('renders an empty ledger with placeholders and escapes pipes', () => {
    expect(renderSkillImpact([])).toContain('_No proposals yet._');
    const piped = sealEvent({
      ts: '2026-10-01T00:00:00.000Z',
      proposalId: 'a|b',
      stage: 'no-action',
      reason: 'x',
    });
    expect(renderSkillImpact([piped])).toContain('| a\\|b |');
  });

  it('is deterministic regardless of event order for different proposals', () => {
    const events = ledgerEvents();
    const [a, b, c, d, e] = events as [
      LedgerEvent,
      LedgerEvent,
      LedgerEvent,
      LedgerEvent,
      LedgerEvent,
    ];
    expect(renderSkillImpact([d, c, a, b, e])).toBe(renderSkillImpact(events));
  });
});
