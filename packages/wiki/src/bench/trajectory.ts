import type { z } from 'zod';
import {
  type MatcherSchema,
  type TrajectoryEvent,
  TrajectoryEventSchema,
  type TrajectoryRule,
} from '../schema/bench';

/**
 * The trajectory rule DSL evaluator (vision 08 §10.2, 06 §4.6). A trajectory is the merged,
 * time-ordered list of shimmed commands and agent tool calls. Rules are about ORDER, so the
 * evaluator works on event positions after sorting by `seq`.
 *
 * Matcher semantics:
 * - `cmd` equals the event's `cmd` exactly ("git", "greenlight", or a tool-call name);
 * - `args` is an ORDERED SUBSEQUENCE of the event's `argv` (the arguments after the program name,
 *   never the program itself); elements need not be adjacent, and `"*"` matches any one element;
 * - `meta`: every listed key is present in the event's `meta` with exactly that value.
 *
 * Rule semantics (positions are indexes into the seq-sorted list):
 * - `before {first, next}`: every event matching `next` has some STRICTLY EARLIER event matching
 *   `first`. Vacuous when nothing matches `next` (pair it with a `count` rule to require one).
 * - `after {trigger, next, within?}`: every event matching `trigger` is followed by an event
 *   matching `next` at most `within` positions later (anywhere later when `within` is absent).
 * - `never {match, unless?}`: no event matches `match`, except one preceded by an event matching
 *   `unless`.
 * - `count {match, min?, max?}`: the number of matching events lies in [min, max].
 */

export type Matcher = z.infer<typeof MatcherSchema>;

export interface RuleResult {
  /** Index of the rule in the list it was evaluated from. */
  index: number;
  rule: TrajectoryRule;
  /** Human-readable form, e.g. `before(greenlight preview guestbook {passed=true}, git push origin develop)`. */
  label: string;
  passed: boolean;
  detail: string;
  /** `seq` of the first event that broke the rule, when one did. */
  offendingSeq?: number;
}

/** Ordered subsequence with a single-element `*` wildcard. Greedy earliest matching is complete
 * here: each pattern element matches a single argv element independently of the others. */
export function argsMatch(pattern: readonly string[], argv: readonly string[]): boolean {
  let j = 0;
  for (const p of pattern) {
    while (j < argv.length && p !== '*' && argv[j] !== p) j++;
    if (j >= argv.length) return false;
    j++;
  }
  return true;
}

export function matches(m: Matcher, e: TrajectoryEvent): boolean {
  if (m.cmd !== e.cmd) return false;
  if (m.args && !argsMatch(m.args, e.argv)) return false;
  if (m.meta) {
    for (const [k, v] of Object.entries(m.meta)) {
      if (e.meta?.[k] !== v) return false;
    }
  }
  return true;
}

export function describeMatcher(m: Matcher): string {
  const meta = m.meta
    ? ` {${Object.entries(m.meta)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}}`
    : '';
  return [m.cmd, ...(m.args ?? [])].join(' ') + meta;
}

export function describeRule(r: TrajectoryRule): string {
  switch (r.rule) {
    case 'before':
      return `before(${describeMatcher(r.first)}, ${describeMatcher(r.next)})`;
    case 'after':
      return `after(${describeMatcher(r.trigger)}, ${describeMatcher(r.next)}${
        r.within !== undefined ? `, within ${r.within}` : ''
      })`;
    case 'never':
      return `never(${describeMatcher(r.match)}${r.unless ? `, unless ${describeMatcher(r.unless)}` : ''})`;
    case 'count': {
      const bounds = [
        r.min !== undefined ? `min ${r.min}` : null,
        r.max !== undefined ? `max ${r.max}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `count(${describeMatcher(r.match)}, ${bounds})`;
    }
  }
}

/** Events in evaluation order: by `seq`, ties broken by timestamp, then input order. */
export function orderEvents(events: readonly TrajectoryEvent[]): TrajectoryEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.seq - b.e.seq || a.e.ts.localeCompare(b.e.ts) || a.i - b.i)
    .map(({ e }) => e);
}

const show = (e: TrajectoryEvent) => `seq ${e.seq} (${[e.cmd, ...e.argv].join(' ')})`;

export function evaluateRule(
  rule: TrajectoryRule,
  events: readonly TrajectoryEvent[],
  index = 0,
): RuleResult {
  const ev = orderEvents(events);
  const label = describeRule(rule);
  const pass = (detail: string): RuleResult => ({ index, rule, label, passed: true, detail });
  const fail = (detail: string, e?: TrajectoryEvent): RuleResult => ({
    index,
    rule,
    label,
    passed: false,
    detail,
    ...(e ? { offendingSeq: e.seq } : {}),
  });

  switch (rule.rule) {
    case 'before': {
      let seen = false;
      let n = 0;
      for (const e of ev) {
        if (matches(rule.next, e)) {
          n++;
          if (!seen) {
            return fail(
              `${show(e)} matches "${describeMatcher(rule.next)}" with no earlier "${describeMatcher(rule.first)}"`,
              e,
            );
          }
        }
        if (matches(rule.first, e)) seen = true;
      }
      return pass(
        n === 0
          ? `no event matches "${describeMatcher(rule.next)}" (vacuous)`
          : `all ${n} matching event(s) preceded by "${describeMatcher(rule.first)}"`,
      );
    }
    case 'after': {
      let n = 0;
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i] as TrajectoryEvent;
        if (!matches(rule.trigger, e)) continue;
        n++;
        const end = rule.within === undefined ? ev.length - 1 : i + rule.within;
        let found = false;
        for (let k = i + 1; k <= end && k < ev.length; k++) {
          if (matches(rule.next, ev[k] as TrajectoryEvent)) {
            found = true;
            break;
          }
        }
        if (!found) {
          return fail(
            `${show(e)} is not followed by "${describeMatcher(rule.next)}"${
              rule.within !== undefined ? ` within ${rule.within} event(s)` : ''
            }`,
            e,
          );
        }
      }
      return pass(
        n === 0
          ? `no event matches "${describeMatcher(rule.trigger)}" (vacuous)`
          : `all ${n} trigger(s) followed by "${describeMatcher(rule.next)}"`,
      );
    }
    case 'never': {
      let excused = false;
      for (const e of ev) {
        if (matches(rule.match, e) && !excused) {
          return fail(
            `${show(e)} matches "${describeMatcher(rule.match)}"${
              rule.unless ? ` with no earlier "${describeMatcher(rule.unless)}"` : ''
            }`,
            e,
          );
        }
        if (rule.unless && matches(rule.unless, e)) excused = true;
      }
      return pass(`no unexcused event matches "${describeMatcher(rule.match)}"`);
    }
    case 'count': {
      const n = ev.filter((e) => matches(rule.match, e)).length;
      const lowOk = rule.min === undefined || n >= rule.min;
      const highOk = rule.max === undefined || n <= rule.max;
      const detail = `${n} event(s) match "${describeMatcher(rule.match)}"`;
      return lowOk && highOk ? pass(detail) : fail(`${detail}; ${describeRule(rule)} not met`);
    }
  }
}

export function evaluateRules(
  rules: readonly TrajectoryRule[],
  events: readonly TrajectoryEvent[],
): RuleResult[] {
  return rules.map((r, i) => evaluateRule(r, events, i));
}

/** Parses a `trajectory.jsonl` (one TrajectoryEvent per line; blank lines ignored). Invalid lines
 * are reported, never silently dropped: a grader treats any error as a failed check. */
export function parseTrajectory(text: string): { events: TrajectoryEvent[]; errors: string[] } {
  const events: TrajectoryEvent[] = [];
  const errors: string[] = [];
  const seqs = new Set<number>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      errors.push(`line ${i + 1}: not JSON (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    const r = TrajectoryEventSchema.safeParse(raw);
    if (!r.success) {
      errors.push(`line ${i + 1}: ${r.error.issues.map((x) => x.message).join('; ')}`);
      return;
    }
    if (seqs.has(r.data.seq)) errors.push(`line ${i + 1}: duplicate seq ${r.data.seq}`);
    seqs.add(r.data.seq);
    events.push(r.data);
  });
  return { events, errors };
}
