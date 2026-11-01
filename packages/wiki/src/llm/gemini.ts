import type { z } from 'zod';
import { BudgetExhaustedError, type RateLimiter, type RequestBudget } from './limits';

/** The Greenlight harness's Gemini client (vision 06 §4.8, ADR-20): `generateContent` with function
 * calling and structured output, the agent lane's retry policy (transient → retry twice with
 * backoff → one round on the fallback model), per-call `servedBy` + token usage, free-tier
 * throttling, and a redaction guard that REFUSES to send any text the detector flags.
 *
 * Transport: built-in `fetch` (or an injected one). The API key, when the env var named by
 * `keyEnv` is set, goes in the `x-goog-api-key` header, never the URL, so it cannot leak through a
 * logged URL. When it is unset no key is sent, so an egress proxy may inject one. Node's built-in
 * fetch ignores HTTPS_PROXY unless the process runs with NODE_USE_ENV_PROXY=1 (Node >= 22.21). */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** A JSON Schema object (the subset Gemini accepts for `parametersJsonSchema`/`responseJsonSchema`). */
export type JsonSchema = Record<string, unknown>;

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** One content part. Unknown fields (e.g. `thoughtSignature`, which Gemini 3 requires echoed back
 * with a functionCall) are preserved, so model turns are replayed verbatim. */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: FunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  [k: string]: unknown;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: JsonSchema;
}

export interface Usage {
  promptTokens: number;
  candidateTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export const emptyUsage = (): Usage => ({
  promptTokens: 0,
  candidateTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    candidateTokens: a.candidateTokens + b.candidateTokens,
    thoughtTokens: a.thoughtTokens + b.thoughtTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** One HTTP attempt, kept for raw records: which model, the outcome, and how long it took. */
export interface AttemptRecord {
  model: string;
  status: number | 'network' | 'timeout' | 'refused';
  ms: number;
  error?: string;
}

export interface GenerateRequest {
  systemInstruction?: string;
  contents: GeminiContent[];
  tools?: FunctionDeclaration[];
  /** Function-calling mode; `ANY` forces a function call each turn. Default `AUTO` with tools. */
  toolMode?: 'AUTO' | 'ANY' | 'NONE';
  /** Structured output for single-call judges: a JSON Schema sent as `responseJsonSchema`. */
  responseSchema?: JsonSchema;
  temperature?: number;
  seed?: number;
  maxOutputTokens?: number;
  /** Per-attempt timeout; a timeout is transient (retried). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Total request cap shared across calls (`perGateMaxRequests`). */
  budget?: RequestBudget;
  /** Overrides `GeminiClientOptions.allowFallback` for this call. */
  allowFallback?: boolean;
}

export interface GenerateResult {
  content: GeminiContent;
  /** Non-thought text parts, joined. */
  text: string;
  functionCalls: FunctionCall[];
  finishReason: string | null;
  usage: Usage;
  /** The model that actually answered: the API's `modelVersion` when it reports one, else the
   * endpoint id. A `modelVersion` that differs from the configured id is alias drift, and the gate
   * policy (`servedBy !== model`) treats it like a fallback: the rollout is not gateable. */
  servedBy: string;
  /** The configured id the caller asked for. */
  requested: string;
  /** The model id whose endpoint was called (`requested`, or the fallback). */
  endpoint: string;
  /** True when the fallback's endpoint served the call. */
  fallbackUsed: boolean;
  modelVersion?: string;
  attempts: AttemptRecord[];
}

/** Returns the findings for one string; any finding (non-empty array, or `true`) refuses the send.
 * The real detector is `findSecrets` from `packages/shared/src/redact.ts` (11 §6); it is injected so this module does
 * not depend on it. */
export type SecretDetector = (text: string) => ReadonlyArray<unknown> | boolean;

export class RedactionRefusedError extends Error {
  override readonly name = 'RedactionRefusedError';
  /** Where each flagged string sits in the request, e.g. `contents[3].parts[0].functionResponse`.
   * The flagged values themselves are deliberately not carried. */
  constructor(readonly locations: string[]) {
    super(
      `refusing to send: the redaction detector flagged ${locations.length} part(s) (${locations
        .slice(0, 5)
        .join(', ')}); fix capture/redaction, a redacted copy is never sent (06 §4.8)`,
    );
  }
}

export class GeminiHttpError extends Error {
  override readonly name: string = 'GeminiHttpError';
  constructor(
    message: string,
    readonly status: number | 'network' | 'timeout',
    readonly transient: boolean,
    readonly model: string,
    readonly attempts: AttemptRecord[],
  ) {
    super(message);
  }
}

/** The primary model stayed unavailable after its retries and the fallback is disabled (gate and
 * baseline rollouts). Transient and resumable: nothing was served, so the caller records the
 * rollout as pending and re-runs it later (06 §4.8: a gate may be split across days). */
export class FallbackDisabledError extends GeminiHttpError {
  override readonly name = 'FallbackDisabledError';
  readonly resumable = true;
  constructor(cause: GeminiHttpError) {
    super(
      `${cause.message}; fallback disabled, so the call is deferred (resume it later)`,
      cause.status,
      true,
      cause.model,
      cause.attempts,
    );
  }
}

export const isTransientStatus = (s: number) => s === 408 || s === 429 || s >= 500;

export interface ModelRef {
  id: string;
  fallback?: string;
}

export interface GeminiClientOptions {
  model: ModelRef;
  /** Name of the env var holding the key (`ModelsConfig.keyEnv`). */
  keyEnv: string;
  /** Redaction guard, required: pass `() => []` only where the input is credential-free by
   * construction. */
  findSecrets: SecretDetector;
  /** Rate limiters by model id; the primary and fallback each pass through their own. Share one map
   * between clients so a gate's calls draw on the same per-project quota. */
  limiters?: Map<string, RateLimiter>;
  /** Default true. Gate and baseline rollouts MUST pass false: a fallback-served rollout is invalid
   * for gating anyway (06 §4.8), and serving it would burn the small model's daily quota for
   * nothing. With it off, a transient failure that survives the retries throws
   * `FallbackDisabledError` instead. */
  allowFallback?: boolean;
  temperature?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Backoff before each retry; full jitter is added on top. Default [2000, 8000]. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  defaultTimeoutMs?: number;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Builds the request headers. Exported for tests: the key is a header, never a query param. */
export function geminiHeaders(
  keyEnv: string,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const key = env[keyEnv];
  if (key) h['x-goog-api-key'] = key;
  return h;
}

function proxyHint(env: Record<string, string | undefined>, keyEnv: string): string {
  if (env[keyEnv]) return '';
  if ((env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY !== '1') {
    return ` (no ${keyEnv} set and HTTPS_PROXY is ignored by Node's fetch: run with NODE_USE_ENV_PROXY=1 so a key-injecting proxy is used)`;
  }
  return ` (no ${keyEnv} set)`;
}

/** Every string leaf of `value` with its path. A leaf under an object key is scanned as
 * `key=value`, so a key-name shape (`password=…`) still sees its key; the leaf is not JSON-escaped,
 * so a value's own quotes and newlines reach the detector as written. */
function stringLeaves(value: unknown, at: string, key?: string): { at: string; text: string }[] {
  if (typeof value === 'string')
    return [{ at, text: key === undefined ? value : `${key}=${value}` }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`, k));
  }
  return [];
}

/** Every outgoing string with its location: the system text, every string leaf of every part —
 * including fields the harness does not model (`inlineData`, `fileData`, `executableCode`, …),
 * which are preserved and replayed verbatim — and the tool declarations. */
export function outgoingTexts(req: GenerateRequest): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  if (req.systemInstruction) out.push({ at: 'systemInstruction', text: req.systemInstruction });
  req.contents.forEach((c, i) => {
    c.parts.forEach((p, j) => {
      out.push(...stringLeaves(p, `contents[${i}].parts[${j}]`));
    });
  });
  for (const [k, t] of (req.tools ?? []).entries()) {
    out.push(...stringLeaves(t, `tools[${k}]`));
  }
  return out;
}

/** Throws `RedactionRefusedError` if the detector flags any outgoing string. */
export function assertPublishable(req: GenerateRequest, findSecrets: SecretDetector): void {
  const flagged: string[] = [];
  for (const { at, text } of outgoingTexts(req)) {
    const r = findSecrets(text);
    if (r === true || (Array.isArray(r) && r.length > 0)) flagged.push(at);
  }
  if (flagged.length) throw new RedactionRefusedError(flagged);
}

interface RawResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

export class GeminiClient {
  readonly model: ModelRef;
  private readonly o: GeminiClientOptions;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;

  constructor(o: GeminiClientOptions) {
    this.o = o;
    this.model = o.model;
    this.env = o.env ?? process.env;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  }

  buildBody(req: GenerateRequest): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {};
    const temperature = req.temperature ?? this.o.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (req.seed !== undefined) generationConfig.seed = req.seed;
    if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens;
    if (req.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = req.responseSchema;
    }
    const body: Record<string, unknown> = { contents: req.contents, generationConfig };
    if (req.systemInstruction)
      body.systemInstruction = { parts: [{ text: req.systemInstruction }] };
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            ...(t.parameters ? { parametersJsonSchema: t.parameters } : {}),
          })),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: req.toolMode ?? 'AUTO' } };
    }
    return body;
  }

  /** One `generateContent` call under the full policy. Throws `RedactionRefusedError` (before any
   * request), `RateLimitExhaustedError`, `BudgetExhaustedError`, or `GeminiHttpError`. */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    assertPublishable(req, this.o.findSecrets);
    const body = JSON.stringify(this.buildBody(req));
    const attempts: AttemptRecord[] = [];
    const primary = this.model.id;
    try {
      return await this.round(primary, body, req, attempts, primary);
    } catch (e) {
      const fb = this.model.fallback;
      if (!(e instanceof GeminiHttpError) || !e.transient || !fb || fb === primary) throw e;
      if (!(req.allowFallback ?? this.o.allowFallback ?? true)) throw new FallbackDisabledError(e);
      try {
        return await this.round(fb, body, req, attempts, primary);
      } catch (f) {
        if (!(f instanceof GeminiHttpError)) throw f;
        throw new GeminiHttpError(
          `${primary}: ${e.message}; fallback ${fb}: ${f.message}`,
          f.status,
          f.transient,
          fb,
          attempts,
        );
      }
    }
  }

  private async round(
    model: string,
    body: string,
    req: GenerateRequest,
    attempts: AttemptRecord[],
    requested: string,
  ): Promise<GenerateResult> {
    const delays = this.o.retryDelaysMs ?? [2_000, 8_000];
    const sleep = this.o.sleep ?? sleepMs;
    const random = this.o.random ?? Math.random;
    for (let i = 0; ; i++) {
      try {
        return await this.attempt(model, body, req, attempts, requested);
      } catch (e) {
        if (e instanceof GeminiHttpError && e.transient && i < delays.length) {
          const base = delays[i] as number;
          await sleep(base + random() * base);
          continue;
        }
        if (e instanceof GeminiHttpError && i > 0) {
          throw new GeminiHttpError(
            `${e.message} (after ${i + 1} attempts)`,
            e.status,
            e.transient,
            model,
            attempts,
          );
        }
        throw e;
      }
    }
  }

  private async attempt(
    model: string,
    body: string,
    req: GenerateRequest,
    attempts: AttemptRecord[],
    requested: string,
  ): Promise<GenerateResult> {
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
    // Budget check first (no wait), then the model's rate limit, then count the request.
    if (req.budget && req.budget.remaining === 0) throw new BudgetExhaustedError(req.budget.max);
    await this.o.limiters?.get(model)?.acquire();
    req.budget?.take();
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? this.o.defaultTimeoutMs ?? 120_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const url = `${this.o.baseUrl ?? GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    const fail = (status: AttemptRecord['status'], error: string, transient: boolean) => {
      attempts.push({ model, status, ms: Date.now() - started, error });
      return new GeminiHttpError(
        `${model}: ${error}`,
        status as number | 'network' | 'timeout',
        transient,
        model,
        attempts,
      );
    };
    let data: RawResponse;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: geminiHeaders(this.o.keyEnv, this.env),
        body,
        signal,
      });
      if (!res.ok) {
        const msg = await errorMessage(res);
        const transient = isTransientStatus(res.status);
        const hint =
          res.status === 401 || res.status === 403 ? proxyHint(this.env, this.o.keyEnv) : '';
        throw fail(res.status, `HTTP ${res.status}${msg ? `: ${msg}` : ''}${hint}`, transient);
      }
      data = (await res.json()) as RawResponse;
    } catch (e) {
      if (e instanceof GeminiHttpError) throw e;
      if (req.signal?.aborted) throw req.signal.reason ?? e;
      // Report only the error class: a fetch error message can echo request details.
      const name = (e as Error)?.name ?? 'Error';
      if (name === 'TimeoutError' || timeout.aborted)
        throw fail('timeout', `timed out after ${timeoutMs}ms`, true);
      throw fail('network', `unreachable (${name}${proxyHint(this.env, this.o.keyEnv)})`, true);
    }
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    if (!cand || parts.length === 0) {
      const why = data.promptFeedback?.blockReason ?? cand?.finishReason ?? 'no candidates';
      throw fail(200, `empty response (${why})`, false);
    }
    attempts.push({ model, status: 200, ms: Date.now() - started });
    const u = data.usageMetadata ?? {};
    const usage: Usage = {
      promptTokens: u.promptTokenCount ?? 0,
      candidateTokens: u.candidatesTokenCount ?? 0,
      thoughtTokens: u.thoughtsTokenCount ?? 0,
      totalTokens: u.totalTokenCount ?? 0,
    };
    return {
      content: { role: 'model', parts },
      text: parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join(''),
      functionCalls: parts
        .filter((p) => p.functionCall)
        .map((p) => {
          const fc = p.functionCall as FunctionCall;
          return { name: fc.name, args: fc.args ?? {}, ...(fc.id ? { id: fc.id } : {}) };
        }),
      finishReason: cand.finishReason ?? null,
      usage,
      servedBy: data.modelVersion || model,
      requested,
      endpoint: model,
      fallbackUsed: model !== requested,
      ...(data.modelVersion ? { modelVersion: data.modelVersion } : {}),
      attempts,
    };
  }

  /** A single structured-output call (the eval judge): JSON Schema to the API, zod to validate. */
  async generateStructured<T>(
    req: Omit<GenerateRequest, 'responseSchema' | 'tools' | 'toolMode'> & {
      responseSchema: JsonSchema;
      schema: z.ZodType<T>;
    },
  ): Promise<{ value: T; call: GenerateResult }> {
    const { schema, ...rest } = req;
    const call = await this.generate(rest);
    let json: unknown;
    try {
      json = JSON.parse(call.text);
    } catch {
      throw new StructuredOutputError('response is not JSON', call);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new StructuredOutputError(
        parsed.error.issues
          .slice(0, 10)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
        call,
      );
    }
    return { value: parsed.data, call };
  }
}

export class StructuredOutputError extends Error {
  override readonly name = 'StructuredOutputError';
  constructor(
    message: string,
    readonly call: GenerateResult,
  ) {
    super(`structured output invalid: ${message}`);
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string; status?: string } };
      const m = [j.error?.status, j.error?.message].filter(Boolean).join(' ');
      if (m) return m.slice(0, 300);
    } catch {
      /* not JSON */
    }
    return t.slice(0, 300);
  } catch {
    return '';
  }
}
