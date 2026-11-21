/**
 * `greenlight bench report` (07, 13 §5): the three M2 metrics, read from committed evidence only.
 *
 * - **iterations**: one row per real proposal in the ledger (its outcome, review, merge, and
 *   whether its gate decision reproduces from the stored gate input and evaluation records);
 * - **discrimination**: one row per control-arm proposal, and what its rejection shows;
 * - **cost**: what every sealed evaluation record spent, and the harness's own `spend` events.
 *
 * Nothing here reads `.greenlight/` (iteration state is local and gitignored), calls a model or
 * writes a file, so the report is the same on any checkout of the same commit.
 *
 * Two limits are stated in the report itself and not papered over. A control that ended
 * `underpowered` or `blocked` has no ledger row (06 §5.4), so it cannot appear under
 * discrimination. And an external rollout agent reports no usage to the harness (06 §4.9), so
 * its requests, tokens and dollars are **unmeasured**, never zero: for those records the report
 * gives the rollout count and the rollout wall-clock time, which is what was observed.
 */
import { orderLedgerEvents } from '../ledger';
import type { EvaluationRecord, GateInputRecord } from '../schema/bench';
import { ANNOTATION_STAGES, type LedgerEvent } from '../schema/ledger';
import { type GateDecision, recompute, sameDecision } from './gate';

export const REPORT_METRICS = ['iterations', 'discrimination', 'cost'] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

/** Whether a recorded decision re-derives from its stored inputs (`bench gate --recompute`). */
export type Reproduces =
  /** The recomputed decision matches the ledger event. */
  | 'yes'
  /** It recomputes to something else, or a stored input is missing or does not verify. */
  | 'no'
  /** The event has no gate input: a `no_action`, or an outlet evaluated without the bench. */
  | 'no-gate-input';

export interface IterationRow {
  proposalId: string;
  /** The stage of the proposal's first event: the outcome its evaluation recorded. */
  outcome: string;
  /** The latest non-annotation stage, which differs from `outcome` once it is merged or withdrawn. */
  latest: string;
  ts: string;
  skill?: string;
  outlet?: string;
  gateInput?: string;
  reproduces: Reproduces;
  /** Why `reproduces` is `no`. */
  reproduceDetail?: string;
  review?: { decision: 'accept' | 'reject'; by?: string; iteration?: string };
  merged?: string;
}

/** What a control arm's recorded rejection shows about the gate (06 §10.3). */
export type ControlShows =
  /** Rejected, with `replay-regression`: the gate refused a wrong lesson for the harm it does. */
  | 'replay-regression'
  /** Rejected for other reasons only, which an overgeneral patch can earn whatever it breaks. */
  | 'rejected-other'
  /** Accepted: the failure a control exists to find. */
  | 'accepted'
  /** The stored decision could not be recomputed, so its reasons are not available. */
  | 'unknown';

export interface ControlRow {
  proposalId: string;
  ts: string;
  skill?: string;
  stage: string;
  shows: ControlShows;
  /** Replay tasks the control was rejected for. */
  regressed: string[];
  gateInput?: string;
  reproduces: Reproduces;
}

export interface RecordCost {
  hash: string;
  role: EvaluationRecord['role'];
  createdAt: string;
  agent: string;
  /** False for an external rollout agent, whose usage the harness never sees. */
  measured: boolean;
  rollouts: number;
  /** Summed rollout wall-clock time. Rollouts overlap, so this is agent time, not elapsed time. */
  rolloutMinutes: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** Proposals whose ledger event cites this record. Empty for a train run, or for a baseline or
   * candidate whose gate wrote no row. */
  usedBy: string[];
}

export interface SpendTotal {
  model: string;
  events: number;
  requests: number;
  rollouts: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export interface BenchReport {
  iterations: {
    rows: IterationRow[];
    total: number;
    accepted: number;
    rejected: number;
    noAction: number;
    merged: number;
    reviewed: number;
    /** Rows with a gate input, and how many of those reproduce. */
    gated: number;
    reproduced: number;
  };
  discrimination: {
    rows: ControlRow[];
    total: number;
    rejected: number;
    rejectedForReplayRegression: number;
    accepted: number;
  };
  cost: {
    records: RecordCost[];
    /** Totals over the measured records only. */
    measured: {
      rollouts: number;
      requests: number;
      tokensIn: number;
      tokensOut: number;
      usd: number;
    };
    /** Totals over the records whose agent reported no usage. */
    unmeasured: { rollouts: number; rolloutMinutes: number };
    spend: SpendTotal[];
  };
}

export interface ReportInput {
  events: readonly LedgerEvent[];
  records: readonly EvaluationRecord[];
  /** The stored gate input for a hash, or undefined when it is not on disk. */
  gateInput: (hash: string) => GateInputRecord | undefined;
  /** Narrows every section to one proposal. */
  proposalId?: string;
  /** For tests: replaces `recompute`. */
  recomputeFn?: typeof recompute;
}

const gateInputOf = (e: LedgerEvent): string | undefined =>
  e.evidence?.kind === 'bench' || e.evidence?.kind === 'template'
    ? e.evidence.gateInput
    : undefined;

function rederive(
  e: LedgerEvent,
  i: ReportInput,
): { reproduces: Reproduces; detail?: string; decision?: GateDecision } {
  const hash = gateInputOf(e);
  if (!hash) return { reproduces: 'no-gate-input' };
  const g = i.gateInput(hash);
  if (!g) return { reproduces: 'no', detail: `gate input ${hash} is not on disk` };
  try {
    const decision = (i.recomputeFn ?? recompute)(g, i.records);
    return sameDecision(e, decision)
      ? { reproduces: 'yes', decision }
      : { reproduces: 'no', detail: `recomputes to ${decision.decision}`, decision };
  } catch (err) {
    return { reproduces: 'no', detail: (err as Error).message };
  }
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

export function buildBenchReport(i: ReportInput): BenchReport {
  const ordered = orderLedgerEvents(i.events);
  const byProposal = new Map<string, LedgerEvent[]>();
  for (const e of ordered) {
    if (!e.proposalId) continue;
    if (i.proposalId && e.proposalId !== i.proposalId) continue;
    const own = byProposal.get(e.proposalId) ?? [];
    own.push(e);
    byProposal.set(e.proposalId, own);
  }

  const iterations: IterationRow[] = [];
  const controls: ControlRow[] = [];
  for (const [proposalId, own] of byProposal) {
    const first = own.find((e) => !ANNOTATION_STAGES.has(e.stage));
    if (!first) continue;
    const r = rederive(first, i);
    if (own.some((e) => e.control === true)) {
      const regressed = [
        ...new Set(
          (r.decision?.reasons ?? [])
            .filter((x) => x.code === 'replay-regression' && x.severity === 'fail' && x.task)
            .map((x) => x.task as string),
        ),
      ].sort();
      const shows: ControlShows =
        first.stage === 'candidate-accepted'
          ? 'accepted'
          : !r.decision
            ? 'unknown'
            : regressed.length > 0
              ? 'replay-regression'
              : 'rejected-other';
      controls.push({
        proposalId,
        ts: first.ts,
        skill: first.skill,
        stage: first.stage,
        shows,
        regressed,
        gateInput: gateInputOf(first),
        reproduces: r.reproduces,
      });
      continue;
    }
    const latest = [...own].reverse().find((e) => !ANNOTATION_STAGES.has(e.stage)) ?? first;
    const review = [...own].reverse().find((e) => e.review)?.review;
    const merged = own.find((e) => e.stage === 'merged');
    iterations.push({
      proposalId,
      outcome: first.stage,
      latest: latest.stage,
      ts: first.ts,
      skill: first.skill,
      outlet: first.outlet,
      gateInput: gateInputOf(first),
      reproduces: r.reproduces,
      ...(r.detail ? { reproduceDetail: r.detail } : {}),
      ...(review ? { review } : {}),
      ...(merged ? { merged: merged.change?.ref ?? '(no ref recorded)' } : {}),
    });
  }

  const usedBy = new Map<string, Set<string>>();
  for (const e of i.events) {
    if (!e.proposalId || (e.evidence?.kind !== 'bench' && e.evidence?.kind !== 'template'))
      continue;
    for (const h of e.evidence.evaluationRecords) {
      const s = usedBy.get(h) ?? new Set<string>();
      s.add(e.proposalId);
      usedBy.set(h, s);
    }
  }
  const records: RecordCost[] = i.records
    .map((r) => {
      const measured = r.identity.agent.vendor !== 'external';
      const sum = (f: (o: EvaluationRecord['outcomes'][number]) => number) =>
        r.outcomes.reduce((n, o) => n + f(o), 0);
      return {
        hash: r.hash,
        role: r.role,
        createdAt: r.createdAt,
        agent: `${r.identity.agent.vendor}/${r.identity.agent.version}`,
        measured,
        rollouts: r.outcomes.length,
        rolloutMinutes: round2(sum((o) => o.durationMs) / 60_000),
        requests: sum((o) => o.cost.requests),
        tokensIn: sum((o) => o.cost.tokensIn),
        tokensOut: sum((o) => o.cost.tokensOut),
        usd: sum((o) => o.cost.usd),
        usedBy: [...(usedBy.get(r.hash) ?? [])].sort(),
      };
    })
    .filter((r) => !i.proposalId || r.usedBy.includes(i.proposalId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.hash.localeCompare(b.hash));

  const spendBy = new Map<string, SpendTotal>();
  // A spend event names an evaluation run, not a proposal, so a report narrowed to one proposal
  // cannot attribute it and leaves it out.
  for (const e of i.proposalId ? [] : i.events) {
    if (e.stage !== 'spend' || !e.spend) continue;
    const model = e.spend.model ?? '(unnamed)';
    const t = spendBy.get(model) ?? {
      model,
      events: 0,
      requests: 0,
      rollouts: 0,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
    };
    t.events += 1;
    t.requests += e.spend.requests;
    t.rollouts += e.spend.rollouts;
    t.tokensIn += e.spend.tokensIn;
    t.tokensOut += e.spend.tokensOut;
    t.usd += e.spend.usd;
    spendBy.set(model, t);
  }

  const m = records.filter((r) => r.measured);
  const u = records.filter((r) => !r.measured);
  const total = (rs: RecordCost[], f: (r: RecordCost) => number) =>
    rs.reduce((n, r) => n + f(r), 0);
  const gated = iterations.filter((r) => r.reproduces !== 'no-gate-input');
  return {
    iterations: {
      rows: iterations,
      total: iterations.length,
      accepted: iterations.filter((r) => r.outcome === 'candidate-accepted').length,
      rejected: iterations.filter((r) => r.outcome === 'candidate-rejected').length,
      noAction: iterations.filter((r) => r.outcome === 'no-action').length,
      merged: iterations.filter((r) => r.merged !== undefined).length,
      reviewed: iterations.filter((r) => r.review !== undefined).length,
      gated: gated.length,
      reproduced: gated.filter((r) => r.reproduces === 'yes').length,
    },
    discrimination: {
      rows: controls,
      total: controls.length,
      rejected: controls.filter((r) => r.stage === 'candidate-rejected').length,
      rejectedForReplayRegression: controls.filter((r) => r.shows === 'replay-regression').length,
      accepted: controls.filter((r) => r.shows === 'accepted').length,
    },
    cost: {
      records,
      measured: {
        rollouts: total(m, (r) => r.rollouts),
        requests: total(m, (r) => r.requests),
        tokensIn: total(m, (r) => r.tokensIn),
        tokensOut: total(m, (r) => r.tokensOut),
        usd: total(m, (r) => r.usd),
      },
      unmeasured: {
        rollouts: total(u, (r) => r.rollouts),
        rolloutMinutes: round2(total(u, (r) => r.rolloutMinutes)),
      },
      spend: [...spendBy.values()].sort((a, b) => a.model.localeCompare(b.model)),
    },
  };
}

const short = (h: string | undefined): string => (h ? `${h.slice(0, 12)}…` : '—');
const table = (head: string[], rows: string[][]): string[] => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
];

/** The report as text. `metrics` selects sections; the default is all three. */
export function formatBenchReport(
  r: BenchReport,
  metrics: readonly ReportMetric[] = REPORT_METRICS,
): string {
  const out: string[] = [];
  if (metrics.includes('iterations')) {
    const s = r.iterations;
    out.push(
      '## Iterations',
      '',
      `${s.total} proposal(s): ${s.accepted} accepted, ${s.rejected} rejected, ${s.noAction} no action; ` +
        `${s.merged} merged, ${s.reviewed} reviewed. ${s.reproduced} of ${s.gated} gate decision(s) reproduce.`,
      '',
      ...table(
        [
          'proposal',
          'date',
          'skill',
          'outcome',
          'now',
          'review',
          'merged',
          'gate input',
          'reproduces',
        ],
        s.rows.map((x) => [
          `\`${x.proposalId}\``,
          x.ts.slice(0, 10),
          x.skill ?? '—',
          x.outcome,
          x.latest,
          x.review ? `${x.review.decision}${x.review.by ? ` (${x.review.by})` : ''}` : '—',
          x.merged ?? '—',
          short(x.gateInput),
          x.reproduces === 'no' ? `no: ${x.reproduceDetail ?? ''}` : x.reproduces,
        ]),
      ),
      '',
    );
  }
  if (metrics.includes('discrimination')) {
    const s = r.discrimination;
    out.push(
      '## Discrimination',
      '',
      `${s.total} control arm(s) with a ledger row: ${s.rejected} rejected, ` +
        `${s.rejectedForReplayRegression} of them for a replay regression (06 §10.3); ${s.accepted} accepted.`,
      'A control whose gate ended underpowered or blocked has no ledger row and is not counted here.',
      '',
      ...table(
        ['control', 'date', 'skill', 'stage', 'shows', 'regressed replay task(s)', 'reproduces'],
        s.rows.map((x) => [
          `\`${x.proposalId}\``,
          x.ts.slice(0, 10),
          x.skill ?? '—',
          x.stage,
          x.shows,
          x.regressed.join(', ') || '—',
          x.reproduces,
        ]),
      ),
      '',
    );
  }
  if (metrics.includes('cost')) {
    const s = r.cost;
    out.push(
      '## Cost',
      '',
      `Measured (the harness called the model): ${s.measured.rollouts} rollout(s), ${s.measured.requests} request(s), ` +
        `${s.measured.tokensIn} tokens in, ${s.measured.tokensOut} out, $${s.measured.usd.toFixed(2)}.`,
      `Unmeasured (an external agent ran the rollout and reported no usage): ${s.unmeasured.rollouts} rollout(s), ` +
        `${s.unmeasured.rolloutMinutes} rollout-minute(s). Their requests, tokens and dollars are unknown, not zero.`,
      '',
      ...table(
        [
          'record',
          'role',
          'date',
          'agent',
          'rollouts',
          'rollout-min',
          'requests',
          'tokens in/out',
          'usd',
          'cited by',
        ],
        s.records.map((x) => [
          short(x.hash),
          x.role,
          x.createdAt.slice(0, 10),
          x.agent,
          String(x.rollouts),
          String(x.rolloutMinutes),
          x.measured ? String(x.requests) : 'unmeasured',
          x.measured ? `${x.tokensIn}/${x.tokensOut}` : 'unmeasured',
          x.measured ? x.usd.toFixed(2) : 'unmeasured',
          x.usedBy.map((p) => `\`${p}\``).join(', ') || '—',
        ]),
      ),
      '',
    );
    if (s.spend.length > 0) {
      out.push(
        'Harness `spend` events (rollout, judge and role requests the harness made itself):',
        '',
        ...table(
          ['model', 'events', 'requests', 'rollouts', 'tokens in/out', 'usd'],
          s.spend.map((x) => [
            x.model,
            String(x.events),
            String(x.requests),
            String(x.rollouts),
            `${x.tokensIn}/${x.tokensOut}`,
            x.usd.toFixed(2),
          ]),
        ),
        '',
      );
    }
  }
  return out.join('\n');
}
