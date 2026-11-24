import { existsSync } from 'node:fs';
import { appendEvents, proposalHistory, renderSkillImpact } from '../../ledger';
import { SKILL_IMPACT_FILE } from '../../load';
import { writeChangeset } from '../../patch';
import { type LedgerEvent, movesSkillSet, sealEvent } from '../../schema';
import { skillSetHashOf } from '../identity';
import { ledgerEvents } from './context';
import { writeHandoff } from './handoff';
import {
  ITERATION_ID_RE,
  acquireLock,
  iterationDir,
  iterationStatePath,
  loadIterationState,
  saveState,
} from './state';
import { IterationError } from './types';

// ---- review (M2-04) ---------------------------------------------------------------------------

/**
 * Records the owner's review of an iteration's ledger rows (06 §0 condition 4, 13 §3 M2 #6). For
 * every recorded proposal of the iteration (the real one and each control), by the proposal's
 * LATEST ledger stage (not the stage the iteration recorded, which may have moved on):
 * - a `reject` of a proposal whose latest stage is accepted or later (`candidate-accepted`,
 *   `merged`, `released`, `verified-in-production`) is a `withdrawn` event (06 §6.1: abandoned
 *   after acceptance, with the reason), carrying the review;
 * - everything else is a `review` annotation event: a stage that may follow any stage, final ones
 *   included, and never moves the stage machine (08 §8).
 * Under the iteration lock, every event is computed first and saved in the state, then appended
 * all or nothing (`appendEvents`); a retry after a crash appends the same events (same eventIds),
 * so nothing is duplicated. Refuses an iteration with nothing recorded yet, or one already reviewed.
 */
/**
 * The decision recorded on one reviewed ledger row. `--decision` is the owner's verdict on the
 * iteration's real proposal. A control arm (06 §10.2 step 4) is never merged, so its row is always
 * recorded as a rejection: an owner who accepts a candidate or a justified `no_action` must not
 * thereby record an acceptance of the plausible but wrong control beside it.
 */
export function rowDecision(
  target: Pick<LedgerEvent, 'control'>,
  decision: 'accept' | 'reject',
): 'accept' | 'reject' {
  return target.control === true ? 'reject' : decision;
}

export function reviewIteration(o: {
  stateDir: string;
  wikiRoot: string;
  skillsDir: string;
  iterationId: string;
  decision: 'accept' | 'reject';
  reason: string;
  /** Who is reviewing, recorded on every event (`review.by`). */
  reviewer?: string;
  benchDir?: string;
  now?: () => Date;
  breakLock?: boolean;
  log?: (s: string) => void;
}): { eventIds: string[]; events: LedgerEvent[] } {
  const now = o.now ?? (() => new Date());
  const reason = o.reason.trim();
  if (!reason) throw new IterationError('a review needs --reason', 2);
  const reviewer = o.reviewer?.trim() || undefined;
  if (reviewer !== undefined && (reviewer.length > 120 || /[\r\n]/.test(reviewer)))
    throw new IterationError('--reviewer is one line of at most 120 characters', 2);
  if (!ITERATION_ID_RE.test(o.iterationId))
    throw new IterationError(`"${o.iterationId}" is not an iteration id`, 2);
  if (!existsSync(iterationStatePath(o.stateDir, o.iterationId)))
    throw new IterationError(`no iteration ${o.iterationId}`, 2);
  const unlock = acquireLock(iterationDir(o.stateDir, o.iterationId), o.log, {
    breakLock: o.breakLock === true,
  });
  try {
    const s = loadIterationState(o.stateDir, o.iterationId);
    if (s.review) {
      throw new IterationError(
        `iteration ${s.iterationId} was already reviewed (${s.review.decision}, ${s.review.ts})`,
        4,
      );
    }
    const recorded = new Set(s.record.eventIds ?? []);
    const targets = [s.evaluate.event, ...s.control.items.map((i) => i.event)].filter(
      (e): e is LedgerEvent => e !== undefined && recorded.has(e.eventId),
    );
    if (s.record.status !== 'done' || targets.length === 0) {
      throw new IterationError(
        `iteration ${s.iterationId} has no recorded ledger rows to review yet (step ${s.step}: ${s.status})`,
        4,
      );
    }
    let pending = s.reviewPending;
    if (
      pending &&
      (pending.decision !== o.decision || pending.reason !== reason || pending.by !== reviewer)
    ) {
      throw new IterationError(
        `iteration ${s.iterationId} has a half-recorded review (${pending.decision}${pending.by ? ` by ${pending.by}` : ''}: ${pending.reason}); rerun it with the same --decision, --reason and --reviewer to finish it`,
        4,
      );
    }
    // The events are DERIVED from the state and the ledger, never taken from a stored copy: a
    // pending review keeps only its decision, reason and ts, and its events must re-derive to the
    // same eventIds (the ledger read without them, in case a crash left them appended).
    const derive = (ts: string, without: ReadonlySet<string>) => {
      const ledger = ledgerEvents(o.wikiRoot).filter((e) => !without.has(e.eventId));
      return targets.map((target) => {
        const history = proposalHistory(ledger, target.proposalId as string);
        const latest = history.latest;
        const decision = rowDecision(target, o.decision);
        const withdraw = decision === 'reject' && latest !== undefined && AFTER_ACCEPT.has(latest);
        // 06 §6.1: withdrawing a MERGED skill change is a new accepted state, named by the
        // installed skill set (the owner reverts the merge first, then records the review).
        const reverts =
          withdraw && latest !== 'candidate-accepted' && movesSkillSet(history.events);
        return sealEvent({
          ts,
          proposalId: target.proposalId,
          stage: withdraw ? 'withdrawn' : 'review',
          ...(reverts ? { skillSetHash: skillSetHashOf(o.skillsDir) } : {}),
          ...(target.control ? { control: true } : {}),
          reason: `owner review (${decision}): ${reason}`,
          review: {
            decision,
            iteration: s.iterationId,
            ...(reviewer ? { by: reviewer } : {}),
          },
        });
      });
    };
    let events: LedgerEvent[];
    if (pending) {
      const stored = new Set(pending.events.map((e) => e.eventId));
      events = derive(pending.ts, stored);
      const same =
        events.length === pending.events.length &&
        events.every((e, i) => e.eventId === pending?.events[i]?.eventId);
      if (!same) {
        throw new IterationError(
          `iteration ${s.iterationId} has a half-recorded review whose events do not re-derive from the state and the ledger; refusing to append them`,
          4,
        );
      }
    } else {
      const ts = now().toISOString();
      events = derive(ts, new Set());
      pending = { decision: o.decision, reason, ts, events, ...(reviewer ? { by: reviewer } : {}) };
      s.reviewPending = pending;
      saveState(o.stateDir, s, now());
    }

    try {
      // A torn trailing line (a crash mid-append) is repaired under the ledger lock first.
      appendEvents(o.wikiRoot, events, { repairTornTail: true });
    } catch (e) {
      // The pending review is KEPT: a retry derives and appends the same events (same eventIds,
      // same reason), never new ones.
      throw new IterationError(
        `the review was not recorded (${(e as Error).message}); rerun it with the same --decision and --reason`,
        4,
      );
    }
    writeChangeset(o.wikiRoot, {
      writes: [{ path: SKILL_IMPACT_FILE, content: renderSkillImpact(ledgerEvents(o.wikiRoot)) }],
    });
    s.review = {
      decision: o.decision,
      reason,
      ts: pending.ts,
      eventIds: events.map((e) => e.eventId),
      ...(reviewer ? { by: reviewer } : {}),
    };
    s.reviewPending = undefined;
    saveState(o.stateDir, s, now());
    writeHandoff({
      stateDir: o.stateDir,
      skillsDir: o.skillsDir,
      wikiRoot: o.wikiRoot,
      iterationId: s.iterationId,
      ...(o.benchDir ? { benchDir: o.benchDir } : {}),
    });
    return { eventIds: s.review.eventIds, events };
  } finally {
    unlock();
  }
}

/** Stages a reject withdraws (06 §6.1 `withdrawn`: reverted or abandoned after acceptance). */
const AFTER_ACCEPT: ReadonlySet<string> = new Set([
  'candidate-accepted',
  'merged',
  'released',
  'verified-in-production',
]);
