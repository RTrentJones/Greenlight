import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { emptyUsage } from '../llm/gemini';
import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  FINISH_TOOL,
  type FinishSpec,
  type ReactError,
  type ReactResult,
  type ReactTool,
  type TranscriptEntry,
  executeToolCall,
  finishIssues,
  finishRejectedMessage,
  stepsRemainingNote,
} from '../llm/react';
import { HANDLE_PREFIX, ROLLOUT_CLIENT_FILE, ROLLOUT_CLIENT_SOURCE } from './rollout-client';

/**
 * External rollouts (vision 06 §4.9; ADR-20 amendment): the inference agent of a rollout is an
 * agent launched from OUTSIDE the harness (for example one fresh coding-agent subagent per
 * rollout), not the harness's own ReAct loop. Everything else is the harness's: the sandbox, the
 * tools, the trajectory recorder, the step budget, grading in a separate container, raw records
 * and the sealed EvaluationRecord.
 *
 * This file is the host side of that: a control endpoint on 127.0.0.1 that lives as long as one
 * `bench run` invocation, a session per rollout (random token, step counting, the transcript in
 * the ReAct loop's shape), and the manifest a launcher reads to dispatch agents. `runner.ts`
 * opens a session where it would otherwise call `runReact`, and gets the same `ReactResult` back.
 *
 * What a session maps onto, in the ReAct loop's terms:
 * - one client command that calls a tool or `finish` = one step (one model turn with one call);
 * - the step limit closes the session as `step_limit`, the wall clock as `aborted`: both are
 *   graded on the tree as it stands, exactly like a harness rollout that ran out;
 * - a session nobody claims within the claim timeout closes as `deferred`: no agent ran, so it is
 *   not evidence of anything, and the rollout re-runs on `--resume`.
 */

export const DEFAULT_EXTERNAL_CONCURRENCY = 4;
export const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60_000;
/** An outside agent is slower per step than the harness loop (a process spawn and often a model
 * turn per command), so its wall clock is the task's timeout times this. In `harness.limits`. */
export const DEFAULT_EXTERNAL_TIMEOUT_FACTOR = 3;
/** Identity `agent.vendor` of an evaluation whose rollouts an external agent drove. */
export const EXTERNAL_VENDOR = 'external' as const;
/** A declared agent id: who the launcher says drove the rollouts (e.g. `claude-code/<model>`). */
export const EXTERNAL_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,99}$/;

export type ExternalState =
  /** Not open yet: its sandbox does not exist. A call is refused. */
  | 'queued'
  /** The sandbox is up and waiting for its agent's first command. Dispatch an agent now. */
  | 'open'
  /** An agent has made its first command; the wall clock runs. */
  | 'claimed'
  /** Closed (finish, step limit, wall clock): being exported and graded. */
  | 'grading'
  /** Graded and recorded. */
  | 'done'
  /** Not claimed in time (or its judge was unavailable): re-runs on `--resume`. */
  | 'deferred'
  /** A harness error: no outcome. */
  | 'error';

export interface ExternalRolloutSpec {
  /** `buildSystemPrompt(skills, rolePrompt)`: what the harness's own loop would have sent. */
  system: string;
  /** The task brief (the first user turn). */
  brief: string;
  tools: ReactTool[];
  finish: FinishSpec<Record<string, unknown>>;
  maxSteps: number;
  maxFinishAttempts: number;
  announceRemainingSteps: number;
  wallClockMs: number;
  claimTimeoutMs: number;
  /** What a transcript `model` entry names as its server: the model LABEL (declared). */
  servedBy: string;
}

interface Session {
  id: string;
  token: string;
  key: string;
  task: string;
  model: string;
  run: number;
  state: ExternalState;
  detail?: string;
  openedAt?: string;
  claimedAt?: string;
  closedAt?: string;
  spec?: ExternalRolloutSpec;
  registry?: Map<string, ReactTool>;
  transcript: TranscriptEntry[];
  seq: number;
  step: number;
  finishAttempts: number;
  /** Set once: why the session closed. Later calls are refused with it. */
  closed?: string;
  /** Set when the wall clock ran out while a call was in flight: no further call is taken, and
   * the session closes as soon as that call has returned. */
  closing?: string;
  /** Serializes the session's calls: one tool call at a time, whatever the agent launches. */
  chain: Promise<unknown>;
  claimTimer?: NodeJS.Timeout;
  wallTimer?: NodeJS.Timeout;
  resolve?: (r: ReactResult<Record<string, unknown>>) => void;
}

interface CallReply {
  /** 0 ran; 1 ran and reported an error; 3 refused. */
  exit: 0 | 1 | 3;
  output: string;
}

export interface RolloutServerOptions {
  /** Where the client and (by default) the manifest are written: outside the repository. */
  dir: string;
  manifestPath?: string;
  evaluationId: string;
  /** The declared agent id. */
  agent: string;
  concurrency: number;
  claimTimeoutMs: number;
  now?: () => Date;
}

export interface ManifestRollout {
  key: string;
  task: string;
  model: string;
  run: number;
  state: ExternalState;
  handle: string;
  /** The exact client command prefix for this rollout; append a verb. */
  command: string;
  detail?: string;
  openedAt?: string;
  claimedAt?: string;
  closedAt?: string;
  stepsUsed: number;
}

export interface RolloutManifest {
  v: 1;
  evaluationId: string;
  agent: string;
  updatedAt: string;
  /** `running` while the server is up; `ended` once every rollout is closed (handles are dead). */
  status: 'running' | 'ended';
  concurrency: number;
  claimTimeoutSec: number;
  /** The client script (absolute path): `node <clientPath> <handle> <verb> …`. */
  clientPath: string;
  /** What to tell one agent, with `<command>` the rollout's `command`. */
  instruction: string;
  counts: Record<ExternalState, number>;
  rollouts: ManifestRollout[];
}

const STATES: ExternalState[] = [
  'queued',
  'open',
  'claimed',
  'grading',
  'done',
  'deferred',
  'error',
];

/** The sentence a launcher hands to each agent. The agent needs nothing else. */
export const AGENT_INSTRUCTION =
  'Run `<command> prompt` and do exactly what it prints. Use only that client; do not read or write any file on this machine.';

export class RolloutServer {
  private readonly sessions = new Map<string, Session>();
  private readonly byKey = new Map<string, Session>();
  private server!: Server;
  private port = 0;
  private ended = false;
  readonly clientPath: string;
  readonly manifestPath: string;
  private readonly now: () => Date;

  private constructor(private readonly o: RolloutServerOptions) {
    this.clientPath = join(o.dir, ROLLOUT_CLIENT_FILE);
    this.manifestPath = o.manifestPath ?? join(o.dir, 'manifest.json');
    this.now = o.now ?? (() => new Date());
  }

  static async start(o: RolloutServerOptions): Promise<RolloutServer> {
    const s = new RolloutServer(o);
    mkdirSync(o.dir, { recursive: true });
    writeFileSync(s.clientPath, ROLLOUT_CLIENT_SOURCE);
    chmodSync(s.clientPath, 0o755);
    s.server = createServer((req, res) => {
      void s.handle(req, res);
    });
    // A `bash` call may run for ten minutes: no request or socket timeout.
    s.server.requestTimeout = 0;
    s.server.headersTimeout = 0;
    s.server.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      s.server.once('error', reject);
      s.server.listen(0, '127.0.0.1', () => resolve());
    });
    s.port = (s.server.address() as AddressInfo).port;
    return s;
  }

  /** Registers a rollout as `queued` and fixes its handle. */
  add(key: string): ManifestRollout {
    const [task, model, run] = key.split('|') as [string, string, string];
    const id = `r${(this.sessions.size + 1).toString(36)}`;
    const s: Session = {
      id,
      token: randomBytes(16).toString('hex'),
      key,
      task,
      model,
      run: Number(run),
      state: 'queued',
      transcript: [],
      seq: 0,
      step: 0,
      finishAttempts: 0,
      chain: Promise.resolve(),
    };
    this.sessions.set(id, s);
    this.byKey.set(key, s);
    return this.entry(s);
  }

  handleOf(key: string): string {
    const s = this.need(key);
    return `${HANDLE_PREFIX}-${this.port}-${s.id}-${s.token}`;
  }

  commandOf(key: string): string {
    return `node ${JSON.stringify(this.clientPath)} ${this.handleOf(key)}`;
  }

  private need(key: string): Session {
    const s = this.byKey.get(key);
    if (!s) throw new Error(`no external rollout ${key}`);
    return s;
  }

  /**
   * Opens a rollout to its agent and resolves when it closes: with the output of an accepted
   * `finish`, or with the error that ended it (`step_limit`, `aborted` for the wall clock,
   * `finish_invalid`, or `deferred` when nobody claimed it). The transcript has the ReAct loop's
   * shape: `system`, `user`, then per step a `model` entry with its one call, the `tool_call`,
   * the `tool_result`, and `finish` / `error` entries.
   */
  open(key: string, spec: ExternalRolloutSpec): Promise<ReactResult<Record<string, unknown>>> {
    const s = this.need(key);
    if (s.state !== 'queued') throw new Error(`external rollout ${key} was already opened`);
    s.spec = spec;
    s.registry = new Map(spec.tools.map((t) => [t.name, t]));
    this.log(s, { kind: 'system', text: `${spec.system}\n\n${clientProtocol(spec)}` });
    this.log(s, { kind: 'user', text: spec.brief });
    s.state = 'open';
    s.openedAt = this.now().toISOString();
    const done = new Promise<ReactResult<Record<string, unknown>>>((resolve) => {
      s.resolve = resolve;
    });
    s.claimTimer = setTimeout(() => {
      if (s.state !== 'open') return;
      this.end(s, {
        error: {
          kind: 'deferred',
          message: `no agent claimed the rollout within ${Math.round(spec.claimTimeoutMs / 1000)} s of it opening`,
        },
      });
    }, spec.claimTimeoutMs);
    this.writeManifest();
    return done;
  }

  /** Records what became of a rollout after it closed (graded, deferred, harness error). */
  settle(key: string, state: 'done' | 'deferred' | 'error', detail?: string): void {
    const s = this.need(key);
    s.state = state;
    if (detail) s.detail = detail;
    this.writeManifest();
  }

  async close(): Promise<void> {
    this.ended = true;
    for (const s of this.sessions.values()) {
      clearTimeout(s.claimTimer);
      clearTimeout(s.wallTimer);
      s.closed ??= 'the evaluation has ended';
    }
    this.writeManifest();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  // -------------------------------------------------------------------------------------------

  // biome-ignore lint/suspicious/noExplicitAny: entries are discriminated by `kind` at call sites.
  private log(s: Session, e: any): void {
    s.transcript.push({ seq: s.seq++, ts: this.now().toISOString(), ...e });
  }

  /** Closes the session and hands the ReAct-shaped result to the runner. Idempotent. */
  private end(s: Session, r: { result?: Record<string, unknown>; error?: ReactError }): void {
    if (s.closed !== undefined) return;
    clearTimeout(s.claimTimer);
    clearTimeout(s.wallTimer);
    s.closed = r.error
      ? `${r.error.kind}: ${r.error.message}`
      : 'finish was accepted; the rollout is being graded';
    if (r.error) this.log(s, { kind: 'error', step: s.step, error: r.error });
    s.closedAt = this.now().toISOString();
    s.state = 'grading';
    s.detail = s.closed;
    this.writeManifest();
    s.resolve?.({
      ok: r.error === undefined,
      ...r,
      transcript: s.transcript,
      usage: emptyUsage(),
      // Declared, not verified: the harness never saw a model serve these steps.
      servedBy: s.step > 0 ? [(s.spec as ExternalRolloutSpec).servedBy] : [],
      fallbackUsed: false,
      requests: 0,
      steps: s.step,
    });
  }

  private claim(s: Session): void {
    if (s.state !== 'open') return;
    const spec = s.spec as ExternalRolloutSpec;
    clearTimeout(s.claimTimer);
    s.state = 'claimed';
    s.claimedAt = this.now().toISOString();
    s.wallTimer = setTimeout(() => {
      // Let a call in flight return first (as the harness loop does: its abort lands between
      // turns), then close: the tree is graded as it stands.
      // An agent that asked for the prompt and never made a call left no evidence: deferred.
      const secs = Math.round(spec.wallClockMs / 1000);
      s.closing = `the rollout's wall clock (${secs} s) ran out`;
      void s.chain.then(() =>
        this.end(s, {
          error:
            s.step === 0
              ? {
                  kind: 'deferred',
                  message: `the agent claimed the rollout but made no call within its wall clock (${secs} s)`,
                }
              : {
                  kind: 'aborted',
                  message: `the rollout's wall clock (${secs} s from the first command) ran out`,
                },
        }),
      );
    }, spec.wallClockMs);
    this.writeManifest();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (http: number, reply: CallReply) => {
      const body = JSON.stringify(reply);
      res.writeHead(http, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    const refuse = (http: number, why: string) =>
      send(http, { exit: 3, output: `refused: ${why}` });
    if (req.method !== 'POST' || req.url !== '/v1/call') return refuse(404, 'unknown endpoint');
    let body: { rollout?: unknown; token?: unknown; verb?: unknown; args?: unknown };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 32 * 1024 * 1024) return refuse(413, 'request too large (32 MiB)');
        chunks.push(c as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return refuse(400, 'the request is not JSON');
    }
    const s = typeof body.rollout === 'string' ? this.sessions.get(body.rollout) : undefined;
    const token = typeof body.token === 'string' ? body.token : '';
    const good =
      s !== undefined &&
      token.length === s.token.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(s.token));
    // One answer for an unknown rollout and a wrong token: a handle is not guessable piecewise.
    if (!s || !good) return refuse(403, 'bad handle or token');
    const verb = typeof body.verb === 'string' ? body.verb : '';
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const run = s.chain.then(() => this.call(s, verb, args));
    s.chain = run.catch(() => {});
    try {
      send(200, await run);
    } catch (e) {
      refuse(500, `rollout server error: ${(e as Error).message}`);
    }
  }

  private async call(s: Session, verb: string, args: Record<string, unknown>): Promise<CallReply> {
    const refused = (why: string): CallReply => ({ exit: 3, output: `refused: ${why}` });
    if (verb === 'status') return { exit: 0, output: JSON.stringify(this.entry(s), null, 2) };
    if (this.ended) return refused('the evaluation has ended');
    if (s.state === 'queued')
      return refused(
        'this rollout is not open yet: its sandbox starts when an earlier rollout finishes. Wait, then run `prompt` again',
      );
    if (s.closed !== undefined) return refused(`the rollout is closed (${s.closed})`);
    if (s.closing !== undefined) return refused(`the rollout is closed (${s.closing})`);
    const spec = s.spec as ExternalRolloutSpec;
    if (verb === 'prompt') {
      this.claim(s);
      return { exit: 0, output: promptDocument(spec) };
    }
    if (verb === '') return refused('no verb');
    this.claim(s);
    // One command = one step = one model turn with one function call.
    s.step += 1;
    const step = s.step;
    const left = spec.maxSteps - step;
    this.log(s, {
      kind: 'model',
      step,
      text: '',
      functionCalls: [{ name: verb, args }],
      finishReason: null,
      servedBy: spec.servedBy,
      fallbackUsed: false,
      usage: emptyUsage(),
      attempts: 0,
    });
    this.log(s, { kind: 'tool_call', step, name: verb, args });
    const note = () => {
      if (left > spec.announceRemainingSteps) return '';
      const n = stepsRemainingNote(left);
      return `\n[steps_remaining: ${n.steps_remaining}; ${n.note}]`;
    };
    const stepLimit = () => {
      if (left > 0 || s.closed !== undefined) return '';
      this.end(s, {
        error: { kind: 'step_limit', message: `no valid finish within ${spec.maxSteps} steps` },
      });
      return '\n[the step budget is used up: the rollout is closed and is graded as it stands]';
    };

    if (verb === FINISH_TOOL) {
      s.finishAttempts += 1;
      const parsed = spec.finish.schema.safeParse(args);
      if (parsed.success) {
        this.log(s, { kind: 'finish', step, ok: true });
        this.end(s, { result: parsed.data });
        return { exit: 0, output: 'finish accepted: the rollout is closed and is being graded.' };
      }
      const issues = finishIssues(parsed.error);
      this.log(s, { kind: 'finish', step, ok: false, issues });
      if (s.finishAttempts >= spec.maxFinishAttempts) {
        this.end(s, {
          error: { kind: 'finish_invalid', message: 'finish output failed validation', issues },
        });
        return {
          exit: 1,
          output: `finish rejected, and no attempt is left: the rollout is closed and is graded as it stands.\n${issues.map((i) => `- ${i}`).join('\n')}`,
        };
      }
      const text = `${finishRejectedMessage(spec.maxFinishAttempts - s.finishAttempts)}\n${issues.map((i) => `- ${i}`).join('\n')}`;
      return { exit: 1, output: `${text}${note()}${stepLimit()}` };
    }

    const r = await executeToolCall(
      s.registry as Map<string, ReactTool>,
      { name: verb, args },
      { step },
      DEFAULT_MAX_TOOL_RESULT_CHARS,
    );
    this.log(s, {
      kind: 'tool_result',
      step,
      name: verb,
      ok: r.ok,
      result: r.result,
      durationMs: r.durationMs,
    });
    return {
      exit: r.ok ? 0 : 1,
      output: `${r.ok ? '' : '[tool error] '}${r.result}${note()}${stepLimit()}`,
    };
  }

  private entry(s: Session): ManifestRollout {
    return {
      key: s.key,
      task: s.task,
      model: s.model,
      run: s.run,
      state: s.state,
      handle: this.port ? this.handleOf(s.key) : '',
      command: this.port ? this.commandOf(s.key) : '',
      ...(s.detail ? { detail: s.detail } : {}),
      ...(s.openedAt ? { openedAt: s.openedAt } : {}),
      ...(s.claimedAt ? { claimedAt: s.claimedAt } : {}),
      ...(s.closedAt ? { closedAt: s.closedAt } : {}),
      stepsUsed: s.step,
    };
  }

  manifest(): RolloutManifest {
    const rollouts = [...this.sessions.values()].map((s) => this.entry(s));
    const counts = Object.fromEntries(
      STATES.map((st) => [st, rollouts.filter((r) => r.state === st).length]),
    ) as Record<ExternalState, number>;
    return {
      v: 1,
      evaluationId: this.o.evaluationId,
      agent: this.o.agent,
      updatedAt: this.now().toISOString(),
      status: this.ended ? 'ended' : 'running',
      concurrency: this.o.concurrency,
      claimTimeoutSec: Math.round(this.o.claimTimeoutMs / 1000),
      clientPath: this.clientPath,
      instruction: AGENT_INSTRUCTION,
      counts,
      rollouts,
    };
  }

  /** Rewritten on every state change, atomically: a launcher polls it and dispatches an agent
   * for each rollout that is `open`. */
  writeManifest(): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true });
    const tmp = `${this.manifestPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.manifest(), null, 2)}\n`);
    renameSync(tmp, this.manifestPath);
  }
}

/** The budget an external agent works under, stated in ITS terms (compare `budgetNote`): a step
 * is one client command, and the harness counts no model requests. */
export function externalBudgetNote(limits: {
  maxSteps: number;
  wallClockMin: number;
  announceRemainingSteps: number;
}): string {
  return `Budget: you have at most ${limits.maxSteps} steps. One step is one tool call or one \`finish\`; you
make one call at a time. The run also ends ${fmtMin(limits.wallClockMin)} after your first call. It ends when either
runs out, whatever state the work is in, so plan for it: explore briefly, do the work, and call
\`finish\` with steps to spare. From ${limits.announceRemainingSteps} steps left, every tool response tells you how many remain.`;
}

const fmtMin = (m: number) =>
  m >= 1 ? `${Math.round(m * 10) / 10} minute(s)` : `${Math.round(m * 60)} second(s)`;

/** How the tools are called through the client. `{{CLIENT}}` is replaced by the client with its
 * own command line, so nothing here (or in the transcript) names a path. */
export function clientProtocol(spec: Pick<ExternalRolloutSpec, 'tools' | 'finish'>): string {
  const has = (n: string) => spec.tools.some((t) => t.name === n);
  const lines: string[] = [
    '# Client',
    '',
    'You act ONLY through this command-line client. Each tool is a verb of it:',
    '',
    '    {{CLIENT}} <verb> [argument] [flags]',
    '',
    'Rules:',
    '- Use only this client. Do not read or write any file on this machine, and do not look at the',
    '  directory or repository the client lives in: the files of the task exist only inside the',
    '  sandbox the client reaches, and paths are relative to the repository root there.',
    '- One tool call per command, one command at a time. Every tool call and every `finish` costs',
    '  one step; `prompt` and `status` cost none.',
    '- The result is printed on stdout. Exit code 0: the call ran. 1: the call ran and reported an',
    '  error (read it). 3: refused (the rollout is closed, the budget is used up, or the handle is',
    '  wrong): stop, there is nothing more to do.',
    '- Arguments: the short forms below, or one JSON object (`<verb> \'{"path":"a.txt"}\'`), or',
    '  JSON on stdin (`<verb> --json-stdin`).',
    '',
    'Tools:',
  ];
  const forms: Record<string, string[]> = {
    read_file: ['{{CLIENT}} read_file <path> [--offset <first line>] [--limit <lines>]'],
    write_file: ["{{CLIENT}} write_file <path> --content-stdin <<'EOF'", '<the whole file>', 'EOF'],
    list_dir: ['{{CLIENT}} list_dir [<path>]'],
    list_files: ['{{CLIENT}} list_files [<path>] [--depth <n>]'],
    bash: [
      "{{CLIENT}} bash '<command>' [--timeout-sec <n>]",
      "{{CLIENT}} bash --command-stdin <<'EOF'   (for a command with quotes or several lines)",
    ],
  };
  for (const t of spec.tools) {
    lines.push('', `## ${t.name}`, '', t.description, '');
    for (const f of forms[t.name] ?? [`{{CLIENT}} ${t.name} '<json arguments>'`])
      lines.push(`    ${f}`);
    lines.push('', `Arguments (JSON Schema): ${JSON.stringify(t.parameters)}`);
  }
  lines.push('', `## ${FINISH_TOOL}`, '', spec.finish.description, '');
  if (has('bash') || has('write_file')) {
    lines.push(`    {{CLIENT}} ${FINISH_TOOL} '<one-paragraph summary>'`);
  } else {
    lines.push(
      `    {{CLIENT}} ${FINISH_TOOL} --json-stdin <<'EOF'`,
      '    <the output object as JSON>',
      '    EOF',
    );
  }
  lines.push('', `Arguments (JSON Schema): ${JSON.stringify(spec.finish.parameters)}`);
  return lines.join('\n');
}

/** What `prompt` prints: one document with everything the agent needs. */
export function promptDocument(spec: ExternalRolloutSpec): string {
  return [
    '# Greenlight bench rollout',
    '',
    'You are the agent of one benchmark rollout. The work happens in an isolated sandbox that only',
    'the client below can reach. Read this whole document, then do the task.',
    '',
    clientProtocol(spec),
    '',
    '---',
    '',
    spec.system,
    '',
    '---',
    '',
    '# Task',
    '',
    spec.brief.trim(),
    '',
  ].join('\n');
}
