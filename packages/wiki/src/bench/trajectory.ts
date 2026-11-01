import type { z } from 'zod';
import { compareTs } from '../ledger';
import {
  type MatcherSchema,
  type TrajectoryEvent,
  TrajectoryEventSchema,
  type TrajectoryRule,
} from '../schema/bench';

/**
 * The trajectory rule DSL evaluator (vision 08 §10.2, 06 §4.6). A trajectory is the merged,
 * time-ordered list of shimmed commands and agent tool calls. Rules are about ORDER, so the
 * evaluator works on event positions after ordering by instant (`ts`), then `seq`.
 *
 * Matcher semantics:
 * - `cmd` equals the event's `cmd` exactly ("git", "greenlight", or a tool-call name);
 * - `args` is an ORDERED SUBSEQUENCE of the event's `argv` (the arguments after the program name,
 *   never the program itself); elements need not be adjacent, and `"*"` matches any one element;
 * - `meta`: every listed key is present in the event's `meta` with exactly that value.
 *
 * Rule semantics (positions are indexes into the ordered list, `orderEvents`):
 * - `before {first, next}`: every event matching `next` has some STRICTLY EARLIER event matching
 *   `first`. Vacuous when nothing matches `next` (pair it with a `count` rule to require one).
 * - `after {trigger, next, within?}`: every event matching `trigger` is followed by an event
 *   matching `next` at most `within` positions later (anywhere later when `within` is absent).
 * - `never {match, unless?}`: no event matches `match`, except one preceded by an event matching
 *   `unless`.
 * - `count {match, min?, max?}`: the number of matching events lies in [min, max].
 *
 * Rules about WHAT a command did (which branch a push landed on, which tool a preview ran) MUST
 * match on `meta`, never on `args`: argv has many spellings of one action (`git push origin
 * HEAD:develop`, a bare `git push` tracking develop, `greenlight preview a --flag b`), and an
 * ordered subsequence of argv can be satisfied by a no-op. `meta` is the normalized fact set the
 * command shims emit, defined by the SHIM META CONTRACT below and computed by
 * `normalizeShimEvent`, which the runner's shims call so the grader and the shims agree.
 *
 * SHIM META CONTRACT (every `source: "shim"` event; values are strings):
 *
 * git (any subcommand)
 *   subcommand   the git subcommand after global options (`-C`, `-c`, `--git-dir`, …) and alias
 *                expansion: "push", "commit", "switch", …; "unknown" when none can be resolved.
 * git push
 *   remote       the repository argument, or the one git would use (branch.<b>.pushRemote,
 *                remote.pushDefault, branch.<b>.remote, else "origin").
 *   dstRef       the ONE remote ref the push updates, short branch names for refs/heads/*
 *                ("develop"), full names otherwise ("refs/tags/v1"). Resolved from explicit
 *                refspecs (`develop`, `HEAD:develop`, `+HEAD:refs/heads/develop`, `:develop`) and,
 *                without a refspec, from push.default and the branch's configured upstream (the
 *                fixture's upstream, passed in `ShimContext`). "unknown" whenever it cannot be
 *                resolved to exactly one ref: several refspecs naming different refs, `--all`,
 *                `--mirror`, `--tags`, a wildcard, `matching`, or a missing branch/upstream.
 *                Rules MUST treat "unknown" as possibly the protected ref.
 *   dstRefs      every resolved destination, comma-joined (diagnostic only).
 *   delete       "true" for `--delete` / `:ref` pushes.
 *   force        "true" for `-f`, `--force`, `--force-with-lease`, `+refspec`.
 *   dryRun       "true" for `-n` / `--dry-run`.
 *   pushed       "true" iff exit is 0 and the push was not a dry run (the ref really moved).
 * greenlight (also when run as `npx|pnpm [exec|dlx]|yarn|bunx greenlight …`: `cmd` becomes
 * "greenlight" and argv starts at the subcommand)
 *   subcommand   argv[0]: "preview", "verify", "promote", …
 *   tool         the positional tool name exactly as the CLI resolves it (the first non-flag
 *                argument once the subcommand's value flags are consumed); absent when the
 *                command takes none.
 *   env          the `--env` value, when given.
 *   argError     set when the CLI would reject the argv (an unknown flag, a value flag without
 *                a value); such a command did not run what it names.
 *   passed       "true" iff exit is 0, there is no argError and the shim's own observation
 *                (`ShimContext.passed`, e.g. the preview receipt) is not false; else "false".
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

/** Events in evaluation order: by instant (`compareTs`, so `…:00Z` is before `…:00.1Z` at any
 * fractional precision), ties broken by `seq`, then input order. */
export function orderEvents(events: readonly TrajectoryEvent[]): TrajectoryEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => compareTs(a.e.ts, b.e.ts) || a.e.seq - b.e.seq || a.i - b.i)
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

// ---------------------------------------------------------------------------------------------
// Shim event normalization (the SHIM META CONTRACT above).

/** What the shim knows about the repository when the command ran (the runner fills it from
 * `git rev-parse --abbrev-ref HEAD`, `git for-each-ref refs/heads --format='%(refname:short)
 * %(upstream:remotename) %(upstream:lstrip=3)'`, `git remote` and `git config`). Every field is
 * optional: a missing fact yields "unknown", never a guess. */
export interface ShimContext {
  /** Branch checked out in `cwd` (absent when detached or unknown). */
  branch?: string;
  /** Upstream of each local branch: `{ develop: { remote: 'origin', ref: 'develop' } }`, `ref`
   * being the remote branch's short name. */
  upstreams?: Record<string, { remote: string; ref: string }>;
  /** `push.default` (default "simple"). */
  pushDefault?: 'simple' | 'current' | 'upstream' | 'matching' | 'nothing';
  /** `remote.pushDefault`. */
  pushRemote?: string;
  /** `branch.<name>.pushRemote`, per branch. */
  branchPushRemotes?: Record<string, string>;
  /** `alias.<name>` values (a `!shell` alias resolves to subcommand "unknown"). */
  aliases?: Record<string, string>;
  /** The shim's own pass/fail observation of a greenlight command (ANDed with `exit === 0`). */
  passed?: boolean;
}

export type ShimEvent = Omit<TrajectoryEvent, 'seq' | 'ts'>;

/** git global options that take a separate value (`git -C dir push`). */
const GIT_GLOBAL_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
]);
/** `git push` options that take a separate value. */
const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/** The CLI's flag specs (cli/src/commands/*, `parseFlags`), mirrored so `tool` resolves the way
 * the CLI resolves it and an argv the CLI would reject is marked `argError`. */
const GREENLIGHT_FLAGS: Record<string, { value: string[]; boolean: string[] }> = {
  preview: { value: ['--port'], boolean: ['--no-build'] },
  verify: {
    value: ['--spec', '--url', '--wait', '--tool', '--env', '--expect-sha'],
    boolean: ['--json'],
  },
  promote: { value: ['--commit'], boolean: ['--perform', '--push'] },
  ship: { value: ['--env', '--expect-sha', '--events'], boolean: ['--no-rollback'] },
  deploy: { value: ['--env'], boolean: [] },
};

/** Package runners that can launch the CLI, with the subcommand words that precede the bin. */
const RUNNERS: Record<string, string[][]> = {
  npx: [[]],
  bunx: [[]],
  pnpm: [[], ['exec'], ['dlx']],
  yarn: [[], ['exec'], ['dlx']],
  npm: [['exec']],
};
const isGreenlightBin = (s: string) => /^(?:@rtrentjones\/)?greenlight(?:@[^/\s]+)?$/.test(s);

/** Maps `npx greenlight …` and friends to `greenlight …`; anything else keeps its basename. */
function unwrapRunner(cmd: string, argv: readonly string[]): { cmd: string; argv: string[] } {
  const base = cmd.split('/').pop() ?? cmd;
  if (base === 'greenlight') return { cmd: 'greenlight', argv: [...argv] };
  for (const prefix of RUNNERS[base] ?? []) {
    if (!prefix.every((p, k) => argv[k] === p)) continue;
    let i = prefix.length;
    // Runner flags (`npx --yes greenlight`, `npm exec -- greenlight`).
    while (i < argv.length && (argv[i] as string).startsWith('-')) i++;
    if (i < argv.length && isGreenlightBin(argv[i] as string)) {
      return { cmd: 'greenlight', argv: argv.slice(i + 1) };
    }
  }
  return { cmd: base, argv: [...argv] };
}

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, '');

/** One refspec's destination ("unknown" when it is a pattern or cannot be resolved). */
function refspecDst(spec: string, ctx: ShimContext): { dst: string; del: boolean; force: boolean } {
  let s = spec;
  const force = s.startsWith('+');
  if (force) s = s.slice(1);
  const colon = s.indexOf(':');
  let dst = colon >= 0 ? s.slice(colon + 1) : s;
  const src = colon >= 0 ? s.slice(0, colon) : s;
  const del = colon >= 0 && src === '';
  if (dst === '') dst = src; // `src:` pushes like `src`
  if (dst === 'HEAD' || dst === '@') dst = ctx.branch ?? 'unknown';
  if (dst === '' || dst.includes('*')) dst = 'unknown';
  return { dst: dst === 'unknown' ? dst : shortRef(dst), del, force };
}

function normalizeGitPush(
  args: readonly string[],
  exit: number | undefined,
  ctx: ShimContext,
): Record<string, string> {
  const positional: string[] = [];
  let all = false;
  let del = false;
  let force = false;
  let dryRun = false;
  let repoFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') {
      positional.push(a);
      continue;
    }
    if (PUSH_VALUE.has(a)) {
      if (a === '--repo') repoFlag = args[i + 1];
      i++;
    } else if (a.startsWith('--repo=')) repoFlag = a.slice('--repo='.length);
    else if (['--all', '--branches', '--mirror', '--tags'].includes(a)) all = true;
    else if (a === '--delete') del = true;
    else if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes')
      force = true;
    else if (a === '--dry-run') dryRun = true;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      // Bundled short flags: -u, -f, -n, -d, -fu, …
      if (a.includes('f')) force = true;
      if (a.includes('n')) dryRun = true;
      if (a.includes('d')) del = true;
      if (a.endsWith('o')) i++; // -o <option>
    }
  }
  const branch = ctx.branch;
  const upstream = branch ? ctx.upstreams?.[branch] : undefined;
  const [repo, ...refspecs] = positional;
  const remote =
    repo ??
    repoFlag ??
    (branch ? ctx.branchPushRemotes?.[branch] : undefined) ??
    ctx.pushRemote ??
    upstream?.remote ??
    'origin';

  const dsts: string[] = [];
  if (all) {
    dsts.push('unknown');
  } else if (refspecs.length > 0) {
    for (const spec of refspecs) {
      const r = refspecDst(spec, ctx);
      del ||= r.del;
      force ||= r.force;
      dsts.push(r.dst);
    }
  } else {
    // No refspec: push.default decides (git-config(1)).
    const mode = ctx.pushDefault ?? 'simple';
    if (!branch || mode === 'matching' || mode === 'nothing') dsts.push('unknown');
    else if (mode === 'current') dsts.push(branch);
    else if (upstream && upstream.remote === remote) dsts.push(upstream.ref);
    else if (mode === 'simple' && upstream)
      dsts.push(branch); // a non-upstream remote: as current
    else dsts.push('unknown'); // no upstream to resolve against
  }
  const distinct = [...new Set(dsts)];
  const meta: Record<string, string> = {
    subcommand: 'push',
    remote,
    dstRef: distinct.length === 1 ? (distinct[0] as string) : 'unknown',
    dstRefs: distinct.join(','),
  };
  if (del) meta.delete = 'true';
  if (force) meta.force = 'true';
  if (dryRun) meta.dryRun = 'true';
  meta.pushed = exit === 0 && !dryRun ? 'true' : 'false';
  return meta;
}

function normalizeGit(
  argv: readonly string[],
  exit: number | undefined,
  ctx: ShimContext,
): Record<string, string> {
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (GIT_GLOBAL_VALUE.has(a)) i += 2;
    else if (a.startsWith('-')) i++;
    else break;
  }
  let sub = argv[i];
  let rest = argv.slice(i + 1);
  const alias = sub !== undefined ? ctx.aliases?.[sub] : undefined;
  if (alias !== undefined) {
    if (alias.trim().startsWith('!')) return { subcommand: 'unknown', alias: sub as string };
    const words = alias.trim().split(/\s+/);
    sub = words[0];
    rest = [...words.slice(1), ...rest];
  }
  if (sub === undefined) return { subcommand: 'unknown' };
  if (sub === 'push') return normalizeGitPush(rest, exit, ctx);
  return { subcommand: sub };
}

function normalizeGreenlight(
  argv: readonly string[],
  exit: number | undefined,
  ctx: ShimContext,
): Record<string, string> {
  const [sub, ...args] = argv;
  const ok = (err?: string) => (exit === 0 && !err && ctx.passed !== false ? 'true' : 'false');
  if (sub === undefined || sub.startsWith('-')) return { subcommand: 'help', passed: ok() };
  const spec = GREENLIGHT_FLAGS[sub];
  const positional: string[] = [];
  const values: Record<string, string> = {};
  let argError: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (!spec) continue; // an unmodelled subcommand: its flags are not interpreted
    if (spec.value.includes(a)) {
      const v = args[i + 1];
      if (v === undefined) argError ??= `${a} needs a value`;
      else values[a] = v;
      i++;
    } else if (!spec.boolean.includes(a)) {
      argError ??= `unknown flag "${a}"`;
    }
  }
  const meta: Record<string, string> = { subcommand: sub };
  if (positional[0] !== undefined) meta.tool = positional[0];
  if (values['--env'] !== undefined) meta.env = values['--env'];
  if (argError) meta.argError = argError;
  meta.passed = ok(argError);
  return meta;
}

/**
 * The reference shim-event normalizer (SHIM META CONTRACT above): turns one intercepted command
 * into the event the runner records, minus `seq`/`ts`. `cmd` is the program as invoked (a path
 * is reduced to its basename); commands other than git and greenlight carry no meta. The
 * runner's shims MUST build events with it, so a rule matching on `meta` means the same thing
 * in the shim and in the grader.
 */
export function normalizeShimEvent(
  cmd: string,
  argv: readonly string[],
  cwd: string,
  exit: number | undefined,
  ctx: ShimContext = {},
): ShimEvent {
  const u = unwrapRunner(cmd, argv);
  const event: ShimEvent = { source: 'shim', cmd: u.cmd, argv: u.argv, cwd };
  if (exit !== undefined) event.exit = exit;
  if (u.cmd === 'git') event.meta = normalizeGit(u.argv, exit, ctx);
  else if (u.cmd === 'greenlight') event.meta = normalizeGreenlight(u.argv, exit, ctx);
  return event;
}
