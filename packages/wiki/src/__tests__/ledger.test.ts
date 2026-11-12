import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FileLockTimeoutError,
  LedgerWriteError,
  appendEvent,
  appendEvents,
  compareTs,
  ledgerProblems,
  orderLedgerEvents,
  proposalHistory,
  renderSkillImpact,
  withFileLock,
} from '../ledger';
import { lint } from '../lint';
import { loadWiki } from '../load';
import { type LedgerEvent, sealEvent } from '../schema';
import { goodContext, goodFiles, ledgerEvents, ledgerText, writeTree } from './fixtures';
import { race } from './race';

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

  const at = (stage: LedgerEvent['stage'], ts: string, extra: Record<string, unknown> = {}) =>
    ({ ts, writer: 'harness' as const, proposalId: 'p-020', stage, ...extra }) as never;
  const accepted = (ts = '2026-10-06T09:00:00.000Z') =>
    at('candidate-accepted', ts, { path: 'standard', outlet: 'skill' });

  it('refuses a stage the history does not allow, and writes nothing', () => {
    const root = writeTree({});
    appendEvent(root, at('candidate-rejected', '2026-10-06T09:00:00.000Z', { path: 'standard' }));
    const before = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    expect(() => appendEvent(root, at('merged', '2026-10-07T09:00:00.000Z'))).toThrow(
      /refused for proposal p-020: stage "merged" cannot follow "candidate-rejected"/,
    );
    expect(() => appendEvent(writeTree({}), at('merged', '2026-10-07T09:00:00.000Z'))).toThrow(
      /cannot follow "start"/,
    );
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8')).toBe(before);
  });

  it('refuses verified-in-production straight after merged for a skill, allows it for verify', () => {
    const field = {
      evidence: {
        kind: 'field',
        check: 'keepalive-db',
        before: 'raw:20261007T090000Z-aaaaaaaa',
        after: 'raw:20261008T090000Z-bbbbbbbb',
      },
    };
    const skill = writeTree({});
    appendEvent(skill, accepted());
    appendEvent(skill, at('merged', '2026-10-07T09:00:00.000Z'));
    expect(() =>
      appendEvent(skill, at('verified-in-production', '2026-10-08T09:00:00.000Z', field)),
    ).toThrow(/cannot follow "merged"/);
    appendEvent(skill, at('released', '2026-10-08T09:00:00.000Z', { release: '2.0.1' }));
    appendEvent(skill, at('verified-in-production', '2026-10-09T09:00:00.000Z', field));

    const verify = writeTree({});
    appendEvent(
      verify,
      at('candidate-accepted', '2026-10-06T09:00:00.000Z', { path: 'standard', outlet: 'verify' }),
    );
    appendEvent(verify, at('merged', '2026-10-07T09:00:00.000Z'));
    appendEvent(verify, at('verified-in-production', '2026-10-08T09:00:00.000Z', field));
    expect(loadWiki(verify).ledger.map((e) => e.stage)).toEqual([
      'candidate-accepted',
      'merged',
      'verified-in-production',
    ]);
  });

  it('refuses a duplicate eventId, and an event earlier than its proposal latest', () => {
    const root = writeTree({});
    const first = appendEvent(root, accepted());
    expect(() => appendEvent(root, first)).toThrow(/already in the ledger/);
    // spend events have no proposal, but are still unique
    const spend = {
      ts: '2026-10-06T09:00:00.000Z',
      writer: 'harness' as const,
      stage: 'spend' as const,
      spend: { usd: 0, rollouts: 1, requests: 1, tokensIn: 1, tokensOut: 1 },
    };
    appendEvent(root, spend);
    expect(() => appendEvent(root, spend)).toThrow(/already in the ledger/);
    expect(() => appendEvent(root, at('merged', '2026-10-05T09:00:00.000Z'))).toThrow(
      /earlier than the proposal's latest event/,
    );
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

describe('timestamps compare as instants, not strings', () => {
  it('orders fractional seconds and equal instants correctly', () => {
    expect('2026-10-01T00:00:00Z' > '2026-10-01T00:00:00.1Z').toBe(true); // the string trap
    expect(compareTs('2026-10-01T00:00:00Z', '2026-10-01T00:00:00.1Z')).toBe(-1);
    expect(compareTs('2026-10-01T00:00:00.100Z', '2026-10-01T00:00:00.1Z')).toBe(0);
    expect(compareTs('2026-10-01T00:00:00Z', '2026-10-01T00:00:00.000Z')).toBe(0);
    expect(compareTs('2026-10-01T00:00:00.0000001Z', '2026-10-01T00:00:00Z')).toBe(1);
    expect(compareTs('2026-10-02T00:00:00Z', '2026-10-01T23:59:59.999Z')).toBe(1);
  });

  it('orders a history by instant, keeping append order on ties', () => {
    const e = (ts: string, stage: LedgerEvent['stage'], extra: Record<string, unknown> = {}) =>
      sealEvent({ ts, proposalId: 'p-t', stage, ...extra } as never);
    const acc = e('2026-10-01T00:00:00Z', 'candidate-accepted', { path: 'standard' });
    const merged = e('2026-10-01T00:00:00.1Z', 'merged');
    expect(proposalHistory([merged, acc], 'p-t')).toMatchObject({ latest: 'merged', problems: [] });
    const tieA = e('2026-10-01T00:00:00Z', 'no-action', { reason: 'a' });
    const tieB = e('2026-10-01T00:00:00.000Z', 'no-action', { reason: 'b' });
    expect(orderLedgerEvents([tieB, tieA])).toEqual([tieB, tieA]);
  });
});

describe('ledgerProblems / LR-14 (06 §6.1)', () => {
  it('reports duplicate eventIds and stage-machine violations, and lint surfaces them', () => {
    const events = ledgerEvents();
    expect(ledgerProblems(events)).toEqual([]);
    const bad = [
      ...events,
      events[0] as LedgerEvent,
      sealEvent({ ts: '2026-10-06T00:00:00.000Z', proposalId: 'p-003', stage: 'merged' }),
    ];
    expect(ledgerProblems(bad)).toEqual([
      `duplicate eventId ${(events[0] as LedgerEvent).eventId}`,
      'proposal p-001: stage "candidate-accepted" cannot follow "candidate-accepted"',
      'proposal p-003: stage "merged" cannot follow "no-action"',
    ]);
    const files = {
      ...goodFiles(),
      'ledger.jsonl': ledgerText(bad),
      'skill-impact.md': renderSkillImpact(bad),
    };
    const findings = lint(loadWiki(writeTree(files)), goodContext());
    expect(findings.map((f) => `${f.rule} ${f.message}`)).toEqual(
      ledgerProblems(bad).map((m) => `LR-14 ${m}`),
    );
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

describe('appendEvent across processes', () => {
  it('never writes a duplicate eventId or loses an append when processes race', async () => {
    const root = writeTree({ 'ledger.jsonl': '' });
    const shared = sealEvent({ ...event, proposalId: 'p-shared' });
    const results = await race(
      8,
      pathToFileURL(resolve(__dirname, '../ledger.ts')).href,
      `
        let won = 0;
        for (let i = 0; i < 8; i++) {
          try { m.appendEvent(arg.root, arg.shared); won++; }
          catch (e) { if (!/already in the ledger/.test(e.message)) throw e; }
          m.appendEvent(arg.root, { ...arg.event, proposalId: 'p-' + idx + '-' + i });
        }
        return won;
      `,
      { root, shared, event },
    );
    for (const r of results) expect(r.stderr).toBe('');
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.reduce((n, r) => n + Number(r.stdout), 0)).toBe(1);
    const wiki = loadWiki(root);
    expect(wiki.ledgerErrors).toEqual([]);
    expect(ledgerProblems(wiki.ledger)).toEqual([]);
    expect(wiki.ledger).toHaveLength(1 + 8 * 8);
    expect(wiki.ledger.filter((e) => e.eventId === shared.eventId)).toHaveLength(1);
    expect(existsSync(join(root, 'ledger.jsonl.lock'))).toBe(false);
  }, 60_000);
});

describe('withFileLock', () => {
  it('a holder whose stale lock was taken over never deletes the new holder’s lock', () => {
    const root = writeTree({});
    const lock = join(root, 'x.lock');
    withFileLock(lock, () => {
      // Simulate a waiter that found this lock stale, stole it and now holds it.
      writeFileSync(lock, 'someone-else');
    });
    expect(readFileSync(lock, 'utf8')).toBe('someone-else');
  });

  it('steals a stale lock and releases its own', () => {
    const root = writeTree({});
    const lock = join(root, 'y.lock');
    writeFileSync(lock, 'crashed-holder');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => readFileSync(lock, 'utf8'), { staleMs: 1_000 })).not.toBe(
      'crashed-holder',
    );
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.guard`)).toBe(false);
  });

  it('times out on a live lock', () => {
    const root = writeTree({});
    const lock = join(root, 'z.lock');
    writeFileSync(lock, 'live');
    expect(() => withFileLock(lock, () => 1, { timeoutMs: 50 })).toThrow(FileLockTimeoutError);
  });
});

describe('appendEvents', () => {
  it('appends all or nothing, and skips events already in the ledger (a retry)', () => {
    const root = writeTree({});
    const a = sealEvent({ ...event, proposalId: 'p-020' });
    const b = sealEvent({ ...event, proposalId: 'p-021' });
    expect(appendEvents(root, [a, b]).appended.map((e) => e.eventId)).toEqual([
      a.eventId,
      b.eventId,
    ]);
    // A retry of the same batch appends nothing twice.
    const again = appendEvents(root, [a, b]);
    expect(again.appended).toEqual([]);
    expect(again.present.map((e) => e.eventId)).toEqual([a.eventId, b.eventId]);
    const text = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    // A batch whose second event breaks the stage machine writes nothing, not even the first.
    const c = sealEvent({ ...event, proposalId: 'p-022' });
    const bad = sealEvent({
      ...event,
      ts: '2026-10-07T09:00:00.000Z',
      proposalId: 'p-020',
      stage: 'merged',
    });
    expect(() => appendEvents(root, [c, bad])).toThrow(LedgerWriteError);
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8')).toBe(text);
  });
});
