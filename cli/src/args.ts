/**
 * Shared argv parsing for every CLI command — replaces the per-command `flag()` copies.
 *
 * One deliberate behavior change from those helpers: an UNKNOWN flag is an error, not a
 * silent no-op. Agents (and humans) typo flags; silently ignoring `--waitt 30` runs the
 * command with different semantics than the caller asked for — the worst failure mode for
 * a gate CLI, where "verify passed" must mean the verify the caller configured.
 */
export interface FlagSpec {
  /** Flags that take a value (`--env prod`). */
  value?: readonly string[];
  /** Boolean flags (`--json`). */
  boolean?: readonly string[];
}

export interface ParsedArgs {
  /** Non-flag arguments, in order (subcommand, tool name, …). */
  positional: string[];
  /** Value-flag assignments, keyed by flag name (`values['--env']`). */
  values: Record<string, string>;
  /** Boolean flags that were present. */
  flags: Set<string>;
}

export function parseFlags(command: string, args: string[], spec: FlagSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const out: ParsedArgs = { positional: [], values: {}, flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('-')) {
      out.positional.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined) {
        throw new Error(`\`greenlight ${command}\`: ${arg} needs a value`);
      }
      out.values[arg] = value;
      continue;
    }
    if (booleanFlags.has(arg)) {
      out.flags.add(arg);
      continue;
    }
    const known = [...valueFlags, ...booleanFlags].sort().join(' ') || '(none)';
    throw new Error(`\`greenlight ${command}\`: unknown flag "${arg}" (known flags: ${known})`);
  }
  return out;
}
