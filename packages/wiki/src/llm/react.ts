import type { z } from 'zod';
import {
  type FunctionCall,
  type FunctionDeclaration,
  type GeminiClient,
  type GeminiContent,
  GeminiHttpError,
  type GeminiPart,
  type JsonSchema,
  RedactionRefusedError,
  type Usage,
  addUsage,
  emptyUsage,
} from './gemini';
import { BudgetExhaustedError, RateLimitExhaustedError, RequestBudget } from './limits';

/** The Greenlight harness's ReAct loop (vision 06 §4.8): the skills under test injected in full
 * into the system prompt, then the role prompt; a fixed tool registry; a `finish` tool whose
 * argument is the role's output, validated by the caller's zod schema. Every model turn, tool call
 * and tool result is captured as structured data for raw records and trajectories. */

/** Part of the BaselineIdentity (`agent.vendor`/`agent.version`, 08 §10.3). Bump the version when
 * the prompt scaffolding or loop semantics change: that re-baselines, like a model change. */
export const HARNESS_VENDOR = 'greenlight-harness';
export const HARNESS_VERSION = '0.1.0';

export const FINISH_TOOL = 'finish';

export interface ToolContext {
  step: number;
  signal?: AbortSignal;
}

export interface ReactTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments (sent to the model). */
  parameters: JsonSchema;
  /** Optional zod check of the arguments before `run`; a failure is returned to the model. */
  argsSchema?: z.ZodType<unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): unknown | Promise<unknown>;
}

export interface FinishSpec<T> {
  description: string;
  /** JSON Schema for the model; `schema` is what is enforced. */
  parameters: JsonSchema;
  schema: z.ZodType<T>;
}

export interface Skill {
  name: string;
  content: string;
}

export type TranscriptEntry =
  | { seq: number; ts: string; kind: 'system'; text: string }
  | { seq: number; ts: string; kind: 'user'; text: string }
  | {
      seq: number;
      ts: string;
      kind: 'model';
      step: number;
      text: string;
      functionCalls: FunctionCall[];
      finishReason: string | null;
      servedBy: string;
      fallbackUsed: boolean;
      usage: Usage;
      attempts: number;
    }
  | {
      seq: number;
      ts: string;
      kind: 'tool_call';
      step: number;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      seq: number;
      ts: string;
      kind: 'tool_result';
      step: number;
      name: string;
      ok: boolean;
      result: unknown;
      durationMs: number;
    }
  | { seq: number; ts: string; kind: 'finish'; step: number; ok: boolean; issues?: string[] }
  | { seq: number; ts: string; kind: 'error'; step: number; error: ReactError };

export type ReactErrorKind =
  | 'step_limit'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'redaction_refused'
  | 'model_error'
  | 'finish_invalid'
  | 'aborted';

export interface ReactError {
  kind: ReactErrorKind;
  message: string;
  issues?: string[];
}

export interface ReactOptions<T> {
  client: GeminiClient;
  skills: Skill[];
  rolePrompt: string;
  /** The first user turn: the task brief, or the bundle pointer for maintainer/proposer. */
  task: string;
  tools: ReactTool[];
  finish: FinishSpec<T>;
  /** Max model turns. */
  maxSteps: number;
  /** Per-HTTP-attempt timeout. */
  callTimeoutMs?: number;
  /** Total request cap; pass one shared budget to cap a whole gate. Default: `maxSteps * 3`. */
  budget?: RequestBudget;
  /** How many `finish` submissions are allowed; each invalid one is fed back with its errors while
   * attempts remain (06 §2.4 allows the maintainer three). Default 1: the first invalid one fails. */
  maxFinishAttempts?: number;
  /** `ANY` (default) forces a tool call every turn, so `finish` is the only exit. */
  toolMode?: 'AUTO' | 'ANY';
  /** Tool results longer than this are truncated head-first with a marker. Default 20,000. */
  maxToolResultChars?: number;
  seed?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ReactResult<T> {
  ok: boolean;
  result?: T;
  error?: ReactError;
  transcript: TranscriptEntry[];
  usage: Usage;
  /** Every model id that answered a call; more than one, or a fallback, invalidates a gate
   * rollout (06 §4.8). */
  servedBy: string[];
  fallbackUsed: boolean;
  /** HTTP requests made by this run, retries included. */
  requests: number;
  steps: number;
}

/** The system prompt: the skills in full, then the role prompt (06 §4.8 table). */
export function buildSystemPrompt(skills: Skill[], rolePrompt: string): string {
  const out: string[] = [];
  if (skills.length) {
    out.push('# Skills\n\nThese skills are in force for this task. Follow them.');
    for (const s of skills) out.push(`## Skill: ${s.name}\n\n${s.content.trim()}`);
  }
  out.push(`# Role\n\n${rolePrompt.trim()}`);
  out.push(
    `# Protocol\n\nAct only through the provided tools. When you are done, call \`${FINISH_TOOL}\` exactly once with your final output as its arguments.`,
  );
  return out.join('\n\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.length - max;
  return `…[truncated ${cut} chars]…${s.slice(cut)}`;
}

function issuesOf(e: z.ZodError): string[] {
  return e.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

function toError(e: unknown): ReactError {
  if (e instanceof RedactionRefusedError)
    return { kind: 'redaction_refused', message: e.message, issues: e.locations };
  if (e instanceof BudgetExhaustedError) return { kind: 'budget_exhausted', message: e.message };
  if (e instanceof RateLimitExhaustedError) return { kind: 'rate_limited', message: e.message };
  if (e instanceof GeminiHttpError) return { kind: 'model_error', message: e.message };
  const err = e as Error;
  if (err?.name === 'AbortError') return { kind: 'aborted', message: err.message };
  return { kind: 'model_error', message: err?.message ?? String(e) };
}

export async function runReact<T>(o: ReactOptions<T>): Promise<ReactResult<T>> {
  const now = o.now ?? (() => new Date());
  const transcript: TranscriptEntry[] = [];
  let seq = 0;
  // biome-ignore lint/suspicious/noExplicitAny: entries are discriminated by `kind` at call sites.
  const log = (e: any) => transcript.push({ seq: seq++, ts: now().toISOString(), ...e });

  const names = new Set<string>();
  for (const t of o.tools) {
    if (t.name === FINISH_TOOL || names.has(t.name)) throw new Error(`duplicate tool "${t.name}"`);
    names.add(t.name);
  }
  const registry = new Map(o.tools.map((t) => [t.name, t]));
  const declarations: FunctionDeclaration[] = [
    ...o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    { name: FINISH_TOOL, description: o.finish.description, parameters: o.finish.parameters },
  ];
  const system = buildSystemPrompt(o.skills, o.rolePrompt);
  const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: o.task }] }];
  log({ kind: 'system', text: system });
  log({ kind: 'user', text: o.task });

  const budget = o.budget ?? new RequestBudget(o.maxSteps * 3);
  const maxChars = o.maxToolResultChars ?? 20_000;
  const maxFinish = o.maxFinishAttempts ?? 1;
  let usage = emptyUsage();
  const served = new Set<string>();
  let fallbackUsed = false;
  let requests = 0;
  let finishAttempts = 0;
  let step = 0;

  const done = (r: { result?: T; error?: ReactError }): ReactResult<T> => {
    if (r.error) log({ kind: 'error', step, error: r.error });
    return {
      ok: r.error === undefined,
      ...r,
      transcript,
      usage,
      servedBy: [...served],
      fallbackUsed,
      requests,
      steps: step,
    };
  };

  while (step < o.maxSteps) {
    step += 1;
    const before = budget.used;
    let call: Awaited<ReturnType<GeminiClient['generate']>>;
    try {
      call = await o.client.generate({
        systemInstruction: system,
        contents,
        tools: declarations,
        toolMode: o.toolMode ?? 'ANY',
        budget,
        ...(o.callTimeoutMs !== undefined ? { timeoutMs: o.callTimeoutMs } : {}),
        ...(o.seed !== undefined ? { seed: o.seed } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      requests += budget.used - before;
      if (e instanceof GeminiHttpError) {
        for (const a of e.attempts) if (a.status === 200) served.add(a.model);
      }
      return done({ error: toError(e) });
    }
    requests += budget.used - before;
    usage = addUsage(usage, call.usage);
    served.add(call.servedBy);
    fallbackUsed ||= call.fallbackUsed;
    log({
      kind: 'model',
      step,
      text: call.text,
      functionCalls: call.functionCalls,
      finishReason: call.finishReason,
      servedBy: call.servedBy,
      fallbackUsed: call.fallbackUsed,
      usage: call.usage,
      attempts: call.attempts.length,
    });
    // Replay the model turn verbatim (Gemini 3 needs its thought signatures back).
    contents.push(call.content);

    if (call.functionCalls.length === 0) {
      contents.push({
        role: 'user',
        parts: [{ text: `Respond only by calling a tool. Call \`${FINISH_TOOL}\` when done.` }],
      });
      continue;
    }

    const responses: GeminiPart[] = [];
    let finishCall: FunctionCall | undefined;
    for (const fc of call.functionCalls) {
      log({ kind: 'tool_call', step, name: fc.name, args: fc.args });
      if (fc.name === FINISH_TOOL) {
        finishCall ??= fc;
        continue;
      }
      const started = Date.now();
      const tool = registry.get(fc.name);
      let ok = true;
      let result: unknown;
      if (!tool) {
        ok = false;
        result = { error: `unknown tool "${fc.name}"` };
      } else {
        const parsed = tool.argsSchema?.safeParse(fc.args);
        if (parsed && !parsed.success) {
          ok = false;
          result = { error: 'invalid arguments', issues: issuesOf(parsed.error) };
        } else {
          try {
            result = await tool.run(fc.args, { step, ...(o.signal ? { signal: o.signal } : {}) });
          } catch (e) {
            ok = false;
            result = { error: (e as Error)?.message ?? String(e) };
          }
        }
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      const clipped = truncate(text, maxChars);
      log({
        kind: 'tool_result',
        step,
        name: fc.name,
        ok,
        result: clipped,
        durationMs: Date.now() - started,
      });
      responses.push({
        functionResponse: {
          name: fc.name,
          response: ok ? { result: clipped } : { error: clipped },
          ...(fc.id ? { id: fc.id } : {}),
        },
      });
    }

    if (finishCall) {
      finishAttempts += 1;
      const parsed = o.finish.schema.safeParse(finishCall.args);
      if (parsed.success) {
        log({ kind: 'finish', step, ok: true });
        return done({ result: parsed.data });
      }
      const issues = issuesOf(parsed.error);
      log({ kind: 'finish', step, ok: false, issues });
      if (finishAttempts >= maxFinish) {
        return done({
          error: { kind: 'finish_invalid', message: 'finish output failed validation', issues },
        });
      }
      responses.push({
        functionResponse: {
          name: FINISH_TOOL,
          response: { error: 'output rejected; fix these and call finish again', issues },
          ...(finishCall.id ? { id: finishCall.id } : {}),
        },
      });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return done({
    error: { kind: 'step_limit', message: `no valid finish within ${o.maxSteps} steps` },
  });
}
