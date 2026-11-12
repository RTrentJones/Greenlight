import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LEDGER_FILE, parseLedger } from './load';
import {
  ANNOTATION_STAGES,
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

// ---- cross-process file lock ----------------------------------------------------------------

export class FileLockTimeoutError extends Error {
  constructor(readonly lock: string) {
    super(`timed out waiting for the lock ${lock}`);
    this.name = 'FileLockTimeoutError';
  }
}

export interface FileLockOptions {
  /** A lock whose mtime is older than this is presumed abandoned by a crashed holder (default
   * 30s). A live holder slower than this loses exclusion, so callers keep the critical section
   * short. */
  staleMs?: number;
  /** How long to wait for the lock before throwing `FileLockTimeoutError` (default 10s). */
  timeoutMs?: number;
  now?: () => number;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readToken(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Runs `fn` while holding `<lock>.guard`, a short-held O_EXCL lock that serializes every
 * REMOVAL of the main lock (a steal or a release), so two waiters can never both remove it. */
function underGuard(lock: string, staleMs: number, now: () => number, fn: () => void): void {
  const guard = `${lock}.guard`;
  const deadline = now() + Math.max(staleMs, 1_000);
  for (;;) {
    try {
      closeSync(openSync(guard, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // The guard is held for microseconds; one this old belongs to a holder that crashed inside
      // the guarded section.
      const m = mtimeOf(guard);
      if (m !== undefined && now() - m > staleMs) rmSync(guard, { force: true });
      else if (now() > deadline) throw new FileLockTimeoutError(guard);
      else pause(2);
    }
  }
  try {
    fn();
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Runs `fn` under an exclusive cross-process lock file. The lock is created with O_EXCL and holds
 * a random token. Every removal is token-checked and serialized under a guard file:
 *
 * - a waiter that finds a stale lock removes it only if the lock still holds the token it saw and
 *   is still stale, so two waiters can never both steal (one would otherwise delete the lock the
 *   other has just created);
 * - the holder removes the lock only if it still holds its own token, so a holder whose lock was
 *   stolen never deletes the next holder's lock.
 */
export function withFileLock<T>(lock: string, fn: () => T, opts: FileLockOptions = {}): T {
  const staleMs = opts.staleMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 10_000);
  const token = `${process.pid}.${randomBytes(12).toString('hex')}`;
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const seen = readToken(lock);
      const m = mtimeOf(lock);
      if (seen === undefined || m === undefined) continue; // released between open and read
      if (now() - m > staleMs) {
        underGuard(lock, staleMs, now, () => {
          const cur = mtimeOf(lock);
          if (readToken(lock) === seen && cur !== undefined && now() - cur > staleMs) {
            rmSync(lock, { force: true });
          }
        });
        continue;
      }
      if (now() > deadline) throw new FileLockTimeoutError(lock);
      pause(5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      underGuard(lock, staleMs, now, () => {
        if (readToken(lock) === token) rmSync(lock, { force: true });
      });
    } catch {
      // Could not take the guard: leave the lock to go stale rather than mask fn's outcome.
    }
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
 *
 * The read-check-append runs under `<ledger>.lock` (`withFileLock`): the ledger is re-read under
 * the lock, so two processes appending at once cannot both pass the duplicate and stage-machine
 * checks against the same snapshot.
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
  const data = result.data;
  return withFileLock(`${file}.lock`, () => appendLocked(file, data));
}

function appendLocked(file: string, next: LedgerEvent): LedgerEvent {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const existing = parseLedger(text).events;
  if (existing.some((e) => e.eventId === next.eventId)) {
    throw new LedgerWriteError(`refused: eventId ${next.eventId} is already in the ledger`);
  }
  checkAppend(existing, next);
  // A file whose last line lacks its newline would otherwise fuse with the new line.
  const lead = text !== '' && !/(^|\n)$/.test(text) ? '\n' : '';
  appendFileSync(file, `${lead}${canonicalJson(next)}\n`);
  return next;
}

/** Refuses `next` when it would add a stage-machine problem to its proposal's history. */
function checkAppend(existing: readonly LedgerEvent[], next: LedgerEvent): void {
  if (next.proposalId === undefined) return;
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

/**
 * Appends several sealed events all or nothing, under one lock and in one write. Idempotent by
 * eventId: an event already in the ledger is skipped (a retry after a crash appends only what is
 * missing). Every new event is validated against the ledger plus the ones before it; a refusal
 * writes nothing.
 */
export function appendEvents(
  root: string,
  events: readonly LedgerEventInput[],
  opts: { repairTornTail?: boolean } = {},
): { appended: LedgerEvent[]; present: LedgerEvent[]; repaired?: string } {
  const sealed = events.map((event) => {
    if ((event as { writer?: unknown }).writer !== 'harness') {
      throw new LedgerWriteError(
        'refused: only the harness writes the ledger (writer must be "harness")',
      );
    }
    const { eventId, writer: _writer, ...rest } = event;
    const e = eventId === undefined ? sealEvent(rest) : { ...event, eventId };
    const r = LedgerEventSchema.safeParse(e);
    if (!r.success) {
      const why = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new LedgerWriteError(`refused: ${why}`);
    }
    return r.data;
  });
  const file = join(root, LEDGER_FILE);
  return withFileLock(`${file}.lock`, () => {
    let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    let repaired: string | undefined;
    if (opts.repairTornTail && text !== '' && !text.endsWith('\n')) {
      // A last line without its newline that does not parse is a torn write (a crash mid-append):
      // it is cut, under the lock, before anything is appended. A complete last line only lacks
      // its newline and is kept.
      const cut = text.lastIndexOf('\n') + 1;
      const tail = text.slice(cut);
      let whole = false;
      try {
        whole = LedgerEventSchema.safeParse(JSON.parse(tail)).success;
      } catch {
        whole = false;
      }
      if (!whole) {
        truncateSync(file, Buffer.byteLength(text.slice(0, cut)));
        text = text.slice(0, cut);
        repaired = tail;
      }
    }
    const acc = [...parseLedger(text).events];
    const appended: LedgerEvent[] = [];
    const present: LedgerEvent[] = [];
    for (const e of sealed) {
      if (acc.some((x) => x.eventId === e.eventId)) {
        present.push(e);
        continue;
      }
      checkAppend(acc, e);
      acc.push(e);
      appended.push(e);
    }
    if (appended.length > 0) {
      const lead = text !== '' && !/(^|\n)$/.test(text) ? '\n' : '';
      appendFileSync(file, `${lead}${appended.map((e) => `${canonicalJson(e)}\n`).join('')}`);
    }
    return { appended, present, ...(repaired !== undefined ? { repaired } : {}) };
  });
}

export interface ProposalHistory {
  proposalId: string;
  /** The proposal's events in time order (parsed instants; ties keep append order). */
  events: LedgerEvent[];
  /** The latest stage-machine stage; a `review` annotation never counts as one. */
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
    latest: [...own].reverse().find((e) => !ANNOTATION_STAGES.has(e.stage))?.stage,
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
  // A history built from a seen id has ≥1 event; the row's stage is the latest non-annotation one.
  const last = ([...evs].reverse().find((e) => !ANNOTATION_STAGES.has(e.stage)) ??
    evs.at(-1)) as LedgerEvent;
  const skill = evs.find((e) => e.skill)?.skill;
  const outlet = evs.find((e) => e.outlet)?.outlet;
  const target = [skill, outlet && (skill ? `(${outlet})` : outlet)].filter(Boolean).join(' ');
  const patterns = [...new Set(evs.flatMap((e) => e.pattern ?? []))].join(', ');
  const path = [...evs].reverse().find((e) => e.path)?.path ?? '';
  const evidence = evs.flatMap(evidenceLines);
  if (unmeasured(evs)) evidence.push('**unmeasured**');
  for (const e of evs) {
    if (e.review) evidence.push(`owner review ${e.ts.slice(0, 10)}: ${e.review.decision}`);
  }
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

// ---- the projected ledger for agent bundles (06 §1.4) ----------------------------------------

/** One model × mode's aggregate val score, as the proposer may see it (06 §1.4). */
export interface ProjectedScore {
  model: string;
  mode: GateResult['mode'];
  before: number;
  after: number;
  delta: number;
  decision: GateResult['decision'];
}

/**
 * A ledger event as an agent bundle holds it. Only the fields 06 §1.4 lets a role see survive:
 * stage, proposal, outlet, skill, path, control, cited patterns, versions and release, the KIND of
 * evidence, and (proposer only) the aggregate val score per model × mode. Per-task regressions,
 * replay counts, p-values, reason text, diffs, repro task ids, check names, evaluation hashes and
 * every test-split result are dropped, as are `spend` and `release-check` events.
 */
export interface ProjectedEvent {
  ts: string;
  proposalId?: string;
  stage: LedgerEvent['stage'];
  path?: LedgerEvent['path'];
  control?: boolean;
  outlet?: LedgerEvent['outlet'];
  skill?: string;
  pattern?: string[];
  versionFrom?: string;
  versionTo?: string;
  release?: string;
  evidence?: NonNullable<LedgerEvent['evidence']>['kind'];
  scores?: ProjectedScore[];
}

export type ProjectionRole = 'maintainer' | 'proposer';

/** The ledger projected for `role`, in ledger order. The maintainer sees no val results at all,
 * so its projection carries no scores (06 §1.4). */
export function projectLedger(
  events: readonly LedgerEvent[],
  role: ProjectionRole,
): ProjectedEvent[] {
  return events
    .filter((e) => e.stage !== 'spend' && e.stage !== 'release-check')
    .map((e) => {
      const ev = e.evidence;
      const results = ev && (ev.kind === 'bench' || ev.kind === 'template') ? ev.results : [];
      const scores =
        role === 'proposer'
          ? results
              .filter((r) => r.split === 'val')
              .map((r) => ({
                model: r.model,
                mode: r.mode,
                before: r.capability.before,
                after: r.capability.after,
                delta: r.capability.delta,
                decision: r.decision,
              }))
          : [];
      const out: ProjectedEvent = { ts: e.ts, stage: e.stage };
      if (e.proposalId !== undefined) out.proposalId = e.proposalId;
      if (e.path !== undefined) out.path = e.path;
      if (e.control !== undefined) out.control = e.control;
      if (e.outlet !== undefined) out.outlet = e.outlet;
      if (e.skill !== undefined) out.skill = e.skill;
      if (e.pattern !== undefined) out.pattern = [...e.pattern];
      if (e.versionFrom !== undefined) out.versionFrom = e.versionFrom;
      if (e.versionTo !== undefined) out.versionTo = e.versionTo;
      if (e.release !== undefined) out.release = e.release;
      if (ev !== undefined) out.evidence = ev.kind;
      if (scores.length > 0) out.scores = scores;
      return out;
    });
}

/** The projected ledger as JSONL, one canonical object per line. */
export const projectedLedgerText = (events: readonly ProjectedEvent[]): string =>
  events.map((e) => `${canonicalJson(e as unknown as Record<string, unknown>)}\n`).join('');

function projectedRow(id: string, evs: readonly ProjectedEvent[]): Row {
  const ordered = evs
    .map((e, i) => ({ e, i }))
    .sort((x, y) => compareTs(x.e.ts, y.e.ts) || x.i - y.i)
    .map(({ e }) => e);
  const last = ([...ordered].reverse().find((e) => !ANNOTATION_STAGES.has(e.stage)) ??
    ordered.at(-1)) as ProjectedEvent;
  const skill = ordered.find((e) => e.skill)?.skill;
  const outlet = ordered.find((e) => e.outlet)?.outlet;
  const target = [skill, outlet && (skill ? `(${outlet})` : outlet)].filter(Boolean).join(' ');
  const patterns = [...new Set(ordered.flatMap((e) => e.pattern ?? []))].join(', ');
  const path = [...ordered].reverse().find((e) => e.path)?.path ?? '';
  const evidence = ordered.flatMap((e) => {
    if (!e.evidence) return [];
    if (!e.scores) return [`${e.stage}: ${e.evidence} evidence`];
    return e.scores.map(
      (s) =>
        `${e.stage}: ${s.model} ${s.mode}/val: capability ${pct(s.before)}→${pct(s.after)} (${signed(s.delta)}) → ${s.decision}`,
    );
  });
  const accepted = ordered.some((e) => e.stage === 'candidate-accepted');
  const measured = ordered.some((e) => e.evidence === 'bench' || e.evidence === 'template');
  if (accepted && !measured) evidence.push('**unmeasured**');
  const cells = [
    last.ts.slice(0, 10),
    id,
    target || '—',
    patterns || '—',
    path || '—',
    last.stage,
    evidence.join('<br>') || '—',
  ];
  return {
    ts: last.ts,
    id,
    control: ordered.some((e) => e.control === true),
    line: `| ${cells.map(cell).join(' | ')} |`,
  };
}

/**
 * `skill-impact.md` as an agent bundle holds it: the layout of `renderSkillImpact`, rendered from
 * the projected ledger, so no regression list, reason or task id can reach a sandbox.
 */
export function renderProjectedSkillImpact(events: readonly ProjectedEvent[]): string {
  const ids = [...new Set(events.flatMap((e) => (e.proposalId ? [e.proposalId] : [])))];
  const rows = ids
    .map((id) =>
      projectedRow(
        id,
        events.filter((e) => e.proposalId === id),
      ),
    )
    .sort((a, b) => compareTs(b.ts, a.ts) || a.id.localeCompare(b.id));
  return [
    '# Skill impact',
    '',
    '<!-- projected from ledger.jsonl for an agent bundle (06 §1.4): aggregate scores only -->',
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
