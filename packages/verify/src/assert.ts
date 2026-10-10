import type { JsonAssert, TextAssert, ValueAssert } from './types';

/** Resolve a dot/bracket path (`checks.database`, `items[0].id`, `$` or `''` for the root) against a
 * parsed JSON value. Returns `undefined` for any missing hop, so `exists: false` can assert absence. */
export function getPath(root: unknown, path: string): unknown {
  if (path === '' || path === '$') return root;
  const tokens = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((t) => t !== '');
  let cur: unknown = root;
  for (const t of tokens) {
    // Own properties only: a response without `constructor` must not "have" Object.prototype's.
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, t)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

/** The window a numeric epoch must land in to count as a timestamp (1990-01-01 .. 2200-01-01).
 * In ms it is [6.3e11, 7.3e12) and in seconds [6.3e8, 7.3e9) — disjoint ranges, so a number has
 * at most one plausible reading. Anything else (1972 in ms, which no cutoff can tell from 3968 in
 * seconds, or 1e100) is rejected as ambiguous/out of range rather than guessed — a guess on the
 * wrong side reads stale data as fresh. ISO strings carry no ambiguity and are always accepted. */
const EPOCH_MIN_MS = Date.UTC(1990, 0, 1);
const EPOCH_MAX_MS = Date.UTC(2200, 0, 1);
const inWindow = (ms: number) => ms >= EPOCH_MIN_MS && ms < EPOCH_MAX_MS;
/** Clock skew tolerated before a freshness timestamp counts as "in the future". */
const FRESHNESS_SKEW_MS = 5 * 60_000;

/** A timestamp as epoch ms: an ISO/RFC date string, or a number in seconds or ms (see above). */
function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (inWindow(v)) return v; // milliseconds
    if (inWindow(v * 1000)) return v * 1000; // seconds
    return undefined;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Format a value for a failure message. Never throws (BigInt, cycles), so a report is always built. */
export function show(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Evaluate one value against its assertions; returns the failure reasons (empty = pass). `label`
 * names the value in messages (the JSON path or the regex). `now` is injectable for tests. */
export function evalValue(
  label: string,
  value: unknown,
  a: ValueAssert,
  now = Date.now(),
): string[] {
  const reasons: string[] = [];
  const present = value !== undefined;
  // Presence is implied by every assertion other than `exists: false`, so a missing value fails
  // with one clear reason instead of a cascade of confusing comparisons against `undefined`.
  if (a.exists === false) {
    // Absence can't be combined with a value assertion (validateSpec rejects it); fail loudly
    // here too rather than silently dropping the other constraints.
    const others = Object.keys(a).filter((k) => k !== 'exists');
    if (others.length) return [`${label}: exists:false contradicts ${others.join(', ')}`];
    if (present) reasons.push(`${label} should be absent, got ${show(value)}`);
    return reasons;
  }
  if (!present) return [`${label} missing`];

  if ('equals' in a && value !== a.equals) {
    reasons.push(`${label} = ${show(value)}, expected ${show(a.equals)}`);
  }
  if (a.matches !== undefined && !new RegExp(a.matches).test(String(value))) {
    reasons.push(`${label} = ${show(value)} does not match /${a.matches}/`);
  }
  if (a.gte !== undefined || a.lte !== undefined) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) reasons.push(`${label} = ${show(value)} is not a number`);
    else {
      if (a.gte !== undefined && n < a.gte) reasons.push(`${label} = ${n} < ${a.gte}`);
      if (a.lte !== undefined && n > a.lte) reasons.push(`${label} = ${n} > ${a.lte}`);
    }
  }
  if (a.maxAgeHours !== undefined || a.minFutureDays !== undefined) {
    const t = toEpochMs(value);
    if (t === undefined) reasons.push(`${label} = ${show(value)} is not a timestamp`);
    else {
      if (a.maxAgeHours !== undefined) {
        const ageH = (now - t) / 3_600_000;
        if (ageH > a.maxAgeHours) {
          reasons.push(
            `${label} is ${ageH.toFixed(1)}h old (${new Date(t).toISOString()}), max ${a.maxAgeHours}h — stale`,
          );
        } else if (t - now > FRESHNESS_SKEW_MS) {
          // A "last ran" time in the future is a clock or unit error, never evidence of freshness.
          reasons.push(
            `${label} is in the future (${new Date(t).toISOString()}) — not a valid freshness timestamp`,
          );
        }
      }
      if (a.minFutureDays !== undefined) {
        const leftD = (t - now) / 86_400_000;
        if (leftD < a.minFutureDays) {
          reasons.push(
            `${label} is ${leftD.toFixed(1)}d away (${new Date(t).toISOString()}), need ≥ ${a.minFutureDays}d`,
          );
        }
      }
    }
  }
  return reasons;
}

/** JSON assertions over a response body. A body that isn't JSON fails every assertion once. */
export function evalJson(body: string, asserts: JsonAssert[], now = Date.now()): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [`body is not JSON (${asserts.length} json assertion(s) unchecked)`];
  }
  return asserts.flatMap(({ path, ...a }) =>
    evalValue(path === '' ? '$' : path, getPath(parsed, path), a, now),
  );
}

/** Text assertions: each regex runs against the body, and its first capture group (or the whole
 * match when the regex has NO groups) is the value asserted. No match — or a match where an
 * optional first group did not participate — ⇒ the value is missing. */
export function evalText(body: string, asserts: TextAssert[], now = Date.now()): string[] {
  return asserts.flatMap(({ regex, flags, ...a }) => {
    const m = new RegExp(regex, flags).exec(body);
    const value = m ? (m.length > 1 ? m[1] : m[0]) : undefined;
    return evalValue(`/${regex}/`, value, a, now);
  });
}
