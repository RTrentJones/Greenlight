import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_FILE } from './load';
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
 * Appends one event to `<root>/ledger.jsonl`. Refuses — writing nothing — an event whose writer is
 * not the harness or which fails `LedgerEventSchema`. An unsealed event is sealed with `sealEvent`;
 * a sealed one must carry the right `eventId` (the schema re-derives it). Returns what was written.
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
  // A file whose last line lacks its newline would otherwise fuse with the new line.
  const lead = existsSync(file) && !/(^|\n)$/.test(readFileSync(file, 'utf8')) ? '\n' : '';
  appendFileSync(file, `${lead}${canonicalJson(result.data)}\n`);
  return result.data;
}

export interface ProposalHistory {
  proposalId: string;
  /** The proposal's events in ledger (append) order. */
  events: LedgerEvent[];
  latest?: LedgerEvent['stage'];
  /** Stage-machine violations (06 §6.1); empty for a well-formed history. */
  problems: string[];
}

export function proposalHistory(
  events: readonly LedgerEvent[],
  proposalId: string,
): ProposalHistory {
  const own = events.filter((e) => e.proposalId === proposalId);
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
    .sort((a, b) => b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id));
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
