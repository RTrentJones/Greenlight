import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FileLockTimeoutError,
  LedgerWriteError,
  acceptedSkillSetState,
  appendEvent,
  appendEvents,
  compareTs,
  holderIsDead,
  ledgerProblems,
  orderLedgerEvents,
  proposalHistory,
  renderSkillImpact,
  withFileLock,
} from '../ledger';
import { lint } from '../lint';
import { loadWiki } from '../load';
import { type LedgerEvent, sealEvent, sealGateInput } from '../schema';
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
    // A complete last line that only lacks its newline is kept, and gets its newline.
    const earlier = JSON.stringify(sealEvent({ ...event, proposalId: 'p-000' }));
    const root = writeTree({ 'ledger.jsonl': `not json, but a whole line\n${earlier}` });
    const sealed = sealEvent({ ...event });
    expect(appendEvent(root, sealed)).toEqual(sealed);
    const text = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    expect(text.startsWith(`not json, but a whole line\n${earlier}\n{`)).toBe(true);
    expect(loadWiki(root).ledger.map((e) => e.proposalId)).toEqual(['p-000', 'p-010']);
  });

  it('cuts a torn tail under the lock before appending, as appendEvents does', () => {
    // A crash mid-append leaves a last line without its newline that does not parse.
    const whole = JSON.stringify(sealEvent({ ...event, proposalId: 'p-000' }));
    const root = writeTree({ 'ledger.jsonl': `${whole}\n{"ts":"2026-10-06T09:00:00.000Z","wri` });
    appendEvent(root, event);
    const text = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(text).not.toContain('"wri\n');
    const wiki = loadWiki(root);
    expect(wiki.ledgerErrors).toEqual([]);
    expect(wiki.ledger.map((e) => e.proposalId)).toEqual(['p-000', 'p-010']);
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
  // Repro evidence: an accepted event always carries the evidence it was accepted on.
  const repro = {
    evidence: {
      kind: 'repro',
      base: 'commit:owner/repo@abcdef1',
      candidate: 'commit:owner/repo@abcdef2',
      reproTask: 'mechanism/x',
    },
  };
  const accepted = (ts = '2026-10-06T09:00:00.000Z') =>
    at('candidate-accepted', ts, { path: 'standard', outlet: 'skill', ...repro });

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
      at('candidate-accepted', '2026-10-06T09:00:00.000Z', {
        path: 'standard',
        outlet: 'verify',
        ...repro,
      }),
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

  it('refuses merged or released once ANY event of the proposal carries control', () => {
    // The flag on the accepted event only: the later events do not repeat it.
    const root = writeTree({});
    appendEvent(root, { ...(accepted() as LedgerEvent), control: true });
    const before = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    expect(() => appendEvent(root, at('merged', '2026-10-07T09:00:00.000Z'))).toThrow(
      /a control-arm proposal is never merged or released/,
    );
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8')).toBe(before);
    // In a committed ledger (LR-14): both the merge and the release are reported.
    const events = [
      sealEvent({ ...(accepted() as LedgerEvent), control: true }),
      sealEvent(at('merged', '2026-10-07T09:00:00.000Z')),
      sealEvent(at('released', '2026-10-08T09:00:00.000Z', { release: '2.0.1' })),
    ];
    expect(ledgerProblems(events)).toEqual([
      'proposal p-020: stage "merged": a control-arm proposal is never merged or released',
      'proposal p-020: stage "released": a control-arm proposal is never merged or released',
    ]);
    // The flag arriving late (on a review) taints the history just the same.
    const late = [
      sealEvent(accepted() as LedgerEvent),
      sealEvent(at('merged', '2026-10-07T09:00:00.000Z')),
      sealEvent(
        at('review', '2026-10-08T09:00:00.000Z', {
          control: true,
          reason: 'r',
          review: { decision: 'accept' },
        }),
      ),
    ];
    expect(ledgerProblems(late)).toHaveLength(1);
  });

  it('refuses a repeat of a violation the history already holds', () => {
    // A committed ledger that already holds `merged` after `merged` once.
    const twice = [
      sealEvent(accepted() as LedgerEvent),
      sealEvent(at('merged', '2026-10-07T09:00:00.000Z')),
      sealEvent(at('merged', '2026-10-07T10:00:00.000Z')),
    ];
    const problem = 'stage "merged" cannot follow "merged"';
    expect(ledgerProblems(twice)).toEqual([`proposal p-020: ${problem}`]);
    const root = writeTree({
      'ledger.jsonl': twice.map((e) => `${JSON.stringify(e)}\n`).join(''),
    });
    const before = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    // A third `merged` adds the SAME problem text again. De-duplicating the problems by string
    // let it through; counted as a multiset it is refused.
    expect(() => appendEvent(root, at('merged', '2026-10-07T11:00:00.000Z'))).toThrow(
      /refused for proposal p-020: stage "merged" cannot follow "merged"/,
    );
    expect(() => appendEvents(root, [at('merged', '2026-10-07T11:00:00.000Z')])).toThrow(
      /cannot follow "merged"/,
    );
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8')).toBe(before);
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
    // A lock held by a live process of this host (the parent) is live, whatever its age rule.
    writeFileSync(lock, `${process.ppid}.${'ab'.repeat(12)}@${hostname()}`);
    expect(() => withFileLock(lock, () => 1, { timeoutMs: 50 })).toThrow(FileLockTimeoutError);
  });

  it('takes over at once from a holder that was killed (no wait for staleMs)', () => {
    // A process that exited: its pid is dead on this host.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const pid = Number(dead.stdout.toString());
    const token = `${pid}.${'0f'.repeat(12)}@${hostname()}`;
    expect(holderIsDead(token)).toBe(true);
    expect(holderIsDead(`${pid}.${'0f'.repeat(12)}@another-host`)).toBe(false);
    expect(holderIsDead(`${process.pid}.${'0f'.repeat(12)}@${hostname()}`)).toBe(false);
    expect(holderIsDead('crashed-holder')).toBe(false);
    const root = writeTree({});
    const lock = join(root, 'k.lock');
    writeFileSync(lock, token); // fresh mtime: far younger than staleMs
    const started = Date.now();
    // timeoutMs (1 s) is far below staleMs (30 s): before, this failed for 30 s.
    expect(withFileLock(lock, () => 'ran', { timeoutMs: 1_000, staleMs: 30_000 })).toBe('ran');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(lock)).toBe(false);
    // The same for the ledger: an append right after a SIGKILL of the previous appender.
    writeFileSync(join(root, 'ledger.jsonl.lock'), token);
    expect(appendEvent(root, event).proposalId).toBe('p-010');
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

describe('the accepted skill set follows merge order (06 §6.1)', () => {
  const H = (c: string) => c.repeat(64);
  const S0 = H('0');
  const S1 = H('1');
  const S2 = H('2');
  const result = {
    model: 'm',
    mode: 'isolation' as const,
    split: 'val' as const,
    runs: 3,
    replay: { total: 1, baselinePassing: 1, candidatePassing: 1, regressions: [] },
    capability: { before: 0, after: 1, delta: 1, pValue: 0.0025 },
    decision: 'pass' as const,
  };
  /** A sealed gate input for a proposal gated on `from`, proposing `to`. Only its two skill-set
   * hashes matter here, so it is written in the oldest (algorithm-1) shape every build reads. */
  const gateInput = (proposalId: string, from: string, to: string) =>
    sealGateInput({
      kind: 'gate-input',
      proposalId,
      ts: '2026-10-01T00:00:00.000Z',
      outlet: 'skill',
      radius: 'medium',
      path: 'standard',
      seed: `gate:${proposalId}`,
      config: {
        alpha: 0.05,
        runs: 3,
        resamples: 1000,
        acceptShorterOnTie: false,
        maxBaselineAgeDays: 30,
      },
      models: { frontier: 'f', small: 's' },
      modes: ['isolation'],
      modesDeclared: true,
      acceptedSkillSetHash: from,
      candidateSkillSetHash: to,
      tasks: [{ id: 'cap/a', kind: 'capability', state: 'active', modes: ['isolation'] }],
      baselineRecords: [H('a')],
      candidateRecords: [H('b')],
    });
  const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const gated = (
    id: string,
    n: number,
    gi: ReturnType<typeof gateInput>,
    stage: 'candidate-accepted' | 'candidate-rejected' = 'candidate-accepted',
    control = false,
  ) =>
    sealEvent({
      ts: day(n),
      proposalId: id,
      stage,
      path: 'standard',
      outlet: 'skill',
      ...(control ? { control: true } : {}),
      evidence: {
        kind: 'bench',
        gateInput: gi.hash,
        evaluationRecords: [H('a')],
        results: [result],
      },
    });
  const merged = (id: string, n: number) =>
    sealEvent({ ts: day(n), proposalId: id, stage: 'merged' });
  const withdrawn = (id: string, n: number, skillSetHash?: string) =>
    sealEvent({
      ts: day(n),
      proposalId: id,
      stage: 'withdrawn',
      reason: 'reverted',
      ...(skillSetHash ? { skillSetHash } : {}),
    });
  const giA = gateInput('A', S0, S1);
  const giB = gateInput('B', S0, S2);
  const giC = gateInput('C', S1, S2);
  const all = [giA, giB, giC];
  const lookup = (h: string) => all.find((g) => g.hash === h);
  const state = (events: LedgerEvent[]) => acceptedSkillSetState(events, lookup);
  /** A wiki root holding the gate inputs, so appendEvent can read them. */
  const rootWith = () => {
    const root = writeTree({});
    mkdirSync(join(root, 'evidence', 'eval'), { recursive: true });
    for (const g of all) {
      writeFileSync(join(root, 'evidence', 'eval', `${g.hash}.json`), JSON.stringify(g));
    }
    return root;
  };

  it('before any merge: the baseline of the newest gated proposal; after one: its candidate', () => {
    expect(state([])).toEqual({ hash: undefined, problems: [] });
    expect(state([gated('A', 1, giA)]).hash).toBe(S0);
    expect(state([gated('A', 1, giA), merged('A', 2)]).hash).toBe(S1);
  });

  it('(a) A merged S0→S1, C gated on S1, A withdrawn: the set the withdrawal names, never S1', () => {
    const events = [gated('A', 1, giA), merged('A', 2), gated('C', 3, giC), withdrawn('A', 4, S0)];
    expect(state(events)).toEqual({ hash: S0, problems: [] });
    // A revert that lands somewhere else is whatever it names.
    expect(state([...events.slice(0, 3), withdrawn('A', 4, H('9'))]).hash).toBe(H('9'));
    // A withdrawal that names nothing leaves the state unknown, and is a history problem.
    const unnamed = [...events.slice(0, 3), withdrawn('A', 4)];
    expect(state(unnamed).hash).toBeUndefined();
    expect(ledgerProblems(unnamed)).toEqual([
      'proposal A: a withdrawn event of a merged proposal names the resulting accepted skill set (skillSetHash)',
    ]);
  });

  it('(b) A merged, then B (baseline S0) rejected later: still S1', () => {
    const events = [gated('A', 1, giA), merged('A', 2), gated('B', 3, giB, 'candidate-rejected')];
    expect(state(events)).toEqual({ hash: S1, problems: [] });
  });

  it('(c) A and B both accepted on S0: the second merge is refused until B is gated again', () => {
    const events = [gated('A', 1, giA), gated('B', 2, giB), merged('A', 3), merged('B', 4)];
    const s = state(events);
    expect(s.hash).toBe(S1); // never S2: S0 + A + B is a tree no evaluation ran
    expect(s.problems).toEqual([
      `proposal B: merged, but it was gated against skill set ${S0.slice(0, 12)} and the accepted set is now ${S1.slice(0, 12)}; gate it again on the accepted set first`,
    ]);
    expect(ledgerProblems(events, lookup)).toEqual(s.problems);

    const root = rootWith();
    for (const e of events.slice(0, 3)) appendEvent(root, e);
    const before = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    expect(() => appendEvent(root, merged('B', 4))).toThrow(/gate it again on the accepted set/);
    expect(() => appendEvents(root, [merged('B', 4)])).toThrow(/gate it again/);
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8')).toBe(before);
    // C was gated on S1, the accepted set: it merges.
    appendEvent(root, gated('C', 5, giC));
    appendEvent(root, merged('C', 6));
    expect(acceptedSkillSetState(loadWiki(root).ledger, lookup)).toEqual({
      hash: S2,
      problems: [],
    });
  });

  it('a merge whose gate input cannot be read is refused; a withdrawal must name its result', () => {
    const root = writeTree({});
    appendEvent(root, gated('A', 1, giA));
    expect(() => appendEvent(root, merged('A', 2))).toThrow(/gate input .* is not readable/);
    const ok = rootWith();
    appendEvent(ok, gated('A', 1, giA));
    appendEvent(ok, merged('A', 2));
    expect(() => appendEvent(ok, withdrawn('A', 3))).toThrow(
      /names the resulting accepted skill set/,
    );
    appendEvent(ok, withdrawn('A', 3, S0));
    // Only a withdrawal that moves the skill set carries the field.
    appendEvent(ok, gated('B', 4, giB));
    expect(() => appendEvent(ok, withdrawn('B', 5, S0))).toThrow(/never moved the skill set/);
  });

  it('a control-arm proposal never moves the accepted set', () => {
    const control = gated('C', 3, giC, 'candidate-accepted', true);
    expect(state([gated('A', 1, giA), merged('A', 2), control]).hash).toBe(S1);
    expect(state([control]).hash).toBeUndefined();
  });
});
