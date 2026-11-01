import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_FILE, parseLedger } from './load';
import {
  type GateResult,
  type LedgerEvent,
  LedgerEventSchema,
  checkProposalHistory,
  sealEvent,
} from './schema';
import { canonicalJson } from './schema/common';

/**
 * The ledger (vision 08 §8): `ledger.jsonl` is append-only and harness-written. `appendEvent` is
 * the only writer; `renderSkillImpact` derives `skill-impact.md` from it, so the rendered file is
 * never edited by hand (LR-14 compares the two).
 */

export class LedgerWriteError extends Error {
  constructor(message: string) {
    super(`ledger: ${message}`);
    this.name = 'LedgerWriteError';
  }
}

/** An event as the harness hands it over: sealed already, or unsealed (no `eventId` yet). */
export type LedgerEventInput = Omit<LedgerEvent, 'eventId'> & { eventId?: string };

/**
 * Compares two ISO timestamps as instants (08 §8 `ts`), not as strings: `…:00Z` and `…:00.000Z`
 * are equal, and `…:00.1Z` is later than `…:00Z`. Fractions are compared to any precision.
 * Timestamps the schema accepts are UTC (`Z`), so the whole-second part parses exactly.
 */
export function compareTs(a: string, b: string): number {
  const split = (ts: string): [number, string] => {
    const m = /^(.*?)(?:\.(\d+))?Z$/.exec(ts);
    const whole = m?.[1] ?? ts;
    const frac = m?.[2] ?? '';
    return [Date.parse(`${whole}Z`), frac.replace(/0+$/, '')];
  };
  const [sa, fa] = split(a);
  const [sb, fb] = split(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  const w = Math.max(fa.length, fb.length);
  const pa = fa.padEnd(w, '0');
  const pb = fb.padEnd(w, '0');
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/** Events in time order by parsed instant; equal instants keep their ledger (append) order. */
export function orderLedgerEvents(events: readonly LedgerEvent[]): LedgerEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((x, y) => compareTs(x.e.ts, y.e.ts) || x.i - y.i)
    .map(({ e }) => e);
}

/**
 * Whole-ledger problems (LR-14, 06 §6.1): duplicate eventIds, and every proposal whose history
 * breaks the stage machine. Each problem is one human-readable line.
 */
export function ledgerProblems(events: readonly LedgerEvent[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.eventId)) out.push(`duplicate eventId ${e.eventId}`);
    seen.add(e.eventId);
  }
  for (const id of proposalIds(events)) {
    for (const p of proposalHistory(events, id).problems) out.push(`proposal ${id}: ${p}`);
  }
  return out;
}

/**
 * Appends one event to `<root>/ledger.jsonl`. Refuses — writing nothing — an event whose writer is
 * not the harness, which fails `LedgerEventSchema`, whose eventId is already in the ledger, or
 * which would make its proposal's history break the stage machine (06 §6.1): e.g. `merged` after
 * `candidate-rejected`. An unsealed event is sealed with `sealEvent`; a sealed one must carry the
 * right `eventId` (the schema re-derives it). Lines of the existing ledger that fail to parse are
 * left for LR-14 to report. Returns what was written.
 */
export function appendEvent(root: string, event: LedgerEventInput): LedgerEvent {
  if ((event as { writer?: unknown }).writer !== 'harness') {
    throw new LedgerWriteError(
      'refused: only the harness writes the ledger (writer must be "harness")',
    );
  }
  const { eventId, writer: _writer, ...rest } = event;
  const sealed = eventId === undefined ? sealEvent(rest) : { ...event, eventId };
  const result = LedgerEventSchema.safeParse(sealed);
  if (!result.success) {
    const why = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new LedgerWriteError(`refused: ${why}`);
  }
  const file = join(root, LEDGER_FILE);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const existing = parseLedger(text).events;
  const next = result.data;
  if (existing.some((e) => e.eventId === next.eventId)) {
    throw new LedgerWriteError(`refused: eventId ${next.eventId} is already in the ledger`);
  }
  if (next.proposalId !== undefined) {
    const before = proposalHistory(existing, next.proposalId);
    const after = proposalHistory([...existing, next], next.proposalId);
    const added = after.problems.filter((p) => !before.problems.includes(p));
    if (after.events.at(-1) !== next) {
      added.unshift(`ts ${next.ts} is earlier than the proposal's latest event`);
    }
    if (added.length > 0) {
      throw new LedgerWriteError(`refused for proposal ${next.proposalId}: ${added.join('; ')}`);
    }
  }
  // A file whose last line lacks its newline would otherwise fuse with the new line.
  const lead = text !== '' && !/(^|\n)$/.test(text) ? '\n' : '';
  appendFileSync(file, `${lead}${canonicalJson(result.data)}\n`);
  return result.data;
}

export interface ProposalHistory {
  proposalId: string;
  /** The proposal's events in time order (parsed instants; ties keep append order). */
  events: LedgerEvent[];
  latest?: LedgerEvent['stage'];
  /** Stage-machine violations (06 §6.1); empty for a well-formed history. */
  problems: string[];
}

export function proposalHistory(
  events: readonly LedgerEvent[],
  proposalId: string,
): ProposalHistory {
  const own = orderLedgerEvents(events.filter((e) => e.proposalId === proposalId));
  return {
    proposalId,
    events: own,
    latest: own.at(-1)?.stage,
    problems: checkProposalHistory(own),
  };
}

/** Proposal ids in first-seen order (spend and release-check events have none). */
function proposalIds(events: readonly LedgerEvent[]): string[] {
  return [...new Set(events.flatMap((e) => (e.proposalId ? [e.proposalId] : [])))];
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const pct = (x: number): string => x.toFixed(2);
const signed = (x: number): string => (x >= 0 ? `+${pct(x)}` : pct(x));

/** One model × mode, kept separate because the gate decides per model and mode (06 §5.4). */
function gateLine(r: GateResult): string {
  const p = r.capability.pValue === null ? '' : `, p=${r.capability.pValue}`;
  const regressions = r.replay.regressions.length
    ? `, ${r.replay.regressions.length} regressed`
    : '';
  return (
    `${r.model} ${r.mode}/${r.split}: capability ${pct(r.capability.before)}→${pct(r.capability.after)} ` +
    `(${signed(r.capability.delta)}${p}), replay ${r.replay.candidatePassing}/${r.replay.total}` +
    `${regressions} → ${r.decision}`
  );
}

function evidenceLines(e: LedgerEvent): string[] {
  const ev = e.evidence;
  if (!ev) return [];
  const at = `${e.stage}:`;
  switch (ev.kind) {
    case 'bench':
      return ev.results.map((r) => `${at} ${gateLine(r)}`);
    case 'template':
      return [
        `${at} template, ${ev.mutantsFailed}/${ev.mutantsTotal} mutants caught (${ev.lanes.join(', ')})`,
        ...ev.results.map((r) => `${at} ${gateLine(r)}`),
      ];
    case 'repro':
      return [`${at} repro ${ev.reproTask}, fails on ${ev.base}, passes on ${ev.candidate}`];
    case 'artifact':
      return [`${at} artifact check ${ev.check}, ${ev.faulty} → ${ev.fixed}`];
    case 'field':
      return [`${at} field check ${ev.check}, ${ev.before} → ${ev.after}`];
  }
}

/** A change admitted without bench or template evidence is shown as unmeasured (05 §4). */
function unmeasured(events: readonly LedgerEvent[]): boolean {
  const accepted = events.some((e) => e.stage === 'candidate-accepted');
  const measured = events.some(
    (e) => e.evidence?.kind === 'bench' || e.evidence?.kind === 'template',
  );
  return accepted && !measured;
}

interface Row {
  ts: string;
  id: string;
  control: boolean;
  line: string;
}

function proposalRow(history: ProposalHistory): Row {
  const evs = history.events;
  const last = evs.at(-1) as LedgerEvent; // a history built from a seen id has ≥1 event
  const skill = evs.find((e) => e.skill)?.skill;
  const outlet = evs.find((e) => e.outlet)?.outlet;
  const target = [skill, outlet && (skill ? `(${outlet})` : outlet)].filter(Boolean).join(' ');
  const patterns = [...new Set(evs.flatMap((e) => e.pattern ?? []))].join(', ');
  const path = [...evs].reverse().find((e) => e.path)?.path ?? '';
  const evidence = evs.flatMap(evidenceLines);
  if (unmeasured(evs)) evidence.push('**unmeasured**');
  const cells = [
    last.ts.slice(0, 10),
    history.proposalId,
    target || '—',
    patterns || '—',
    path || '—',
    last.stage,
    evidence.join('<br>') || '—',
  ];
  return {
    ts: last.ts,
    id: history.proposalId,
    control: evs.some((e) => e.control === true),
    line: `| ${cells.map(cell).join(' | ')} |`,
  };
}

const TABLE_HEAD =
  '| date | proposal | skill / outlet | patterns | path | latest stage | evidence |\n' +
  '|---|---|---|---|---|---|---|';

function table(rows: readonly Row[], empty: string): string {
  return rows.length ? `${TABLE_HEAD}\n${rows.map((r) => r.line).join('\n')}` : empty;
}

/**
 * Renders `skill-impact.md` (08 §8): one row per proposal, newest first by its latest event, with
 * control-arm proposals in their own table. Deterministic for a given event list, so LR-14 can
 * compare the committed file byte-for-byte.
 */
export function renderSkillImpact(events: readonly LedgerEvent[]): string {
  const rows = proposalIds(events)
    .map((id) => proposalRow(proposalHistory(events, id)))
    .sort((a, b) => compareTs(b.ts, a.ts) || a.id.localeCompare(b.id));
  return [
    '# Skill impact',
    '',
    '<!-- rendered from ledger.jsonl by `greenlight wiki render`; do not edit by hand -->',
    '',
    '## Proposals',
    '',
    table(
      rows.filter((r) => !r.control),
      '_No proposals yet._',
    ),
    '',
    '## Controls',
    '',
    table(
      rows.filter((r) => r.control),
      '_No control proposals._',
    ),
    '',
  ].join('\n');
}
