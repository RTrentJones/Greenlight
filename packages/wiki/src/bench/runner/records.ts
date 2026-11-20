import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerReadError, readLedgerEvents } from '../../ledger';
import {
  type BaselineIdentity,
  type EvaluationRecord,
  EvaluationRecordSchema,
} from '../../schema/bench';
import type { LedgerEvent } from '../../schema/ledger';
import { sameIdentity } from '../identity';
import { PrerequisiteError } from './config';
import { ROLLOUT_KEY } from './types';

// ---------------------------------------------------------------------------------------------
// evaluation records

export function loadEvaluationRecords(wikiRoot: string): EvaluationRecord[] {
  const dir = join(wikiRoot, 'evidence', 'eval');
  if (!existsSync(dir)) return [];
  const out: EvaluationRecord[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { kind?: string };
      if (raw.kind === 'gate-input') continue;
      const r = EvaluationRecordSchema.safeParse(raw);
      if (r.success) out.push(r.data);
    } catch {
      // not a record
    }
  }
  return out;
}

/** A sealed train record with exactly this identity that covers every requested rollout. */
export function findCachedTrain(
  records: readonly EvaluationRecord[],
  identity: BaselineIdentity,
  keys: readonly string[],
): EvaluationRecord | undefined {
  return findCachedRecord(records, identity, keys, 'train');
}

/** A sealed record of `role` with exactly this identity that covers every requested rollout,
 * optionally created within a time window (epoch ms); the newest such record wins. */
export function findCachedRecord(
  records: readonly EvaluationRecord[],
  identity: BaselineIdentity,
  keys: readonly string[],
  role: EvaluationRecord['role'],
  window: { createdAfter?: number; createdBefore?: number } = {},
): EvaluationRecord | undefined {
  const at = (r: EvaluationRecord) => Date.parse(r.createdAt);
  return records
    .filter(
      (r) =>
        r.role === role &&
        sameIdentity(r.identity, identity) &&
        (window.createdAfter === undefined || at(r) >= window.createdAfter) &&
        (window.createdBefore === undefined || at(r) <= window.createdBefore) &&
        keys.every((k) => r.outcomes.some((o) => ROLLOUT_KEY(o.task, o.model, o.run) === k)),
    )
    .sort((a, b) => at(b) - at(a))[0];
}

export function ledgerEvents(wikiRoot: string): LedgerEvent[] {
  try {
    return readLedgerEvents(wikiRoot);
  } catch (e) {
    if (e instanceof LedgerReadError) throw new PrerequisiteError(e.message);
    throw e;
  }
}
