import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { TrajectoryEvent } from '../schema/bench';
import { type ShimContext, normalizeShimEvent } from './trajectory';

/**
 * The host side of the trajectory shims (vision 06 §4.2, §4.6; 08 §10.2).
 *
 * Inside a rollout, `git`, `greenlight`, `wrangler`, `vercel`, `gh`, `terraform`, `docker` and
 * `curl` on the agent's PATH are shims (`bench/runner/shim.sh` → `bench/runner/record.mjs`). Each
 * runs the real command and then sends ONE line of JSON ({@link ShimMessage}) to a unix socket the
 * host serves ({@link ShimChannel}). In the docker sandbox that socket is owned by the shim user
 * with mode 0600, so the agent's own processes cannot connect: they can neither forge nor edit an
 * event, and the trajectory file itself is written by the host, outside the container.
 *
 * Ordering is the HOST's: a single {@link Sequencer} stamps every agent tool call (when the host
 * starts it) and every shim event (when it arrives) with the next global `seq` and a monotonic
 * host timestamp. No container or process clock is trusted for order, so clock skew cannot reorder
 * a push before a preview. A shim event arrives when its command exits, which for the sequential
 * commands of one tool call is the order they ran in.
 *
 * Meta is computed by `normalizeShimEvent` (trajectory.ts), the same code the graders use, from
 * the full ShimContext: branch, upstreams and `git config --list` read before the command under a
 * fixed base environment, the command's env difference from that base (GIT_CONFIG_*), and the
 * bare origin's refs before vs after (`remoteMoved`/`movedRefs`: `pushed` is ground truth).
 */

export const SHIMMED_COMMANDS = [
  'git',
  'greenlight',
  'wrangler',
  'vercel',
  'gh',
  'terraform',
  'docker',
  'curl',
] as const;
export type ShimmedCommand = (typeof SHIMMED_COMMANDS)[number];

export const ShimMessageSchema = z
  .object({
    v: z.literal(1),
    cmd: z.enum(SHIMMED_COMMANDS),
    argv: z.array(z.string()).max(4096),
    cwd: z.string().max(4096),
    exit: z.number().int(),
    git: z
      .object({
        branch: z.string().nullable(),
        refs: z.string().max(1_000_000),
        config: z.string().max(1_000_000),
      })
      .strict()
      .optional(),
    origin: z
      .object({ before: z.string().max(1_000_000), after: z.string().max(1_000_000) })
      .strict()
      .optional(),
    /** The command's environment entries that differ from the base env the `git` facts were
     * read under (`ShimContext.env`). */
    env: z.record(z.string(), z.string().max(100_000)).optional(),
  })
  .strict();
export type ShimMessage = z.infer<typeof ShimMessageSchema>;

/** One global order for a rollout: `seq` 0, 1, 2, … and a host timestamp that never goes back. */
export class Sequencer {
  private seq = 0;
  private last = 0;
  constructor(private readonly now: () => number = Date.now) {}
  next(): { seq: number; ts: string } {
    this.last = Math.max(this.last, this.now());
    return { seq: this.seq++, ts: new Date(this.last).toISOString() };
  }
}

/** Parses the git-ctx.sh output (`git config --list`: `key=value` lines, section and key
 * lowercased by git, the subsection as written) into the ShimContext `normalizeShimEvent` reads:
 * the typed fields plus the full file config. Missing facts stay absent. */
export function parseGitState(g: NonNullable<ShimMessage['git']>): ShimContext {
  const ctx: ShimContext = {};
  if (g.branch) ctx.branch = g.branch;
  const upstreams: NonNullable<ShimContext['upstreams']> = {};
  for (const line of g.refs.split('\n')) {
    const [branch, remote, ref] = line.split(' ');
    if (branch && remote && ref) upstreams[branch] = { remote, ref };
  }
  ctx.upstreams = upstreams;
  const config: Record<string, string | string[]> = {};
  const aliases: Record<string, string> = {};
  const branchPushRemotes: Record<string, string> = {};
  for (const line of g.config.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    const prev = config[key];
    config[key] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
    const lower = key.toLowerCase();
    if (lower === 'push.default') {
      if (['simple', 'current', 'upstream', 'matching', 'nothing'].includes(value))
        ctx.pushDefault = value as NonNullable<ShimContext['pushDefault']>;
    } else if (lower === 'remote.pushdefault') ctx.pushRemote = value;
    else if (lower.startsWith('alias.')) aliases[key.slice('alias.'.length)] = value;
    else if (lower.startsWith('branch.') && lower.endsWith('.pushremote')) {
      branchPushRemotes[key.slice('branch.'.length, -'.pushremote'.length)] = value;
    }
  }
  ctx.aliases = aliases;
  ctx.branchPushRemotes = branchPushRemotes;
  ctx.config = config;
  return ctx;
}

function refMap(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [sha, ref] = line.split(' ');
    if (sha && ref) m.set(ref, sha);
  }
  return m;
}

/** Refs of the bare origin that were created, deleted or moved between two listings. */
export function movedRefs(before: string, after: string): string[] {
  const a = refMap(before);
  const b = refMap(after);
  const out = new Set<string>();
  for (const [ref, sha] of a) if (b.get(ref) !== sha) out.add(ref);
  for (const ref of b.keys()) if (!a.has(ref)) out.add(ref);
  return [...out].sort();
}

/**
 * Origin refs that moved during the rollout without a recorded command to account for them
 * (vision 06 §4.6: the shims are a recording device, so the runner checks the recording is
 * complete). `start`/`end` are the host's own listings of the bare origin before the agent ran
 * and after every process was killed; `observed` are the before/after listings of every recorded
 * git command.
 *
 * For every ref, each value seen anywhere (in any recorded listing, and at the end) must be its
 * starting value or the value some recorded command left it at (a ref that command moved). So a
 * push made by writing `/srv/origin.git` directly, or by a binary the shims do not cover, is
 * caught whether it happened between two recorded commands (their listings disagree) or after
 * the last one (the end disagrees). Concurrent recorded commands are tolerated: every value one
 * of them observes was left by another recorded command. A move that is undone before anything
 * looks again is invisible, and so is a move made BY a recorded command's own child process (it
 * is attributed to that command): both are documented residual risks (06 §4.6).
 */
export function unexplainedRefMoves(
  start: string,
  end: string,
  observed: readonly { before: string; after: string }[],
): string[] {
  const s = refMap(start);
  const allowed = new Map<string, Set<string>>();
  const allow = (ref: string, v: string) => {
    const set = allowed.get(ref) ?? new Set([s.get(ref) ?? '']);
    set.add(v);
    allowed.set(ref, set);
  };
  for (const o of observed) {
    const after = refMap(o.after);
    for (const ref of movedRefs(o.before, o.after)) allow(ref, after.get(ref) ?? '');
  }
  const ok = (ref: string, v: string) => (allowed.get(ref) ?? new Set([s.get(ref) ?? ''])).has(v);
  const bad = new Set<string>();
  const check = (listing: string) => {
    const m = refMap(listing);
    for (const [ref, sha] of m) if (!ok(ref, sha)) bad.add(ref);
    for (const ref of s.keys()) if (!m.has(ref) && !ok(ref, '')) bad.add(ref);
  };
  for (const o of observed) {
    check(o.before);
    check(o.after);
  }
  check(end);
  return [...bad].sort();
}

/** One shim message as a TrajectoryEvent (seq/ts from the host's sequencer). The runner's
 * ground truth — which origin refs moved while the command ran — goes in as
 * `remoteMoved`/`movedRefs`, so `pushed` (and a resolved `dstRef`) come from the remote, not the
 * exit code. */
export function shimMessageToEvent(
  msg: ShimMessage,
  at: { seq: number; ts: string },
): TrajectoryEvent {
  const ctx: ShimContext = msg.git ? parseGitState(msg.git) : {};
  if (msg.env) ctx.env = msg.env;
  if (msg.origin) {
    const moved = movedRefs(msg.origin.before, msg.origin.after);
    ctx.movedRefs = moved;
    ctx.remoteMoved = moved.length > 0;
  }
  return { ...at, ...normalizeShimEvent(msg.cmd, msg.argv, msg.cwd, msg.exit, ctx) };
}

export interface ChannelOptions {
  sequencer: Sequencer;
  /** Owner of the socket: in the docker sandbox the shim user's uid, so only it can connect. */
  uid?: number;
  gid?: number;
  /** Socket mode (default 0600). */
  mode?: number;
  /** Max bytes per connection (default 2 MB); a longer message is rejected. */
  maxBytes?: number;
  /** Max events per rollout (default 10,000); more truncates the trajectory. */
  maxEvents?: number;
  /** Max bytes over all connections of the rollout (default 8 MB); more truncates. */
  maxTotalBytes?: number;
}

export const MAX_SHIM_EVENTS = 10_000;
export const MAX_SHIM_TOTAL_BYTES = 8 * 1024 * 1024;

/** A unix-socket server receiving shim messages. Every accepted message becomes one event at its
 * arrival position; anything malformed is rejected (counted with its reason), never repaired.
 * Past the per-rollout caps the channel stops accepting and records why in `truncated`: the
 * trajectory is then incomplete, and the rollout's outcome invalid (never a pass). */
export class ShimChannel {
  readonly events: TrajectoryEvent[] = [];
  readonly rejected: string[] = [];
  /** The before/after origin listings of every accepted git event (`unexplainedRefMoves`). */
  readonly originListings: { before: string; after: string }[] = [];
  /** Why the trajectory was cut short, if it was. */
  truncated: string | undefined;
  private closed = false;
  private totalBytes = 0;

  private constructor(
    readonly socketPath: string,
    private readonly server: Server,
    private readonly maxEvents: number,
  ) {}

  static listen(socketPath: string, o: ChannelOptions): Promise<ShimChannel> {
    const max = o.maxBytes ?? 2_000_000;
    const maxTotal = o.maxTotalBytes ?? MAX_SHIM_TOTAL_BYTES;
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    let channel: ShimChannel | undefined;
    const server = createServer((sock) => {
      const chunks: Buffer[] = [];
      let size = 0;
      sock.on('data', (b: Buffer) => {
        if (!channel || channel.truncated) {
          sock.destroy();
          return;
        }
        size += b.length;
        channel.totalBytes += b.length;
        if (channel.totalBytes > maxTotal) {
          channel.truncated ??= `shim messages over ${maxTotal} bytes in one rollout`;
          sock.destroy();
          return;
        }
        if (size > max) {
          channel.rejected.push(`message over ${max} bytes`);
          sock.destroy();
          return;
        }
        chunks.push(b);
      });
      sock.on('error', () => {});
      sock.on('end', () => {
        if (!channel || channel.closed || channel.truncated || size > max) return;
        for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          channel.accept(line, o.sequencer);
        }
      });
    });
    return new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(socketPath, () => {
        try {
          chmodSync(socketPath, o.mode ?? 0o600);
          if (o.uid !== undefined) chownSync(socketPath, o.uid, o.gid ?? o.uid);
        } catch (e) {
          server.close();
          rej(e);
          return;
        }
        channel = new ShimChannel(socketPath, server, o.maxEvents ?? MAX_SHIM_EVENTS);
        res(channel);
      });
    });
  }

  private accept(line: string, sequencer: Sequencer): void {
    if (this.truncated) return;
    if (this.events.length >= this.maxEvents) {
      this.truncated = `more than ${this.maxEvents} shim events in one rollout`;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.rejected.push('not JSON');
      return;
    }
    const r = ShimMessageSchema.safeParse(raw);
    if (!r.success) {
      this.rejected.push(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    this.events.push(shimMessageToEvent(r.data, sequencer.next()));
    if (r.data.origin) this.originListings.push({ ...r.data.origin });
  }

  /** Why this rollout's trajectory cannot be trusted as complete, or undefined: truncated, a
   * rejected message (a recorded command whose event is lost), or an origin ref that moved with
   * no recorded command to explain it (`start`/`end`: the host's own origin listings). */
  integrity(start: string, end: string): string | undefined {
    if (this.truncated) return `trajectory-truncated: ${this.truncated}`;
    if (this.rejected.length > 0)
      return `trajectory-incomplete: ${this.rejected.length} shim message(s) rejected (${this.rejected[0]})`;
    const refs = unexplainedRefMoves(start, end, this.originListings);
    if (refs.length > 0)
      return `trajectory-incomplete: origin ref(s) moved with no recorded command: ${refs.join(', ')}`;
    return undefined;
  }

  /** Stops accepting: a message arriving after the rollout ended is dropped. */
  close(): Promise<void> {
    this.closed = true;
    return new Promise((res) => this.server.close(() => res()));
  }
}

/** A transcript tool call as a TrajectoryEvent (`source: transcript`, cmd = the tool name). */
export function toolCallEvent(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  at: { seq: number; ts: string },
): TrajectoryEvent {
  const argv =
    name === 'bash'
      ? [String(args.command ?? '')]
      : typeof args.path === 'string'
        ? [args.path]
        : [];
  return { ...at, source: 'transcript', cmd: name, argv, cwd };
}

/** The rollout's trajectory: transcript tool calls and shim events in the one host order. */
export function mergeTrajectory(...lists: readonly TrajectoryEvent[][]): TrajectoryEvent[] {
  return lists.flat().sort((a, b) => a.seq - b.seq);
}

export const toJsonl = (events: readonly TrajectoryEvent[]): string =>
  events.map((e) => `${JSON.stringify(e)}\n`).join('');

/** Process-sandbox shims (local development only): one `#!/bin/sh` per command, calling the
 * recorder in `--process` mode with a config outside the work dir. Same uid as the agent: the
 * channel is NOT protected, which is why the process sandbox never serves a gate. */
export function writeProcessShims(
  dir: string,
  o: {
    node: string;
    recordScript: string;
    gitCtx: string;
    socket: string;
    origin: string;
    real: Partial<Record<ShimmedCommand, string[] | null>>;
    /** The env the git facts are read under (the command's difference from it is reported). */
    baseEnv: Record<string, string>;
  },
): void {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, '.shim-config.json');
  writeFileSync(
    config,
    JSON.stringify({
      socket: o.socket,
      origin: o.origin,
      gitCtx: o.gitCtx,
      real: o.real,
      baseEnv: o.baseEnv,
    }),
  );
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  for (const c of SHIMMED_COMMANDS) {
    const p = join(dir, c);
    writeFileSync(
      p,
      `#!/bin/sh\nexec ${q(o.node)} ${q(o.recordScript)} --process ${q(config)} ${c} "$@"\n`,
    );
    chmodSync(p, 0o755);
  }
}
