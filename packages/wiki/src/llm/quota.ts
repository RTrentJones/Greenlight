import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LedgerEvent } from '../schema/ledger';
import { type DailyUsage, type RateLimitPersistence, pacificDay } from './limits';

/**
 * A durable free-tier quota count (vision 06 §4.8): without it every process starts the day at
 * zero, so two `bench run`s on one day could each spend the full `rpd`. Counts live in
 * `.greenlight/quota/<model>.json` (gitignored) under the working root, one file per model.
 *
 * Writes go to a temp file and are renamed into place, so a reader never sees a torn file; the
 * read-check-increment in `take` runs under an exclusive lock file (`<file>.lock`, created with
 * O_EXCL), so concurrent processes on one machine cannot both take the last request. A lock older
 * than `staleLockMs` is presumed abandoned by a crashed process and removed.
 */

export const QUOTA_DIR = join('.greenlight', 'quota');

/** A model id as a safe file name (`models/gemini-3.8-flash` → `models_gemini-3.8-flash`). */
export const quotaFileName = (modelId: string): string =>
  `${modelId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

export interface FileQuotaStoreOptions {
  /** Directory that holds `.greenlight/` (the repo root). */
  root: string;
  staleLockMs?: number;
  lockTimeoutMs?: number;
  now?: () => number;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isUsage(v: unknown): v is DailyUsage {
  const u = v as DailyUsage;
  return (
    typeof u === 'object' &&
    u !== null &&
    typeof u.day === 'string' &&
    Number.isInteger(u.count) &&
    u.count >= 0
  );
}

export class FileQuotaStore implements RateLimitPersistence {
  readonly dir: string;
  private readonly staleLockMs: number;
  private readonly lockTimeoutMs: number;
  private readonly now: () => number;

  constructor(o: FileQuotaStoreOptions) {
    this.dir = join(o.root, QUOTA_DIR);
    this.staleLockMs = o.staleLockMs ?? 10_000;
    this.lockTimeoutMs = o.lockTimeoutMs ?? 5_000;
    this.now = o.now ?? Date.now;
  }

  path(modelId: string): string {
    return join(this.dir, quotaFileName(modelId));
  }

  load(modelId: string): DailyUsage | null {
    let raw: string;
    try {
      raw = readFileSync(this.path(modelId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${this.path(modelId)} is not valid JSON; fix or delete it`);
    }
    if (!isUsage(parsed)) throw new Error(`${this.path(modelId)} is not a { day, count } record`);
    return { day: parsed.day, count: parsed.count };
  }

  save(modelId: string, usage: DailyUsage): void {
    this.withLock(modelId, () => this.write(modelId, usage));
  }

  take(modelId: string, day: string, rpd: number): DailyUsage | null {
    return this.withLock(modelId, () => {
      const cur = this.load(modelId);
      const count = cur && cur.day === day ? cur.count : 0;
      if (count >= rpd) return null;
      const next = { day, count: count + 1 };
      this.write(modelId, next);
      return next;
    });
  }

  /** Raises today's count to at least `count` (never lowers it): used to seed from the ledger. */
  raise(modelId: string, day: string, count: number): DailyUsage {
    return this.withLock(modelId, () => {
      const cur = this.load(modelId);
      const have = cur && cur.day === day ? cur.count : 0;
      const next = { day, count: Math.max(have, count) };
      this.write(modelId, next);
      return next;
    });
  }

  private write(modelId: string, usage: DailyUsage): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.path(modelId);
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ day: usage.day, count: usage.count })}\n`);
    renameSync(tmp, target);
  }

  private withLock<T>(modelId: string, fn: () => T): T {
    mkdirSync(this.dir, { recursive: true });
    const lock = `${this.path(modelId)}.lock`;
    const deadline = this.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (this.now() - statSync(lock).mtimeMs > this.staleLockMs) {
            rmSync(lock, { force: true });
            continue;
          }
        } catch {
          continue; // the holder released it between our open and stat
        }
        if (this.now() > deadline) throw new Error(`timed out waiting for the quota lock ${lock}`);
        pause(20);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

/**
 * Today's request count from the ledger's `spend` events (06 §4.8: they record requests with
 * `usd: 0`), for seeding a fresh quota store — e.g. on a CI runner that has the ledger but no
 * `.greenlight/` from earlier runs that day.
 *
 * A `spend` event does not name the model it was spent on, so by default every request counts
 * against every model: a conservative upper bound that can only make the limiter stop early,
 * never overspend. Pass `modelOf` when the caller can attribute an event (for example through its
 * `evaluationId`); returning `undefined` from it falls back to "every model".
 */
export function usageFromLedger(
  events: readonly LedgerEvent[],
  modelIds: readonly string[],
  opts: {
    day?: string;
    now?: Date;
    dayOf?: (d: Date) => string;
    modelOf?: (e: LedgerEvent) => string | undefined;
  } = {},
): Map<string, DailyUsage> {
  const dayOf = opts.dayOf ?? pacificDay;
  const day = opts.day ?? dayOf(opts.now ?? new Date());
  const out = new Map(modelIds.map((id) => [id, { day, count: 0 }]));
  for (const e of events) {
    if (e.stage !== 'spend' || !e.spend || dayOf(new Date(e.ts)) !== day) continue;
    const m = opts.modelOf?.(e);
    const targets = m !== undefined && out.has(m) ? [m] : m === undefined ? modelIds : [];
    for (const id of targets) (out.get(id) as DailyUsage).count += e.spend.requests;
  }
  return out;
}

/** Seeds `store` with today's ledger spend (never lowering a count already recorded). */
export function seedQuotaFromLedger(
  store: FileQuotaStore,
  events: readonly LedgerEvent[],
  modelIds: readonly string[],
  opts: Parameters<typeof usageFromLedger>[2] = {},
): Map<string, DailyUsage> {
  const seeded = new Map<string, DailyUsage>();
  for (const [id, u] of usageFromLedger(events, modelIds, opts)) {
    seeded.set(id, store.raise(id, u.day, u.count));
  }
  return seeded;
}
