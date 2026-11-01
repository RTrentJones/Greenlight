import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSecrets } from '@rtrentjones/greenlight-shared';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { race } from '../../__tests__/race';
import { checkBudget, estimateGateCost, spendEvent } from '../../bench/budget';
import { BudgetSchema, ModelsConfigSchema } from '../../schema';
import {
  FallbackDisabledError,
  GeminiClient,
  type GeminiClientOptions,
  GeminiHttpError,
  RedactionRefusedError,
  outgoingTexts,
} from '../gemini';
import {
  BudgetExhaustedError,
  RateLimitExhaustedError,
  RateLimiter,
  RequestBudget,
} from '../limits';
import { checkModels, clientForRole, createLimiters } from '../models';
import { FileQuotaStore, quotaFileName, seedQuotaFromLedger, usageFromLedger } from '../quota';
import { type ReactTool, runReact } from '../react';

// Vision 06 §4.8 / roadmap M1-05: the Greenlight harness on the Gemini free tier.

const ROOT = resolve(__dirname, '../../../../..');
const modelsJson = JSON.parse(readFileSync(resolve(ROOT, 'bench/models.json'), 'utf8'));
const budgetJson = JSON.parse(readFileSync(resolve(ROOT, 'bench/budget.json'), 'utf8'));

type Reply = { status: number; body: unknown } | 'network';
interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockFetch(replies: Reply[]) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const r = replies.shift();
    if (!r) throw new Error('mock: no reply queued');
    if (r === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { impl, sent };
}

const call = (
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  status: 200,
  body: {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name, args }, ...extra }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
});
const text = (t: string) => ({
  status: 200,
  body: {
    candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  },
});
const err = (status: number, message = 'x') => ({
  status,
  body: { error: { code: status, message } },
});

function client(fetchImpl: typeof fetch, extra: Partial<GeminiClientOptions> = {}) {
  return new GeminiClient({
    model: { id: 'big', fallback: 'small' },
    keyEnv: 'GEMINI_API_KEY',
    findSecrets: () => [],
    env: {},
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
    temperature: 0.2,
    ...extra,
  });
}

const Out = z.object({ answer: z.number() }).strict();
const finish = {
  description: 'final answer',
  parameters: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
  schema: Out,
};
const add: ReactTool = {
  name: 'add',
  description: 'adds two numbers',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  argsSchema: z.object({ a: z.number(), b: z.number() }),
  run: (args) => (args.a as number) + (args.b as number),
};
const base = {
  skills: [{ name: 's', content: 'SKILL BODY' }],
  rolePrompt: 'You add.',
  task: 'add 2 and 3',
  tools: [add],
  finish,
};

describe('bench config files', () => {
  it('bench/models.json validates against ModelsConfigSchema with the ADR-20 pair', () => {
    const m = ModelsConfigSchema.parse(modelsJson);
    expect(m.roles.frontier.id).toBe('gemini-3.8-flash');
    expect(m.roles.frontier.fallback).toBe('gemini-3.6-flash');
    expect(m.roles.small.id).toBe('gemini-3.6-flash');
    expect([m.roles.maintainer, m.roles.proposer, m.roles.judge]).toEqual([
      'frontier',
      'frontier',
      'small',
    ]);
    expect(m.temperature).toBe(0.2);
  });
  it('bench/budget.json admits the first M2 gate (README-models.md arithmetic)', () => {
    const b = BudgetSchema.parse(budgetJson);
    expect(b.monthlyUsd).toBe(0);
    expect(b.perGateMaxUsd).toBe(0);
    expect(b.splitAcrossDays).toBe(true);
    // 4 val tasks × 3 runs × 2 models × 1 mode (isolation) × 2 (baseline re-run).
    const estimate = estimateGateCost({
      tasks: 4,
      runs: 3,
      models: 2,
      modes: 1,
      baselineRerun: true,
      requestsPerRollout: 12.25,
    });
    expect(estimate).toEqual({ rollouts: 48, requests: 588, usd: 0 });
    const check = checkBudget(b, estimate, [], '2026-11-01T00:00:00Z', {
      dailyRequestsRemaining: 20,
    });
    expect(check.refusals).toEqual([]);
    // Production mode (M3) doubles the rollouts and must raise the caps first.
    const m3 = estimateGateCost({
      ...{ tasks: 4, runs: 3, models: 2 },
      modes: 2,
      baselineRerun: true,
      requestsPerRollout: 12.25,
    });
    expect(checkBudget(b, m3, [], '2026-11-01T00:00:00Z').ok).toBe(false);
  });
});

describe('gemini client', () => {
  it('sends the key as a header (never in the URL), temperature, tools; and none when unset', async () => {
    const f = mockFetch([text('hi'), text('hi')]);
    await client(f.impl, { env: { GEMINI_API_KEY: 'k-123' } }).generate({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    });
    const s = f.sent[0] as Sent;
    expect(s.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/big:generateContent',
    );
    expect(s.url).not.toContain('k-123');
    expect(s.headers['x-goog-api-key']).toBe('k-123');
    expect(s.body.generationConfig).toEqual({ temperature: 0.2 });
    expect(s.body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 't', description: 'd', parametersJsonSchema: { type: 'object' } },
        ],
      },
    ]);
    await client(f.impl).generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] });
    expect((f.sent[1] as Sent).headers['x-goog-api-key']).toBeUndefined();
  });

  it('retries a 503 twice, then one round on the fallback, recording servedBy', async () => {
    const f = mockFetch([err(503), err(503), 'network', err(429), text('ok')]);
    const r = await client(f.impl).generate({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    });
    expect(f.sent.map((s) => s.url.match(/models\/(\w+):/)?.[1])).toEqual([
      'big',
      'big',
      'big',
      'small',
      'small',
    ]);
    expect(r.servedBy).toBe('small');
    expect(r.requested).toBe('big');
    expect(r.endpoint).toBe('small');
    expect(r.fallbackUsed).toBe(true);
    expect(r.usage).toEqual({
      promptTokens: 3,
      candidateTokens: 2,
      thoughtTokens: 0,
      totalTokens: 5,
    });
    expect(r.attempts.map((a) => a.status)).toEqual([503, 503, 'network', 429, 200]);
  });

  it('with fallback disabled, defers after the retries instead of calling the fallback', async () => {
    const f = mockFetch([err(429), err(429), err(429), text('never')]);
    const e = await client(f.impl, { allowFallback: false })
      .generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] })
      .catch((x) => x);
    expect(e).toBeInstanceOf(FallbackDisabledError);
    expect(e).toBeInstanceOf(GeminiHttpError);
    expect(e.transient).toBe(true);
    expect(e.resumable).toBe(true);
    expect(f.sent.map((s) => s.url.match(/models\/(\w+):/)?.[1])).toEqual(['big', 'big', 'big']);
    // A per-call override wins over the client default.
    const g = mockFetch([err(503), err(503), err(503), text('ok')]);
    const r = await client(g.impl, { allowFallback: false }).generate({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      allowFallback: true,
    });
    expect(r.fallbackUsed).toBe(true);
  });

  it('runReact reports a deferred rollout when fallback is disabled', async () => {
    const f = mockFetch([err(503), err(503), err(503)]);
    const r = await runReact({
      ...base,
      client: client(f.impl, { allowFallback: false }),
      maxSteps: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('deferred');
  });

  it('servedBy is the API modelVersion when present (alias drift), keeping requested and endpoint', async () => {
    const reply = text('ok');
    (reply.body as Record<string, unknown>).modelVersion = 'big-002';
    const f = mockFetch([reply, text('ok')]);
    const r = await client(f.impl).generate({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    });
    expect(r).toMatchObject({
      servedBy: 'big-002',
      modelVersion: 'big-002',
      requested: 'big',
      endpoint: 'big',
      fallbackUsed: false,
    });
    const r2 = await client(f.impl).generate({
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    });
    expect(r2.servedBy).toBe('big');
  });

  it('fails a non-transient 4xx immediately: no retry, no fallback', async () => {
    const f = mockFetch([err(400, 'bad request')]);
    const e = await client(f.impl)
      .generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] })
      .catch((x) => x);
    expect(e).toBeInstanceOf(GeminiHttpError);
    expect(e.transient).toBe(false);
    expect(e.message).toContain('HTTP 400');
    expect(f.sent).toHaveLength(1);
  });

  it('fails after both rounds are exhausted', async () => {
    const f = mockFetch(Array.from({ length: 6 }, () => err(503)));
    const e = await client(f.impl)
      .generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] })
      .catch((x) => x);
    expect(e).toBeInstanceOf(GeminiHttpError);
    expect(e.message).toMatch(/big: .*fallback small: /);
    expect(f.sent).toHaveLength(6);
  });

  it('refuses (does not send) when the detector flags any outgoing part, incl. tool results', async () => {
    const f = mockFetch([text('never')]);
    const c = client(f.impl, {
      findSecrets: (t) => (t.includes('ghp_') ? [{ rule: 'github-token' }] : []),
    });
    const e = await c
      .generate({
        systemInstruction: 'clean',
        contents: [
          { role: 'user', parts: [{ text: 'clean' }] },
          {
            role: 'user',
            parts: [{ functionResponse: { name: 'read_file', response: { result: 'ghp_abc' } } }],
          },
        ],
      })
      .catch((x) => x);
    expect(e).toBeInstanceOf(RedactionRefusedError);
    expect(e.locations).toEqual(['contents[1].parts[0].functionResponse.response.result']);
    expect(e.message).not.toContain('ghp_abc');
    expect(f.sent).toHaveLength(0);
  });

  it('structured output: sends responseJsonSchema and validates with zod', async () => {
    const f = mockFetch([text('{"answer":5}'), text('{"answer":"five"}')]);
    const c = client(f.impl);
    const req = {
      contents: [{ role: 'user' as const, parts: [{ text: 'judge' }] }],
      responseSchema: { type: 'object' },
      schema: Out,
    };
    const ok = await c.generateStructured(req);
    expect(ok.value).toEqual({ answer: 5 });
    expect((f.sent[0] as Sent).body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    });
    await expect(c.generateStructured(req)).rejects.toThrow(/structured output invalid: answer/);
  });

  it('a request budget counts every attempt and refuses when spent', async () => {
    const f = mockFetch([err(503), text('ok')]);
    const budget = new RequestBudget(2);
    await client(f.impl).generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }], budget });
    expect(budget.used).toBe(2);
    await expect(
      client(f.impl).generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }], budget }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});

describe('rate limiter', () => {
  it('throttles to rpm with a sliding window', async () => {
    let t = 0;
    const waits: number[] = [];
    const l = new RateLimiter({
      modelId: 'm',
      rpm: 2,
      rpd: 100,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await l.acquire();
    t += 1000;
    await l.acquire();
    await l.acquire();
    expect(waits).toEqual([59_001]);
    expect(await l.remainingToday()).toBe(97);
  });

  it('refuses when rpd is exhausted, resets on a new day, and persists through the hook', async () => {
    let t = Date.UTC(2026, 10, 1, 12);
    const store = new Map<string, { day: string; count: number }>();
    store.set('m', { day: '2026-11-01', count: 2 });
    const persistence = {
      load: (id: string) => store.get(id) ?? null,
      save: (id: string, u: { day: string; count: number }) => void store.set(id, u),
    };
    const l = new RateLimiter({ modelId: 'm', rpm: 100, rpd: 3, now: () => t, persistence });
    await l.acquire();
    expect(store.get('m')).toEqual({ day: '2026-11-01', count: 3 });
    await expect(l.acquire()).rejects.toBeInstanceOf(RateLimitExhaustedError);
    t += 24 * 3600_000;
    await l.acquire();
    expect(store.get('m')).toEqual({ day: '2026-11-02', count: 1 });
  });

  it('the client acquires the limiter of the model actually called', async () => {
    const config = ModelsConfigSchema.parse(modelsJson);
    const limiters = createLimiters(config, { sleep: async () => {} });
    expect([...limiters.keys()]).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash']);
    const f = mockFetch([err(503), err(503), err(503), text('ok')]);
    const c = clientForRole(config, 'maintainer', {
      findSecrets: () => [],
      env: {},
      fetchImpl: f.impl,
      limiters,
      sleep: async () => {},
    });
    const r = await c.generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] });
    expect(r.servedBy).toBe('gemini-3.6-flash');
    expect(await limiters.get('gemini-3.8-flash')?.remainingToday()).toBe(17);
    expect(await limiters.get('gemini-3.6-flash')?.remainingToday()).toBe(19);
  });
});

describe('react loop', () => {
  it('runs a tool-call loop to a validated finish, capturing the transcript', async () => {
    const sig = { thoughtSignature: 'sig-1' };
    const f = mockFetch([call('add', { a: 2, b: 3 }, sig), call('finish', { answer: 5 })]);
    const r = await runReact({ ...base, client: client(f.impl), maxSteps: 5 });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ answer: 5 });
    expect(r.requests).toBe(2);
    expect(r.steps).toBe(2);
    expect(r.servedBy).toEqual(['big']);
    expect(r.fallbackUsed).toBe(false);
    expect(r.usage.totalTokens).toBe(30);
    expect(r.transcript.map((e) => e.kind)).toEqual([
      'system',
      'user',
      'model',
      'tool_call',
      'tool_result',
      'model',
      'tool_call',
      'finish',
    ]);
    const sys = r.transcript[0] as { text: string };
    expect(sys.text.indexOf('SKILL BODY')).toBeLessThan(sys.text.indexOf('You add.'));
    // Second request replays the model turn verbatim (thought signature) and the tool result.
    const contents = (f.sent[1] as Sent).body.contents as {
      role: string;
      parts: Record<string, unknown>[];
    }[];
    expect(contents[1]?.parts[0]).toMatchObject({
      functionCall: { name: 'add' },
      thoughtSignature: 'sig-1',
    });
    expect(contents[2]?.parts[0]).toEqual({
      functionResponse: { name: 'add', response: { result: '5' } },
    });
    expect((f.sent[0] as Sent).body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('an invalid finish is an error; with attempts left the errors are fed back', async () => {
    const f1 = mockFetch([call('finish', { answer: 'five' })]);
    const r1 = await runReact({ ...base, client: client(f1.impl), maxSteps: 5 });
    expect(r1.ok).toBe(false);
    expect(r1.error?.kind).toBe('finish_invalid');
    expect(r1.error?.issues?.[0]).toMatch(/^answer: /);

    const f2 = mockFetch([call('finish', { answer: 'five' }), call('finish', { answer: 5 })]);
    const r2 = await runReact({
      ...base,
      client: client(f2.impl),
      maxSteps: 5,
      maxFinishAttempts: 2,
    });
    expect(r2.result).toEqual({ answer: 5 });
    const fed = (f2.sent[1] as Sent).body.contents as {
      parts: { functionResponse?: { response: { issues?: string[] } } }[];
    }[];
    expect(fed[2]?.parts[0]?.functionResponse?.response.issues?.[0]).toMatch(/^answer: /);
  });

  it('tool errors and unknown tools go back to the model as results, not crashes', async () => {
    const f = mockFetch([call('nope', {}), call('add', { a: 'x' }), call('finish', { answer: 1 })]);
    const r = await runReact({ ...base, client: client(f.impl), maxSteps: 5 });
    expect(r.ok).toBe(true);
    const results = r.transcript.filter((e) => e.kind === 'tool_result') as {
      ok: boolean;
      result: string;
    }[];
    expect(results.map((x) => x.ok)).toEqual([false, false]);
    expect(results[0]?.result).toContain('unknown tool');
    expect(results[1]?.result).toContain('invalid arguments');
  });

  it('stops at the step limit', async () => {
    const f = mockFetch([call('add', { a: 1, b: 1 }), call('add', { a: 1, b: 1 })]);
    const r = await runReact({ ...base, client: client(f.impl), maxSteps: 2 });
    expect(r.error?.kind).toBe('step_limit');
    expect(r.steps).toBe(2);
  });

  it('stops when the request budget is exhausted (retries count)', async () => {
    const f = mockFetch([err(503), call('add', { a: 1, b: 1 }), call('add', { a: 1, b: 1 })]);
    const r = await runReact({
      ...base,
      client: client(f.impl),
      maxSteps: 10,
      budget: new RequestBudget(3),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('budget_exhausted');
    expect(r.requests).toBe(3);
    expect(r.transcript.at(-1)?.kind).toBe('error');
  });

  it('records a fallback-served run (invalid for gating)', async () => {
    const f = mockFetch([err(503), err(503), err(503), call('finish', { answer: 5 })]);
    const r = await runReact({ ...base, client: client(f.impl), maxSteps: 3 });
    expect(r.ok).toBe(true);
    expect(r.servedBy).toEqual(['small']);
    expect(r.fallbackUsed).toBe(true);
    expect(r.requests).toBe(4);
  });

  it('a tool result the detector flags is refused before the next send', async () => {
    const leak: ReactTool = {
      ...add,
      name: 'read_file',
      argsSchema: undefined,
      run: () => 'token=ghp_leak',
    };
    const f = mockFetch([call('read_file', {}), text('never sent')]);
    const r = await runReact({
      ...base,
      tools: [leak],
      client: client(f.impl, { findSecrets: (t) => /ghp_/.test(t) }),
      maxSteps: 5,
    });
    expect(r.error?.kind).toBe('redaction_refused');
    expect(f.sent).toHaveLength(1);
  });

  it('nudges a text-only turn back to tools', async () => {
    const f = mockFetch([text('thinking out loud'), call('finish', { answer: 2 })]);
    const r = await runReact({ ...base, client: client(f.impl), maxSteps: 3, toolMode: 'AUTO' });
    expect(r.result).toEqual({ answer: 2 });
    const c = (f.sent[1] as Sent).body.contents as { parts: { text?: string }[] }[];
    expect(c[2]?.parts[0]?.text).toMatch(/calling a tool/);
  });
});

describe('checkModels', () => {
  const config = ModelsConfigSchema.parse(modelsJson);
  it('passes when every configured id is listed (across pages)', async () => {
    const f = mockFetch([
      {
        status: 200,
        body: {
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          ],
          nextPageToken: 'p2',
        },
      },
      {
        status: 200,
        body: {
          models: [
            { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        },
      },
    ]);
    const r = await checkModels(config, f.impl, { env: {} });
    expect(r).toMatchObject({
      ok: true,
      missing: [],
      checked: ['gemini-3.8-flash', 'gemini-3.6-flash'],
    });
    expect(f.sent[1]?.url).toContain('pageToken=p2');
  });
  it('fails on an unavailable id', async () => {
    const f = mockFetch([
      {
        status: 200,
        body: {
          models: [
            { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['embedContent'] },
          ],
        },
      },
    ]);
    const r = await checkModels(config, f.impl, { env: {} });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['gemini-3.8-flash']);
  });
  it('throws on an HTTP failure', async () => {
    const f = mockFetch([err(403)]);
    await expect(checkModels(config, f.impl, { env: {} })).rejects.toThrow(/HTTP 403/);
  });
});

describe('outgoing scan covers every string leaf (9c)', () => {
  const leak = `${'gh'}p_${'Ab3'.repeat(13)}`;
  const req = (part: Record<string, unknown>) => ({
    contents: [{ role: 'user' as const, parts: [{ text: 'clean' }, part] }],
  });

  it.each([
    ['inlineData', { inlineData: { mimeType: 'text/plain', data: leak } }],
    ['fileData', { fileData: { mimeType: 'text/plain', fileUri: `https://x.test/${leak}` } }],
    ['executableCode', { executableCode: { language: 'PYTHON', code: `print("${leak}")` } }],
    ['a nested unknown field', { futureField: { deep: [{ value: leak }] } }],
    ['functionCall args', { functionCall: { name: 'write_file', args: { content: leak } } }],
  ])('refuses a secret in %s, before any request', async (_n, part) => {
    const f = mockFetch([text('never')]);
    const e = await client(f.impl, { findSecrets: (t) => findSecrets(t) })
      .generate(req(part))
      .catch((x) => x);
    expect(e).toBeInstanceOf(RedactionRefusedError);
    expect(e.locations).toHaveLength(1);
    expect(e.locations[0]).toMatch(/^contents\[0\]\.parts\[1\]\./);
    expect(f.sent).toHaveLength(0);
  });

  it('scans a leaf with its key, so a key-name shape still fires', async () => {
    const part = { functionCall: { name: 'x', args: { password: 'hunter2hunter2' } } };
    expect(outgoingTexts(req(part)).map((t) => t.text)).toContain('password=hunter2hunter2');
    const f = mockFetch([text('never')]);
    const e = await client(f.impl, { findSecrets: (t) => findSecrets(t) })
      .generate(req(part))
      .catch((x) => x);
    expect(e).toBeInstanceOf(RedactionRefusedError);
  });

  it('sends a clean replayed model turn, thought signature and vendored code included', async () => {
    const f = mockFetch([text('ok')]);
    const r = await client(f.impl, { findSecrets: (t) => findSecrets(t) }).generate({
      contents: [
        { role: 'user', parts: [{ text: 'read the worker' }] },
        {
          role: 'model',
          parts: [{ text: 'ok', thoughtSignature: 'EqsBCqgBAWkUfRM8t2Fog6inh35Tk' }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: {
                  result: 'headers = { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` };',
                },
              },
            },
          ],
        },
      ],
    });
    expect(r.text).toBe('ok');
  });
});

describe('FileQuotaStore', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'gl-quota-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('persists the count in .greenlight/quota/<model>.json across limiters (processes)', async () => {
    const root = tmp();
    const t = Date.UTC(2026, 10, 1, 12);
    const mk = () =>
      new RateLimiter({
        modelId: 'gemini-3.8-flash',
        rpm: 100,
        rpd: 3,
        now: () => t,
        persistence: new FileQuotaStore({ root }),
      });
    await mk().acquire();
    await mk().acquire();
    const file = join(root, '.greenlight/quota/gemini-3.8-flash.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ day: '2026-11-01', count: 2 });
    // Two limiters created before either spends: the shared count still stops at rpd.
    const a = mk();
    const b = mk();
    expect(await a.remainingToday()).toBe(1);
    expect(await b.remainingToday()).toBe(1);
    const results = await Promise.allSettled([a.acquire(), b.acquire()]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RateLimitExhaustedError);
    expect(JSON.parse(readFileSync(file, 'utf8')).count).toBe(3);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('starts a new day at zero and takes over a stale lock', () => {
    const root = tmp();
    let now = Date.now();
    const s = new FileQuotaStore({ root, now: () => now, staleLockMs: 10 });
    s.save('m', { day: '2026-10-31', count: 20 });
    expect(s.take('m', '2026-11-01', 20)).toEqual({ day: '2026-11-01', count: 1 });
    writeFileSync(`${s.path('m')}.lock`, '');
    now += 60_000;
    expect(s.take('m', '2026-11-01', 20)).toEqual({ day: '2026-11-01', count: 2 });
    expect(s.take('m', '2026-11-01', 2)).toBeNull();
  });

  it('processes racing over a stale lock steal it once and lose no increment', async () => {
    const root = tmp();
    const s = new FileQuotaStore({ root });
    s.save('m', { day: '2026-11-01', count: 0 });
    const lock = `${s.path('m')}.lock`;
    writeFileSync(lock, 'crashed-holder');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const results = await race(
      8,
      pathToFileURL(resolve(__dirname, '../quota.ts')).href,
      `
        const s = new m.FileQuotaStore({ root: arg.root, staleLockMs: 5000, lockTimeoutMs: 30000 });
        for (let i = 0; i < 15; i++) if (!s.take('m', '2026-11-01', 10000)) throw new Error('refused');
        return 1;
      `,
      { root },
    );
    for (const r of results) expect(r.stderr).toBe('');
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(s.load('m')).toEqual({ day: '2026-11-01', count: 8 * 15 });
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.guard`)).toBe(false);
  }, 60_000);

  it('refuses a corrupt file rather than resetting the count', () => {
    const root = tmp();
    const s = new FileQuotaStore({ root });
    s.save('m', { day: '2026-11-01', count: 1 });
    writeFileSync(s.path('m'), '{oops');
    expect(() => s.load('m')).toThrow(/not valid JSON/);
  });

  it('names files safely', () => {
    expect(quotaFileName('models/gemini-3.8-flash')).toBe('models_gemini-3.8-flash.json');
  });

  it('seeds today from ledger spend events, never lowering a recorded count', () => {
    const root = tmp();
    const s = new FileQuotaStore({ root });
    const spend = (ts: string, requests: number) =>
      spendEvent({ ts, usd: 0, rollouts: 1, requests, tokensIn: 1, tokensOut: 1 });
    // 2026-11-01 Pacific (PDT) runs from 07:00Z on 11-01 to 07:00Z on 11-02.
    const events = [
      spend('2026-11-01T06:59:00Z', 50), // still 2026-10-31 in Pacific time
      spend('2026-11-01T08:00:00Z', 7),
      spend('2026-11-02T06:00:00Z', 5),
    ];
    const ids = ['gemini-3.8-flash', 'gemini-3.6-flash'];
    const now = new Date('2026-11-01T20:00:00Z');
    expect(usageFromLedger(events, ids, { now }).get('gemini-3.6-flash')).toEqual({
      day: '2026-11-01',
      count: 12,
    });
    const attributed = usageFromLedger(events, ids, {
      now,
      modelOf: (e) => (e.spend?.requests === 7 ? 'gemini-3.8-flash' : undefined),
    });
    expect(attributed.get('gemini-3.8-flash')?.count).toBe(12);
    expect(attributed.get('gemini-3.6-flash')?.count).toBe(5);
    s.save('gemini-3.8-flash', { day: '2026-11-01', count: 15 });
    const seeded = seedQuotaFromLedger(s, events, ids, { now });
    expect(seeded.get('gemini-3.8-flash')?.count).toBe(15);
    expect(seeded.get('gemini-3.6-flash')?.count).toBe(12);
  });

  it('charges a spend event that names its model to that model only', () => {
    const now = new Date('2026-11-01T20:00:00Z');
    const ids = ['gemini-3.8-flash', 'gemini-3.6-flash'];
    const spend = (requests: number, model?: string) =>
      spendEvent({
        ts: '2026-11-01T18:00:00Z',
        usd: 0,
        rollouts: 1,
        requests,
        tokensIn: 1,
        tokensOut: 1,
        ...(model ? { model, evaluationId: `e-${requests}` } : {}),
      });
    const events = [
      spend(9, 'gemini-3.6-flash'),
      spend(4, 'gemini-3.8-flash'),
      spend(3, 'some-other-model'),
      spend(2), // unnamed: every model
    ];
    expect(events[0]?.spend?.model).toBe('gemini-3.6-flash');
    const u = usageFromLedger(events, ids, { now });
    expect(u.get('gemini-3.6-flash')?.count).toBe(11);
    expect(u.get('gemini-3.8-flash')?.count).toBe(6);
    // A named model wins over the caller's attribution.
    const v = usageFromLedger(events, ids, { now, modelOf: () => 'gemini-3.8-flash' });
    expect(v.get('gemini-3.6-flash')?.count).toBe(9);
    const s = new FileQuotaStore({ root: tmp() });
    expect(seedQuotaFromLedger(s, events, ids, { now }).get('gemini-3.6-flash')?.count).toBe(11);
  });
});

describe('checkModels: methods and deprecation', () => {
  const config = ModelsConfigSchema.parse(modelsJson);
  it('treats a model with no listed methods as unusable and reports deprecated ones', async () => {
    const f = mockFetch([
      {
        status: 200,
        body: {
          models: [
            { name: 'models/gemini-3.8-flash' },
            {
              name: 'models/gemini-3.6-flash',
              description: 'Deprecated: migrate to a newer Flash model.',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        },
      },
    ]);
    const r = await checkModels(config, f.impl, { env: {} });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['gemini-3.8-flash']);
    expect(r.deprecated).toEqual(['gemini-3.6-flash']);
  });
});
