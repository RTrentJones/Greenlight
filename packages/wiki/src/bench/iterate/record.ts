import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGateInput } from '../../bundle';
import { appendLogEntry } from '../../index-gen';
import { appendEvent, renderSkillImpact } from '../../ledger';
import { LOG_FILE, SKILL_IMPACT_FILE, loadWiki } from '../../load';
import { writeChangeset } from '../../patch';
import {
  type GateInputRecord,
  GateInputRecordSchema,
  type LedgerEvent,
  evalEvidencePath,
} from '../../schema';
import { type Ctx, type StepOutcome, ledgerEvents } from './context';
import { IterationError } from './types';

// ---- step 7: record ---------------------------------------------------------------------------

function recordEvent(c: Ctx, e: LedgerEvent, gateInput: GateInputRecord | undefined): boolean {
  const o = c.o;
  if (gateInput) {
    GateInputRecordSchema.parse(gateInput);
    const f = join(o.wikiRoot, evalEvidencePath(gateInput.hash));
    if (!existsSync(f)) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, `${JSON.stringify(gateInput, null, 2)}\n`);
    }
    if (!readGateInput(o.wikiRoot, gateInput.hash))
      throw new IterationError(`gate input ${gateInput.hash} does not read back`, 1);
  }
  if (ledgerEvents(o.wikiRoot).some((x) => x.eventId === e.eventId)) return false;
  appendEvent(o.wikiRoot, e);
  return true;
}

export function stepRecord(c: Ctx): StepOutcome {
  const o = c.o;
  const pairs: [LedgerEvent, GateInputRecord | undefined][] = [];
  const ev = c.s.evaluate;
  if (ev.event) pairs.push([ev.event, ev.candidate?.gateInput]);
  for (const item of c.s.control.items) if (item.event) pairs.push([item.event, item.gateInput]);
  const written: string[] = [];
  for (const [e, gi] of pairs) if (recordEvent(c, e, gi)) written.push(e.eventId);
  const events = ledgerEvents(o.wikiRoot);
  const wiki = loadWiki(o.wikiRoot);
  let log = wiki.log;
  // Every event of this iteration that is in the ledger gets its log line once: one appended by
  // an earlier, interrupted invocation (crash between the append and this write) is repaired.
  for (const [e] of pairs) {
    if (!events.some((x) => x.eventId === e.eventId)) continue;
    if ((log ?? '').includes(`ledger event ${e.eventId}`)) continue;
    // No reason text: log.md is copied verbatim into agent bundles, and gate reasons name val
    // tasks (06 §1.4). The ledger holds the reason; bundles get only its projection.
    log = appendLogEntry(log, {
      ts: c.now().toISOString(),
      actor: 'harness',
      operation: `${e.control ? 'control ' : ''}${e.stage} ${e.proposalId}`,
      body: `bench iterate ${c.s.iterationId}: ${e.stage}${e.outlet ? ` (${e.outlet}${e.skill ? `, ${e.skill}` : ''})` : ''}; ledger event ${e.eventId}`,
    });
  }
  writeChangeset(o.wikiRoot, {
    writes: [
      { path: SKILL_IMPACT_FILE, content: renderSkillImpact(events) },
      ...(log !== wiki.log ? [{ path: LOG_FILE, content: log as string }] : []),
    ],
  });
  c.s.record.eventIds = pairs.map(([e]) => e.eventId);
  c.s.record.status = 'done';
  c.s.record.message = `${pairs.length} event(s) in the ledger (${written.length} appended now)`;
  c.save();
  return { ok: true };
}
