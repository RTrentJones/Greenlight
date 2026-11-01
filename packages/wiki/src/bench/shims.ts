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
 * Meta is computed by `normalizeShimEvent` (trajectory.ts), the same code the graders use. The one
 * fact the shim observes directly is `pushed`: it is true only when a ref of the bare `origin`
 * actually moved during the command (refs before vs after), never inferred from the exit code.
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

/** Parses the git-ctx.sh output (`git config --get-regexp` keys are lowercased by git, except the
 * branch subsection) into the ShimContext `normalizeShimEvent` reads. Missing facts stay absent. */
export function parseGitState(g: NonNullable<ShimMessage['git']>): ShimContext {
  const ctx: ShimContext = {};
  if (g.branch) ctx.branch = g.branch;
  const upstreams: NonNullable<ShimContext['upstreams']> = {};
  for (const line of g.refs.split('\n')) {
    const [branch, remote, ref] = line.split(' ');
    if (branch && remote && ref) upstreams[branch] = { remote, ref };
  }
  ctx.upstreams = upstreams;
  const aliases: Record<string, string> = {};
  const branchPushRemotes: Record<string, string> = {};
  for (const line of g.config.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'push.default') {
      if (['simple', 'current', 'upstream', 'matching', 'nothing'].includes(value))
        ctx.pushDefault = value as NonNullable<ShimContext['pushDefault']>;
    } else if (key === 'remote.pushdefault') ctx.pushRemote = value;
    else if (key.startsWith('alias.')) aliases[key.slice('alias.'.length)] = value;
    else if (key.startsWith('branch.') && key.endsWith('.pushremote')) {
      branchPushRemotes[key.slice('branch.'.length, -'.pushremote'.length)] = value;
    }
  }
  ctx.aliases = aliases;
  ctx.branchPushRemotes = branchPushRemotes;
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

/** One shim message as a TrajectoryEvent (seq/ts from the host's sequencer). */
export function shimMessageToEvent(
  msg: ShimMessage,
  at: { seq: number; ts: string },
): TrajectoryEvent {
  const ctx = msg.git ? parseGitState(msg.git) : {};
  const e = normalizeShimEvent(msg.cmd, msg.argv, msg.cwd, msg.exit, ctx);
  if (e.meta?.subcommand === 'push' && e.meta.pushed !== undefined) {
    // Ground truth over inference: a push "pushed" only if a ref of origin moved.
    const moved = msg.origin ? movedRefs(msg.origin.before, msg.origin.after) : [];
    const dst = e.meta.dstRef;
    const full = dst?.startsWith('refs/') ? dst : `refs/heads/${dst}`;
    const landed = dst === undefined || dst === 'unknown' ? moved.length > 0 : moved.includes(full);
    e.meta.pushed = landed && e.meta.dryRun !== 'true' ? 'true' : 'false';
  }
  return { ...at, ...e };
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
}

/** A unix-socket server receiving shim messages. Every accepted message becomes one event at its
 * arrival position; anything malformed is rejected (counted with its reason), never repaired. */
export class ShimChannel {
  readonly events: TrajectoryEvent[] = [];
  readonly rejected: string[] = [];
  private closed = false;

  private constructor(
    readonly socketPath: string,
    private readonly server: Server,
  ) {}

  static listen(socketPath: string, o: ChannelOptions): Promise<ShimChannel> {
    const max = o.maxBytes ?? 2_000_000;
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    let channel: ShimChannel | undefined;
    const server = createServer((sock) => {
      const chunks: Buffer[] = [];
      let size = 0;
      sock.on('data', (b: Buffer) => {
        size += b.length;
        if (size > max) {
          channel?.rejected.push(`message over ${max} bytes`);
          sock.destroy();
          return;
        }
        chunks.push(b);
      });
      sock.on('error', () => {});
      sock.on('end', () => {
        if (!channel || channel.closed || size > max) return;
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
        channel = new ShimChannel(socketPath, server);
        res(channel);
      });
    });
  }

  private accept(line: string, sequencer: Sequencer): void {
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
  },
): void {
  mkdirSync(dir, { recursive: true });
  const config = join(dir, '.shim-config.json');
  writeFileSync(
    config,
    JSON.stringify({ socket: o.socket, origin: o.origin, gitCtx: o.gitCtx, real: o.real }),
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
