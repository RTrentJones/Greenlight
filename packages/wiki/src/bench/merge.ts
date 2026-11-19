/**
 * Recording a merge (06 §6.1). A `merged` ledger event is what moves the accepted skill set, so
 * it is written only when the tree it is recorded from IS the tree the gate evaluated: the
 * installed skill set must hash to the candidate skill set of the proposal's gate input. A merge
 * that changed the gated text (a squash with edits, a conflict resolution, a second change on
 * top) is refused, because no evaluation ever ran that tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LedgerWriteError,
  appendEvents,
  gateInputOfEvent,
  proposalHistory,
  readGateSkillSets,
  renderSkillImpact,
} from '../ledger';
import { LEDGER_FILE, SKILL_IMPACT_FILE, parseLedger } from '../load';
import { writeChangeset } from '../patch';
import { type LedgerEvent, sealEvent } from '../schema/ledger';
import { skillSetHashOf } from './identity';
import { IterationError } from './iterate';

export interface RecordMergeOptions {
  wikiRoot: string;
  skillsDir: string;
  proposalId: string;
  /** Where the merge is: a commit sha or a pull request URL. Recorded as `change.ref`. */
  ref: string;
  now?: () => Date;
}

export interface RecordMergeResult {
  event: LedgerEvent;
  /** True when the ledger already held this proposal's `merged` event: nothing was written. */
  already: boolean;
  /** The accepted skill set after the merge; absent for an outlet that moves no skill set. */
  acceptedSkillSetHash?: string;
}

const short = (h: string): string => h.slice(0, 12);

function readLedger(wikiRoot: string): LedgerEvent[] {
  const f = join(wikiRoot, LEDGER_FILE);
  return existsSync(f) ? parseLedger(readFileSync(f, 'utf8')).events : [];
}

/**
 * Appends the `merged` event of an accepted proposal and rewrites `skill-impact.md`. Idempotent:
 * a proposal already merged returns its event and writes nothing. Refuses (exit 4) a proposal
 * that is not at `candidate-accepted`, a control-arm proposal, and a skill or template proposal
 * whose gated candidate is not the installed skill set. Usage errors are exit 2.
 */
export function recordMerge(o: RecordMergeOptions): RecordMergeResult {
  const ref = o.ref.trim();
  if (!ref) throw new IterationError('a merge needs --ref <commit sha or pull request URL>', 2);
  const ledger = readLedger(o.wikiRoot);
  const history = proposalHistory(ledger, o.proposalId);
  if (history.events.length === 0) {
    throw new IterationError(`no proposal ${o.proposalId} in ${join(o.wikiRoot, LEDGER_FILE)}`, 2);
  }
  const accepted = history.events.find((e) => e.stage === 'candidate-accepted');
  const gateInput = gateInputOfEvent(accepted);
  const sets = gateInput === undefined ? undefined : readGateSkillSets(o.wikiRoot, gateInput);
  const mergedAlready = history.events.find((e) => e.stage === 'merged');
  if (mergedAlready && history.latest === 'merged') {
    return {
      event: mergedAlready,
      already: true,
      ...(sets ? { acceptedSkillSetHash: sets.candidateSkillSetHash } : {}),
    };
  }
  if (history.events.some((e) => e.control === true)) {
    throw new IterationError(
      `proposal ${o.proposalId} is a control-arm proposal: it is never merged (06 §6.1)`,
      4,
    );
  }
  if (history.latest !== 'candidate-accepted' || accepted === undefined) {
    throw new IterationError(
      `proposal ${o.proposalId} is at stage "${history.latest ?? 'none'}", not candidate-accepted: only an accepted proposal is merged`,
      4,
    );
  }
  if (gateInput !== undefined) {
    if (!sets) {
      throw new IterationError(
        `proposal ${o.proposalId}: its gate input ${gateInput} is not readable under ${o.wikiRoot}, so what was gated is unknown`,
        3,
      );
    }
    const installed = skillSetHashOf(o.skillsDir);
    if (installed !== sets.candidateSkillSetHash) {
      const unmerged = installed === sets.acceptedSkillSetHash;
      throw new IterationError(
        unmerged
          ? `proposal ${o.proposalId}: the installed skills (${short(installed)}) are still the pre-merge set; check out the tree the change was merged into, then record the merge`
          : `proposal ${o.proposalId}: the installed skills (${short(installed)}) are not the candidate the gate evaluated (${short(sets.candidateSkillSetHash)}). No evaluation ran this tree: merge the gated change unchanged, or gate the current skills again`,
        4,
      );
    }
  }
  const event = sealEvent({
    ts: (o.now ?? (() => new Date()))().toISOString(),
    proposalId: o.proposalId,
    stage: 'merged',
    change: { kind: 'pr', ref },
  });
  try {
    appendEvents(o.wikiRoot, [event], { repairTornTail: true });
  } catch (e) {
    if (e instanceof LedgerWriteError) throw new IterationError(e.message, 4);
    throw e;
  }
  writeChangeset(o.wikiRoot, {
    writes: [{ path: SKILL_IMPACT_FILE, content: renderSkillImpact(readLedger(o.wikiRoot)) }],
  });
  return {
    event,
    already: false,
    ...(sets ? { acceptedSkillSetHash: sets.candidateSkillSetHash } : {}),
  };
}
