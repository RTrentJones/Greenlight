/**
 * Shared argv parsing for every CLI command — replaces the per-command `flag()` copies.
 *
 * One deliberate behavior change from those helpers: an UNKNOWN flag is an error, not a
 * silent no-op. Agents (and humans) typo flags; silently ignoring `--waitt 30` runs the
 * command with different semantics than the caller asked for — the worst failure mode for
 * a gate CLI, where "verify passed" must mean the verify the caller configured.
 */
/** The caller got the command line wrong (exit 2 everywhere). Thrown by `parseFlags`; commands
 * throw it for their own argument errors so the exit code never depends on a message's wording. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface FlagSpec {
  /** Flags that take a value (`--env prod`). */
  value?: readonly string[];
  /** Boolean flags (`--json`). */
  boolean?: readonly string[];
  /** Value flags that may be repeated (`--check a --check b`); collected in order. */
  list?: readonly string[];
}

export interface ParsedArgs {
  /** Non-flag arguments, in order (subcommand, tool name, …). */
  positional: string[];
  /** Value-flag assignments, keyed by flag name (`values['--env']`). */
  values: Record<string, string>;
  /** Boolean flags that were present. */
  flags: Set<string>;
  /** Repeatable value flags, keyed by flag name; a flag that was not given has no key. */
  lists: Record<string, string[]>;
}

export function parseFlags(command: string, args: string[], spec: FlagSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const listFlags = new Set(spec.list ?? []);
  const out: ParsedArgs = { positional: [], values: {}, flags: new Set(), lists: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('-')) {
      out.positional.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined) {
        throw new UsageError(`\`greenlight ${command}\`: ${arg} needs a value`);
      }
      out.values[arg] = value;
      continue;
    }
    if (listFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined) {
        throw new UsageError(`\`greenlight ${command}\`: ${arg} needs a value`);
      }
      out.lists[arg] = [...(out.lists[arg] ?? []), value];
      continue;
    }
    if (booleanFlags.has(arg)) {
      out.flags.add(arg);
      continue;
    }
    const known = [...valueFlags, ...listFlags, ...booleanFlags].sort().join(' ') || '(none)';
    throw new UsageError(
      `\`greenlight ${command}\`: unknown flag "${arg}" (known flags: ${known})`,
    );
  }
  return out;
}

/** Refuses stray positional arguments on a command that takes at most `max` of them: a typo such
 * as a flag value without its flag must not run the command with different semantics. */
export function maxPositionals(command: string, a: ParsedArgs, max: number): void {
  if (a.positional.length > max) {
    const extra = a.positional
      .slice(max)
      .map((x) => `"${x}"`)
      .join(', ');
    throw new UsageError(
      `\`greenlight ${command}\`: unexpected argument ${extra} (${max === 0 ? 'this command takes flags only' : `at most ${max} positional argument(s)`})`,
    );
  }
}
