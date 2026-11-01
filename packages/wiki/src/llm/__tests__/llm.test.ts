import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetSchema, ModelsConfigSchema } from '../../schema';
import {
  GeminiClient,
  type GeminiClientOptions,
  GeminiHttpError,
  RedactionRefusedError,
} from '../gemini';
import {
  BudgetExhaustedError,
  RateLimitExhaustedError,
  RateLimiter,
  RequestBudget,
} from '../limits';
import { checkModels, clientForRole, createLimiters } from '../models';
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
  it('bench/budget.json validates and is sized for 4 tasks × 3 runs × 2 models × 2 modes', () => {
    const b = BudgetSchema.parse(budgetJson);
    expect(b.monthlyUsd).toBe(0);
    expect(b.perGateMaxUsd).toBe(0);
    expect(b.perGateMaxRollouts).toBe(4 * 3 * 2 * 2);
    expect(b.perGateMaxRequests).toBe(b.perGateMaxRollouts * 10);
    expect(b.splitAcrossDays).toBe(true);
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
    expect(r.fallbackUsed).toBe(true);
    expect(r.usage).toEqual({
      promptTokens: 3,
      candidateTokens: 2,
      thoughtTokens: 0,
      totalTokens: 5,
    });
    expect(r.attempts.map((a) => a.status)).toEqual([503, 503, 'network', 429, 200]);
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
    expect(e.locations).toEqual(['contents[1].parts[0].functionResponse']);
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
