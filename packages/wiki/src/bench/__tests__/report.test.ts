import { describe, expect, it } from 'vitest';
import type { EvaluationRecord, GateInputRecord } from '../../schema/bench';
import type { LedgerEvent } from '../../schema/ledger';
import type { GateDecision } from '../gate';
import { type ReportInput, buildBenchReport, formatBenchReport } from '../report';

const H = (c: string) => c.repeat(64);

/** The report reads fields and never validates, so these are plain shaped objects, not sealed
 * records: what is under test is the derivation, with `recompute` replaced by a table. */
const ev = (e: Partial<LedgerEvent> & Pick<LedgerEvent, 'stage' | 'ts'>): LedgerEvent =>
  ({ eventId: H('e'), writer: 'harness', ...e }) as LedgerEvent;

const bench = (gateInput: string, records: string[]): LedgerEvent['evidence'] =>
  ({ kind: 'bench', gateInput, evaluationRecords: records, results: [] }) as never;

const record = (
  hash: string,
  role: EvaluationRecord['role'],
  vendor: string,
  outcomes: { durationMs: number; requests: number; tokensIn: number; usd: number }[],
): EvaluationRecord =>
  ({
    hash,
    role,
    createdAt: '2026-11-20T00:00:00.000Z',
    identity: { agent: { vendor, version: '1' } },
    outcomes: outcomes.map((o) => ({
      durationMs: o.durationMs,
      cost: { requests: o.requests, tokensIn: o.tokensIn, tokensOut: 0, usd: o.usd },
    })),
  }) as unknown as EvaluationRecord;

const accepted = ev({
  stage: 'candidate-accepted',
  ts: '2026-11-20T01:00:00.000Z',
  proposalId: 'prop-a',
  skill: 'provider-neon',
  outlet: 'skill',
  evidence: bench(H('1'), [H('b'), H('c')]),
});
const control = ev({
  stage: 'candidate-rejected',
  ts: '2026-11-20T03:00:00.000Z',
  proposalId: 'control-x-1',
  control: true,
  skill: 'provider-neon',
  evidence: bench(H('2'), [H('b'), H('d')]),
});
const staleControl = ev({
  stage: 'candidate-rejected',
  ts: '2026-11-20T04:00:00.000Z',
  proposalId: 'control-x-2',
  control: true,
  evidence: bench(H('3'), [H('b')]),
});

const events: LedgerEvent[] = [
  accepted,
  ev({
    stage: 'review',
    ts: '2026-11-20T02:00:00.000Z',
    proposalId: 'prop-a',
    review: { decision: 'accept', by: 'the owner', iteration: 'iter-1' },
  }),
  ev({
    stage: 'merged',
    ts: '2026-11-20T02:30:00.000Z',
    proposalId: 'prop-a',
    change: { kind: 'pr', ref: 'https://example.test/pull/1' },
  }),
  ev({
    stage: 'no-action',
    ts: '2026-11-20T05:00:00.000Z',
    proposalId: 'prop-n',
    change: { kind: 'no_action' },
    reason: 'nothing decidable',
  }),
  control,
  staleControl,
  ev({
    stage: 'spend',
    ts: '2026-11-20T06:00:00.000Z',
    spend: {
      evaluationId: 'eval-1',
      model: 'judge',
      requests: 12,
      rollouts: 0,
      tokensIn: 100,
      tokensOut: 5,
      usd: 0,
    },
  }),
];

const records = [
  record(H('b'), 'baseline', 'external', [
    { durationMs: 60_000, requests: 0, tokensIn: 0, usd: 0 },
    { durationMs: 30_000, requests: 0, tokensIn: 0, usd: 0 },
  ]),
  record(H('c'), 'candidate', 'greenlight-harness', [
    { durationMs: 120_000, requests: 7, tokensIn: 900, usd: 0.25 },
  ]),
  record(H('d'), 'candidate', 'external', [
    { durationMs: 90_000, requests: 0, tokensIn: 0, usd: 0 },
  ]),
  record(H('f'), 'train', 'external', [{ durationMs: 6_000, requests: 0, tokensIn: 0, usd: 0 }]),
];

const decisionFor = (
  e: LedgerEvent,
  reasons: Partial<GateDecision['reasons'][number]>[] = [],
): GateDecision =>
  ({ decision: 'reject', reasons, results: [], ledgerEvent: e }) as unknown as GateDecision;

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  events,
  records,
  gateInput: (hash) => ({ hash }) as GateInputRecord,
  recomputeFn: (g) => {
    if (g.hash === H('1')) return decisionFor(accepted);
    if (g.hash === H('2'))
      return decisionFor(control, [
        { code: 'replay-regression', severity: 'fail', task: 'replay/neon-val', model: 'a' },
        { code: 'replay-regression', severity: 'fail', task: 'replay/neon-val', model: 'b' },
      ] as never);
    return decisionFor(staleControl, [{ code: 'no-improvement', severity: 'fail' }] as never);
  },
  ...over,
});

describe('bench report', () => {
  it('lists every real proposal with its outcome, review, merge and reproducibility', () => {
    const r = buildBenchReport(input()).iterations;
    expect(r.rows.map((x) => [x.proposalId, x.outcome, x.latest, x.reproduces])).toEqual([
      ['prop-a', 'candidate-accepted', 'merged', 'yes'],
      ['prop-n', 'no-action', 'no-action', 'no-gate-input'],
    ]);
    expect(r.rows[0]?.review).toEqual({ decision: 'accept', by: 'the owner', iteration: 'iter-1' });
    expect(r.rows[0]?.merged).toBe('https://example.test/pull/1');
    expect(r).toMatchObject({
      total: 2,
      accepted: 1,
      rejected: 0,
      noAction: 1,
      merged: 1,
      reviewed: 1,
      gated: 1,
      reproduced: 1,
    });
  });

  it('keeps control arms out of the iterations and says what each rejection shows', () => {
    const r = buildBenchReport(input()).discrimination;
    expect(r.rows.map((x) => [x.proposalId, x.shows, x.regressed])).toEqual([
      ['control-x-1', 'replay-regression', ['replay/neon-val']],
      ['control-x-2', 'rejected-other', []],
    ]);
    expect(r).toMatchObject({ total: 2, rejected: 2, rejectedForReplayRegression: 1, accepted: 0 });
  });

  it('reports an accepted control as the failure it is', () => {
    const bad = { ...control, stage: 'candidate-accepted' } as LedgerEvent;
    const r = buildBenchReport(
      input({ events: [bad], recomputeFn: () => decisionFor(bad) }),
    ).discrimination;
    expect(r.rows[0]?.shows).toBe('accepted');
    expect(r.accepted).toBe(1);
  });

  it('marks a decision that does not reproduce, or whose inputs are gone', () => {
    const differs = buildBenchReport(
      input({ recomputeFn: () => decisionFor(ev({ stage: 'candidate-rejected', ts: 'x' })) }),
    );
    expect(differs.iterations.rows[0]).toMatchObject({
      reproduces: 'no',
      reproduceDetail: 'recomputes to reject',
    });
    expect(differs.iterations.reproduced).toBe(0);

    const missing = buildBenchReport(input({ gateInput: () => undefined }));
    expect(missing.iterations.rows[0]?.reproduces).toBe('no');
    expect(missing.iterations.rows[0]?.reproduceDetail).toContain('not on disk');
    // Without a decision the control's reasons are unknown; the report does not guess.
    expect(missing.discrimination.rows[0]?.shows).toBe('unknown');

    const throws = buildBenchReport(
      input({
        recomputeFn: () => {
          throw new Error('record tampered');
        },
      }),
    );
    expect(throws.iterations.rows[0]?.reproduceDetail).toBe('record tampered');
  });

  it('never reports an external agent’s usage as zero', () => {
    const c = buildBenchReport(input()).cost;
    expect(c.measured).toEqual({
      rollouts: 1,
      requests: 7,
      tokensIn: 900,
      tokensOut: 0,
      usd: 0.25,
    });
    expect(c.unmeasured).toEqual({ rollouts: 4, rolloutMinutes: 3.1 });
    const base = c.records.find((x) => x.hash === H('b'));
    expect(base).toMatchObject({ measured: false, rollouts: 2, rolloutMinutes: 1.5 });
    expect(base?.usedBy).toEqual(['control-x-1', 'control-x-2', 'prop-a']);
    expect(c.records.find((x) => x.hash === H('f'))?.usedBy).toEqual([]);
    expect(c.spend).toEqual([
      { model: 'judge', events: 1, requests: 12, rollouts: 0, tokensIn: 100, tokensOut: 5, usd: 0 },
    ]);

    const text = formatBenchReport(buildBenchReport(input()));
    expect(text).toContain('unknown, not zero');
    expect(text).toMatch(/external\/1 \| 2 \| 1\.5 \| unmeasured \| unmeasured \| unmeasured/);
  });

  it('narrows every section to one proposal', () => {
    const r = buildBenchReport(input({ proposalId: 'control-x-1' }));
    expect(r.iterations.rows).toEqual([]);
    expect(r.discrimination.rows.map((x) => x.proposalId)).toEqual(['control-x-1']);
    expect(r.cost.records.map((x) => x.hash)).toEqual([H('b'), H('d')]);
    // A spend event names an evaluation run, not a proposal, so it is left out, not misattributed.
    expect(r.cost.spend).toEqual([]);
  });

  it('prints only the sections asked for', () => {
    const text = formatBenchReport(buildBenchReport(input()), ['discrimination']);
    expect(text).toContain('## Discrimination');
    expect(text).not.toContain('## Iterations');
    expect(text).not.toContain('## Cost');
  });
});
