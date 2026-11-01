/** Free-tier throttling for the Greenlight harness (vision 06 §4.8): at $0 the binding constraint is
 * requests per minute and per day, so every outgoing HTTP attempt first passes a per-model
 * `RateLimiter` and the caller's `RequestBudget`. Both refuse with a typed error rather than
 * queueing past a daily or per-gate cap. */

/** Today's rpd count for one model. `day` is the quota day key (see `pacificDay`). */
export interface DailyUsage {
  day: string;
  count: number;
}

/** Optional durable store for the daily count, so separate processes (or CI runs) on the same day
 * see one another's usage. The limiter loads once, lazily, and saves after every acquire. */
export interface RateLimitPersistence {
  load(modelId: string): Promise<DailyUsage | null> | DailyUsage | null;
  save(modelId: string, usage: DailyUsage): Promise<void> | void;
}

export class RateLimitExhaustedError extends Error {
  override readonly name = 'RateLimitExhaustedError';
  constructor(
    readonly modelId: string,
    readonly day: string,
    readonly rpd: number,
  ) {
    super(`daily request limit reached for ${modelId}: ${rpd}/${rpd} used on ${day}`);
  }
}

export class BudgetExhaustedError extends Error {
  override readonly name = 'BudgetExhaustedError';
  constructor(readonly max: number) {
    super(`request budget exhausted: ${max}/${max} requests used`);
  }
}

/** Gemini's daily quotas reset at midnight Pacific time, so the day key is the Pacific date. */
export function pacificDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export interface RateLimiterOptions {
  modelId: string;
  rpm: number;
  rpd: number;
  persistence?: RateLimitPersistence;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  dayOf?: (now: Date) => string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sliding-window rpm throttle plus a hard daily rpd cap for one model. */
export class RateLimiter {
  readonly modelId: string;
  readonly rpm: number;
  readonly rpd: number;
  private readonly persistence?: RateLimitPersistence;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly dayOf: (now: Date) => string;
  private window: number[] = [];
  private usage: DailyUsage | null = null;
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: RateLimiterOptions) {
    this.modelId = o.modelId;
    this.rpm = o.rpm;
    this.rpd = o.rpd;
    this.persistence = o.persistence;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.dayOf = o.dayOf ?? pacificDay;
  }

  private async today(): Promise<DailyUsage> {
    if (!this.loaded) {
      this.loaded = true;
      this.usage = (await this.persistence?.load(this.modelId)) ?? null;
    }
    const day = this.dayOf(new Date(this.now()));
    if (!this.usage || this.usage.day !== day) this.usage = { day, count: 0 };
    return this.usage;
  }

  /** Requests left today (after loading any persisted count). */
  async remainingToday(): Promise<number> {
    const u = await this.today();
    return Math.max(0, this.rpd - u.count);
  }

  /** Waits for an rpm slot and counts one request against today's rpd, or throws
   * `RateLimitExhaustedError` when the day is used up. Calls are serialized so concurrent callers
   * cannot both take the last slot. */
  acquire(): Promise<void> {
    const run = this.chain.then(() => this.acquireNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async acquireNow(): Promise<void> {
    const u = await this.today();
    if (u.count >= this.rpd) throw new RateLimitExhaustedError(this.modelId, u.day, this.rpd);
    for (;;) {
      const t = this.now();
      this.window = this.window.filter((s) => t - s < 60_000);
      if (this.window.length < this.rpm) break;
      const oldest = this.window[0] as number;
      await this.sleep(60_000 - (t - oldest) + 1);
    }
    this.window.push(this.now());
    u.count += 1;
    await this.persistence?.save(this.modelId, { ...u });
  }
}

/** A total cap on HTTP requests (every attempt, retries included) shared by every call it is
 * passed to: one budget per gate gives `perGateMaxRequests` (08 §10.5). */
export class RequestBudget {
  private used_ = 0;
  constructor(readonly max: number) {}
  get used(): number {
    return this.used_;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used_);
  }
  /** Counts one request, or throws `BudgetExhaustedError` without counting. */
  take(): void {
    if (this.used_ >= this.max) throw new BudgetExhaustedError(this.max);
    this.used_ += 1;
  }
}
