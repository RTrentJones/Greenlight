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
 * - `meta`: every listed key is present in the event's `meta` with exactly that value, AND the
 *   event is `source: "shim"` (meta is a shim product; a transcript event never matches a meta
 *   matcher, whatever it carries).
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
 * git (any subcommand). The EFFECTIVE config is built the way git layers it: the repository's
 * file config (`ShimContext` typed fields, then `config`), then `GIT_CONFIG_COUNT`/`KEY_n`/
 * `VALUE_n`, then `GIT_CONFIG_PARAMETERS` (both from `ShimContext.env`), then each `-c k=v` /
 * `--config-env k=VAR` in argv order. Aliases, push.default, upstreams and remote.<r>.push are
 * all read from it. A relocated repository or config file (`-C` elsewhere, `--git-dir`,
 * `GIT_DIR`, `GIT_CONFIG_GLOBAL`, an `include.path`, …) makes every key it could set unknown.
 *   subcommand   the git BUILTIN that runs, after global options and transitive alias expansion
 *                (builtins are never shadowed by aliases; depth limit 10; a cycle, a `!shell`
 *                alias, an alias that changes the environment, a non-builtin with no alias, an
 *                option git rejects, and the ref-updating plumbing `send-pack`/`http-push`/
 *                `submodule foreach` are all "unknown"). Also "unknown" for ANY git command that
 *                is not `push` but moved a remote ref (`ShimContext.remoteMoved`/`movedRefs`: a
 *                hook, a shell alias), with `invoked` naming what it ran and `pushed: "true"`.
 *                Rules MUST treat subcommand "unknown" as a possible push to the protected ref.
 *   alias        the alias name, when the subcommand came through one that did not resolve.
 * git push
 *   remote       the repository argument, or the one git would use (branch.<b>.pushRemote,
 *                remote.pushDefault, branch.<b>.remote, else "origin"; "unknown" when the
 *                config that would decide it is unseen).
 *   dstRef       the ONE remote ref the push updates, short branch names for refs/heads/*
 *                ("develop"), full names otherwise ("refs/tags/v1"). Resolved from explicit
 *                refspecs (`develop`, `HEAD:develop`, `+HEAD:refs/heads/develop`, `:develop`) and,
 *                without a refspec, from push.default and the branch's configured upstream (the
 *                fixture's upstream, passed in `ShimContext`), from the effective push.default
 *                (`-c push.default=current` on `feat/x` resolves to `feat/x`), or from
 *                configured `remote.<r>.push` refspecs. "unknown" whenever it cannot be
 *                resolved to exactly one ref: several refspecs naming different refs, `--all`,
 *                `--mirror`, `--tags`, `--prune`, a namespace, a wildcard, `matching`, or a
 *                missing branch/upstream/config. When the runner passes `movedRefs`, the refs
 *                that really moved decide it instead. Rules MUST treat "unknown" as possibly the
 *                protected ref.
 *   dstRefs      every resolved destination, comma-joined (diagnostic only).
 *   delete       "true" for `--delete` / `:ref` pushes.
 *   force        "true" for `-f`, `--force`, `--force-with-lease`, `+refspec`.
 *   dryRun       "true" for `-n` / `--dry-run`.
 *   pushed       "true" iff a remote ref really moved. With `ShimContext.remoteMoved` /
 *                `movedRefs` (the runner's before/after comparison) that is the answer, so an
 *                exit-0 push of an already-up-to-date ref is NOT pushed; without them it falls
 *                back to "exit 0 and not a dry run".
 * greenlight (also when run as `npx|bunx greenlight …`, `npx --package @rtrentjones/greenlight
 * greenlight …`, `pnpm [--filter x|-r|-C dir] [exec|dlx|run] greenlight …`, `yarn [exec|dlx|run]`,
 * `npm exec|x|run greenlight [--] …`: `cmd` becomes "greenlight" and argv starts at the
 * subcommand; a `-c '<shell>'` runner string is not unwrapped)
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
    // meta is produced only by the command shims (the contract below): a transcript event that
    // carries meta-shaped keys (an agent tool call named "git", say) never satisfies a meta
    // matcher.
    if (e.source !== 'shim') return false;
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
 * %(upstream:remotename) %(upstream:lstrip=3)'`, `git remote` and `git config --list`, read in the
 * command's cwd BEFORE it ran, plus a remote-ref comparison AFTER it ran). Every field is
 * optional: a missing fact yields "unknown", never a guess. Fields are only ever added. */
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
  /** The repository's file config (`git config --list`: key → value, or every value of a
   * multi-valued key in order). Overlaid on the typed fields above; command-scope config from
   * `env` and argv is overlaid on it, exactly as git layers them. */
  config?: Record<string, string | string[]>;
  /** The command's environment entries that DIFFER from the environment the facts above were
   * read under (the runner passes the difference). `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/
   * `GIT_CONFIG_VALUE_<n>` and `GIT_CONFIG_PARAMETERS` add command-scope config;
   * `--config-env` reads its values from here; a variable that relocates the repository or its
   * config files (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CONFIG_GLOBAL`,
   * `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG`, `HOME`, `XDG_CONFIG_HOME`,
   * `GIT_NAMESPACE`) makes the facts it invalidates unknown. */
  env?: Record<string, string>;
  /** Ground truth from the runner's before/after comparison of the remote's refs: did ANY remote
   * ref move while the command ran. When present it decides `pushed`. */
  remoteMoved?: boolean;
  /** Ground truth, finer: the remote refs that moved (short names for refs/heads/*). Implies
   * `remoteMoved = movedRefs.length > 0`, and when non-empty it decides `dstRef`. */
  movedRefs?: string[];
  /** The shim's own pass/fail observation of a greenlight command (ANDed with `exit === 0`). */
  passed?: boolean;
}

export type ShimEvent = Omit<TrajectoryEvent, 'seq' | 'ts'>;

/** The commands git runs as builtins (`git --list-cmds=builtins`, git 2.4x): an alias can never
 * shadow one of these. */
const GIT_BUILTINS = new Set(
  `add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr
  check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean
  clone column commit commit-graph commit-tree config count-objects credential credential-cache
  credential-store describe diagnose diff diff-files diff-index diff-tree difftool fast-export
  fast-import fetch fetch-pack fmt-merge-msg for-each-ref for-each-repo format-patch fsck
  fsck-objects gc get-tar-commit-id grep hash-object help hook index-pack init init-db
  interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge
  merge-base merge-file merge-index merge-ours merge-recursive merge-subtree merge-tree mktag
  mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id
  pickaxe prune prune-packed pull push range-diff read-tree rebase receive-pack reflog remote
  repack replace rerere reset restore rev-list rev-parse revert rm send-pack shortlog show
  show-branch show-index show-ref sparse-checkout stage stash status stripspace switch
  symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info
  upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged
  worktree write-tree submodule`.split(/\s+/),
);
/** Commands that update a remote without being `git push`: always subcommand "unknown". */
const GIT_PUSHERS = new Set(['send-pack', 'http-push']);
/** git global options that take a value, separate (`-C dir`) or attached (`--git-dir=x`). */
const GIT_GLOBAL_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
  '--attr-source',
]);
/** git global boolean options that change nothing this contract models. */
const GIT_GLOBAL_FLAGS = new Set([
  '-p',
  '--paginate',
  '-P',
  '--no-pager',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
]);
/** git global options that print something and exit without running a command. */
const GIT_INFO: Record<string, string> = {
  '--version': 'version',
  '-v': 'version',
  '--help': 'help',
  '-h': 'help',
  '--html-path': 'help',
  '--man-path': 'help',
  '--info-path': 'help',
  '--exec-path': 'help',
};
/** Environment variables that relocate the repository / its config files. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
const CONFIG_FILE_ENV = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG',
  'HOME',
  'XDG_CONFIG_HOME',
];
const ALIAS_DEPTH = 10;
/** `git push` options that take a separate value. */
const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, '');

/** A config key in git's canonical form: section and variable lowercased, subsection kept. */
function configKey(raw: string): string | undefined {
  const first = raw.indexOf('.');
  const last = raw.lastIndexOf('.');
  if (first <= 0 || last === raw.length - 1) return undefined;
  const section = raw.slice(0, first).toLowerCase();
  const variable = raw.slice(last + 1).toLowerCase();
  return first === last
    ? `${section}.${variable}`
    : `${section}.${raw.slice(first + 1, last)}.${variable}`;
}

/** The effective git config: ordered values per key, plus whether keys absent here might still
 * be set somewhere this view cannot see (a relocated or included config file). */
class GitConfig {
  private readonly values = new Map<string, string[]>();
  /** Absent keys may be set in a config file the shim could not read. */
  filesUnknown = false;
  set(raw: string, value: string): void {
    const k = configKey(raw);
    if (!k) return;
    if (k === 'include.path' || k.startsWith('includeif.')) this.filesUnknown = true;
    const list = this.values.get(k) ?? [];
    list.push(value);
    this.values.set(k, list);
  }
  /** `-c key=value` / `-c key` (boolean true). */
  setAssignment(s: string): void {
    const eq = s.indexOf('=');
    if (eq < 0) this.set(s, 'true');
    else this.set(s.slice(0, eq), s.slice(eq + 1));
  }
  get(raw: string): string | undefined {
    const k = configKey(raw);
    return k ? this.values.get(k)?.at(-1) : undefined;
  }
  getAll(raw: string): string[] {
    const k = configKey(raw);
    return (k && this.values.get(k)) || [];
  }
  /** True when the key is absent here AND might be set in a file this view cannot see. */
  unsure(raw: string): boolean {
    return this.filesUnknown && this.get(raw) === undefined;
  }
}

/** git's `split_cmdline`: whitespace-separated words with '…' / "…" quoting and \ escapes.
 * Returns undefined on an unclosed quote (git refuses such an alias). */
export function splitCmdline(s: string): string[] | undefined {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = '';
      has = false;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) return undefined;
  if (has) words.push(cur);
  return words;
}

/** `GIT_CONFIG_PARAMETERS`: `'key'='value' 'key2'='value2'` (or the older `'key=value'`). */
function parseConfigParameters(s: string, cfg: GitConfig): void {
  const re = /'((?:[^']|'\\'')*)'(?:=(?:'((?:[^']|'\\'')*)')?)?/g;
  const unq = (x: string) => x.replace(/'\\''/g, "'");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const k = unq(m[1] as string);
    if (m[2] !== undefined) cfg.set(k, unq(m[2]));
    else if (/=/.test(m[0]) && m[0].endsWith('=')) cfg.set(k, '');
    else cfg.setAssignment(k);
  }
}

/** Normalizes `dir` against `cwd` (POSIX), for `-C` handling. */
function resolvePosix(cwd: string, dir: string): string {
  const parts = (dir.startsWith('/') ? dir : `${cwd}/${dir}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return `/${out.join('/')}`;
}

interface GitView {
  cfg: GitConfig;
  /** The checked-out branch, when the command runs in the repository the facts describe. */
  branch: string | undefined;
  /** The command runs in some other repository (`-C elsewhere`, `--git-dir`, `GIT_DIR`, …). */
  elsewhere: boolean;
  /** `--namespace` / `GIT_NAMESPACE`: every remote ref is rewritten. */
  namespaced: boolean;
  /** The runner's ground truth (`ShimContext.remoteMoved` / `movedRefs`). */
  moved: boolean | undefined;
  movedRefs: string[];
}

/** The repository facts as git's own config layers: file config (typed fields, then
 * `ctx.config`), then GIT_CONFIG_COUNT, then GIT_CONFIG_PARAMETERS. `-c` / `--config-env` are
 * layered on by the caller in argv order. */
function baseView(ctx: ShimContext): GitView {
  const cfg = new GitConfig();
  const env = ctx.env ?? {};
  const elsewhere = REPO_ENV.some((k) => k in env);
  if (!elsewhere) {
    if (ctx.pushDefault) cfg.set('push.default', ctx.pushDefault);
    if (ctx.pushRemote) cfg.set('remote.pushDefault', ctx.pushRemote);
    for (const [b, r] of Object.entries(ctx.branchPushRemotes ?? {}))
      cfg.set(`branch.${b}.pushRemote`, r);
    for (const [n, v] of Object.entries(ctx.aliases ?? {})) cfg.set(`alias.${n}`, v);
    for (const [b, u] of Object.entries(ctx.upstreams ?? {})) {
      cfg.set(`branch.${b}.remote`, u.remote);
      cfg.set(`branch.${b}.merge`, u.ref.startsWith('refs/') ? u.ref : `refs/heads/${u.ref}`);
    }
    for (const [k, v] of Object.entries(ctx.config ?? {})) {
      for (const x of Array.isArray(v) ? v : [v]) cfg.set(k, x);
    }
  }
  if (elsewhere || CONFIG_FILE_ENV.some((k) => k in env)) cfg.filesUnknown = true;
  const count = Number(env.GIT_CONFIG_COUNT);
  if (Number.isInteger(count) && count > 0) {
    for (let n = 0; n < count; n++) {
      const k = env[`GIT_CONFIG_KEY_${n}`];
      const v = env[`GIT_CONFIG_VALUE_${n}`];
      if (k !== undefined && v !== undefined) cfg.set(k, v);
    }
  }
  if (env.GIT_CONFIG_PARAMETERS) parseConfigParameters(env.GIT_CONFIG_PARAMETERS, cfg);
  return {
    cfg,
    branch: elsewhere ? undefined : ctx.branch,
    elsewhere,
    namespaced: 'GIT_NAMESPACE' in env,
    moved: ctx.movedRefs ? ctx.movedRefs.length > 0 : ctx.remoteMoved,
    movedRefs: [...new Set((ctx.movedRefs ?? []).map(shortRef))],
  };
}

/** The branch's upstream from the effective config (`branch.<b>.remote` + `branch.<b>.merge`). */
function upstreamOf(view: GitView): { remote: string; ref: string } | undefined | 'unsure' {
  const b = view.branch;
  if (!b) return undefined;
  const remote = view.cfg.get(`branch.${b}.remote`);
  const merge = view.cfg.get(`branch.${b}.merge`);
  if (remote !== undefined && merge !== undefined) return { remote, ref: shortRef(merge) };
  if (view.cfg.unsure(`branch.${b}.remote`) || view.cfg.unsure(`branch.${b}.merge`))
    return 'unsure';
  return undefined;
}

/** One refspec's destination ("unknown" when it is a pattern or cannot be resolved). */
function refspecDst(
  spec: string,
  view: GitView,
  configuredPush: boolean,
): { dst: string; del: boolean; force: boolean } {
  let s = spec;
  const force = s.startsWith('+');
  if (force) s = s.slice(1);
  const colon = s.indexOf(':');
  let dst = colon >= 0 ? s.slice(colon + 1) : s;
  const src = colon >= 0 ? s.slice(0, colon) : s;
  const del = colon >= 0 && src === '';
  // A refspec without `:dst` follows a configured remote.<r>.push mapping when there is one.
  if (colon < 0 && configuredPush) return { dst: 'unknown', del, force };
  if (dst === '') dst = src; // `src:` pushes like `src`
  if (dst === 'HEAD' || dst === '@') dst = view.branch ?? 'unknown';
  if (dst === '' || dst.includes('*')) dst = 'unknown';
  return { dst: dst === 'unknown' ? dst : shortRef(dst), del, force };
}

function normalizeGitPush(
  args: readonly string[],
  exit: number | undefined,
  view: GitView,
): Record<string, string> {
  const { cfg, branch } = view;
  const positional: string[] = [];
  let all = false;
  let del = false;
  let force = false;
  let dryRun = false;
  let prune = false;
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
    else if (a === '--prune') prune = true;
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
  const upstream = upstreamOf(view);
  const up = upstream === 'unsure' ? undefined : upstream;
  const [repo, ...refspecs] = positional;
  const configuredRemote =
    (branch ? cfg.get(`branch.${branch}.pushRemote`) : undefined) ??
    cfg.get('remote.pushDefault') ??
    up?.remote;
  const remote =
    repo ??
    repoFlag ??
    configuredRemote ??
    (cfg.filesUnknown || upstream === 'unsure' ? 'unknown' : 'origin');
  const configuredPush = cfg.getAll(`remote.${remote}.push`);
  const pushUnsure = cfg.unsure(`remote.${remote}.push`);

  const dsts: string[] = [];
  if (all || prune || view.namespaced || cfg.get(`remote.${remote}.mirror`) === 'true') {
    dsts.push('unknown');
  }
  if (refspecs.length > 0) {
    for (const spec of refspecs) {
      const r = refspecDst(spec, view, configuredPush.length > 0 || pushUnsure);
      del ||= r.del;
      force ||= r.force;
      dsts.push(r.dst);
    }
  } else if (!all) {
    if (configuredPush.length > 0) {
      // remote.<r>.push refspecs replace push.default for a bare push.
      for (const spec of configuredPush) dsts.push(refspecDst(spec, view, false).dst);
    } else if (pushUnsure || cfg.unsure('push.default')) {
      dsts.push('unknown');
    } else {
      // No refspec: push.default decides (git-config(1)).
      const mode = cfg.get('push.default') ?? 'simple';
      const auto = cfg.get('push.autoSetupRemote') === 'true';
      if (!branch || upstream === 'unsure') dsts.push('unknown');
      else if (mode === 'current') dsts.push(branch);
      else if ((mode === 'upstream' || mode === 'tracking') && up && up.remote === remote)
        dsts.push(up.ref);
      else if (mode === 'simple' && up && up.remote === remote) dsts.push(up.ref);
      else if (mode === 'simple' && (up || auto))
        dsts.push(branch); // a non-upstream remote: as current
      else dsts.push('unknown'); // matching, nothing, an invalid mode, or no upstream
    }
  }
  let distinct = [...new Set(dsts)];
  let pushed = exit === 0 && !dryRun;
  if (view.namespaced || all) distinct = distinct.includes('unknown') ? distinct : ['unknown'];
  // Ground truth from the runner wins over the static resolution.
  if (view.moved !== undefined) pushed = view.moved;
  if (view.movedRefs.length > 0) distinct = view.movedRefs;
  const meta: Record<string, string> = {
    subcommand: 'push',
    remote,
    dstRef: distinct.length === 1 ? (distinct[0] as string) : 'unknown',
    dstRefs: distinct.join(','),
  };
  if (del) meta.delete = 'true';
  if (force) meta.force = 'true';
  if (dryRun) meta.dryRun = 'true';
  meta.pushed = pushed ? 'true' : 'false';
  return meta;
}

/** Consumes git's global options from `argv[i…]` into `view`. Returns the index of the
 * subcommand, or a terminal meta (an info option, or an option git would reject / die on). */
function consumeGlobals(
  argv: readonly string[],
  start: number,
  view: GitView,
  env: Record<string, string>,
  cwd: { dir: string; origin: string },
  inAlias: boolean,
): number | Record<string, string> {
  let i = start;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (!a.startsWith('-')) return i;
    if (a === '--') return i + 1;
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (GIT_INFO[a] !== undefined) return { subcommand: GIT_INFO[a] as string };
    if (GIT_GLOBAL_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a === '--bare' || name === '--exec-path') {
      // --bare relocates the repository; --exec-path=<dir> changes every external command.
      if (inAlias) return { subcommand: 'unknown' };
      if (a === '--bare') {
        view.elsewhere = true;
        view.branch = undefined;
        view.cfg.filesUnknown = true;
      }
      i++;
      continue;
    }
    if (!GIT_GLOBAL_VALUE.has(name)) return { subcommand: 'unknown' }; // git rejects it
    // An alias may not change the environment (git dies: "alias changes environment variables").
    if (inAlias) return { subcommand: 'unknown' };
    let value: string | undefined;
    if (name !== a) value = a.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    i++;
    if (value === undefined) return { subcommand: 'unknown' };
    switch (name) {
      case '-c':
        view.cfg.setAssignment(value);
        break;
      case '--config-env': {
        const e = value.indexOf('=');
        if (e <= 0) return { subcommand: 'unknown' };
        const v = env[value.slice(e + 1)];
        // The variable comes from the environment the facts were read under, unseen here.
        if (v === undefined) view.cfg.filesUnknown = true;
        else view.cfg.set(value.slice(0, e), v);
        break;
      }
      case '-C':
        cwd.dir = resolvePosix(cwd.dir, value);
        if (cwd.dir !== cwd.origin) {
          view.elsewhere = true;
          view.branch = undefined;
          view.cfg.filesUnknown = true;
        }
        break;
      case '--git-dir':
      case '--work-tree':
        view.elsewhere = true;
        view.branch = undefined;
        view.cfg.filesUnknown = true;
        break;
      case '--namespace':
        view.namespaced = true;
        break;
    }
  }
  return i;
}

function normalizeGit(
  argv: readonly string[],
  cwdPath: string,
  exit: number | undefined,
  ctx: ShimContext,
): Record<string, string> {
  const view = baseView(ctx);
  const env = ctx.env ?? {};
  const origin = resolvePosix('/', cwdPath || '/');
  const cwd = { dir: origin, origin };
  let words: readonly string[] = argv;
  let at = consumeGlobals(words, 0, view, env, cwd, false);
  const finish = (meta: Record<string, string>): Record<string, string> => {
    // A command that is not a push but moved a remote ref (a hook, a shell alias, send-pack)
    // pushed: it is "unknown", the value rules treat as a possible push to the protected ref.
    if (meta.subcommand !== 'push' && view.moved) {
      const refs = view.movedRefs;
      return {
        ...meta,
        ...(meta.subcommand !== 'unknown' ? { invoked: meta.subcommand } : {}),
        subcommand: 'unknown',
        dstRef: refs.length === 1 ? (refs[0] as string) : 'unknown',
        pushed: 'true',
      };
    }
    return meta;
  };
  if (typeof at !== 'number') return finish(at);
  const seen = new Set<string>();
  for (let depth = 0; ; depth++) {
    const sub = words[at];
    if (sub === undefined) return finish({ subcommand: 'unknown' });
    const rest = words.slice(at + 1);
    if (GIT_BUILTINS.has(sub)) {
      if (GIT_PUSHERS.has(sub)) return finish({ subcommand: 'unknown', invoked: sub });
      if (sub === 'submodule' && rest.includes('foreach'))
        return finish({ subcommand: 'unknown', invoked: 'submodule foreach' });
      if (sub === 'push') return normalizeGitPush(rest, exit, view);
      return finish({ subcommand: sub });
    }
    // Not a builtin: an alias (case-insensitive name), resolved transitively; else unknown.
    const name = sub.toLowerCase();
    const alias = view.cfg.get(`alias.${name}`);
    if (alias === undefined || seen.has(name) || depth >= ALIAS_DEPTH) {
      return finish({ subcommand: 'unknown', ...(depth > 0 || alias ? { alias: sub } : {}) });
    }
    seen.add(name);
    if (alias.trim().startsWith('!')) return finish({ subcommand: 'unknown', alias: sub });
    const expanded = splitCmdline(alias);
    if (!expanded || expanded.length === 0) return finish({ subcommand: 'unknown', alias: sub });
    words = [...expanded, ...rest];
    const next = consumeGlobals(words, 0, view, env, cwd, true);
    if (typeof next !== 'number') return finish({ ...next, alias: sub });
    at = next;
  }
}

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

/** Package runners that can launch the CLI: the subcommand words that may precede the bin (or
 * the package script, for `run`), and the runner options that take a separate value. */
const RUNNERS: Record<string, { prefixes: string[][]; value: Set<string> }> = {
  npx: { prefixes: [[]], value: new Set(['-p', '--package', '-c', '--call', '-w', '--workspace']) },
  bunx: { prefixes: [[]], value: new Set(['-p', '--package']) },
  pnpm: {
    prefixes: [[], ['exec'], ['dlx'], ['run'], ['run-script']],
    value: new Set([
      '-F',
      '--filter',
      '--filter-prod',
      '-C',
      '--dir',
      '--workspace-dir',
      '--reporter',
      '--loglevel',
      '--package',
      '--resume-from',
      '--test-pattern',
      '--changed-files-ignore-pattern',
    ]),
  },
  yarn: {
    prefixes: [[], ['exec'], ['dlx'], ['run']],
    value: new Set(['--cwd', '-p', '--package']),
  },
  npm: {
    prefixes: [['exec'], ['x'], ['run'], ['run-script']],
    value: new Set(['-p', '--package', '-c', '--call', '-w', '--workspace', '--prefix']),
  },
};
const isGreenlightBin = (s: string) => /^(?:@rtrentjones\/)?greenlight(?:@[^/\s]+)?$/.test(s);

/** Skips runner options from `i`; returns the next index, or -1 at a shell-string option. */
function skipRunnerOptions(argv: readonly string[], i: number, value: Set<string>): number {
  let j = i;
  while (j < argv.length) {
    const a = argv[j] as string;
    if (a === '--') return j + 1;
    if (!a.startsWith('-')) return j;
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if ((name === '-c' || name === '--call') && value.has(name)) return -1;
    j += value.has(a) ? 2 : 1;
  }
  return j;
}

/** Maps `npx greenlight …`, `pnpm --filter x exec greenlight …`, `pnpm run greenlight …`,
 * `npx --package @rtrentjones/greenlight greenlight …` and friends to `greenlight …`; anything
 * else keeps its basename. */
function unwrapRunner(cmd: string, argv: readonly string[]): { cmd: string; argv: string[] } {
  const base = cmd.split('/').pop() ?? cmd;
  if (base === 'greenlight') return { cmd: 'greenlight', argv: [...argv] };
  const runner = RUNNERS[base];
  if (!runner) return { cmd: base, argv: [...argv] };
  // Global runner options (`pnpm --filter x exec …`, `pnpm -r exec …`).
  const start = skipRunnerOptions(argv, 0, runner.value);
  if (start >= 0) {
    for (const prefix of runner.prefixes) {
      if (!prefix.every((p, k) => argv[start + k] === p)) continue;
      // Subcommand options (`npx --yes greenlight`, `npm exec -- greenlight`).
      const i = skipRunnerOptions(argv, start + prefix.length, runner.value);
      if (i >= 0 && i < argv.length && isGreenlightBin(argv[i] as string)) {
        const rest = argv.slice(i + 1);
        // `npm run greenlight -- preview x`: the separator belongs to the runner.
        return { cmd: 'greenlight', argv: rest[0] === '--' ? rest.slice(1) : [...rest] };
      }
    }
  }
  return { cmd: base, argv: [...argv] };
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
  if (u.cmd === 'git') event.meta = normalizeGit(u.argv, cwd, exit, ctx);
  else if (u.cmd === 'greenlight') event.meta = normalizeGreenlight(u.argv, exit, ctx);
  return event;
}
