import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The agent-lane template Worker (scaffolded by `greenlight add --lane agent`), driven through its
// real fetch handler: POST /run seeds a generation, GET /status reports it. Loaded via a computed
// path so the CLI's tsc doesn't pull in the Worker's Cloudflare ambient types (KVNamespace, …).
const TEMPLATE = new URL('../../../tools/_template-agent/src/index.ts', import.meta.url).href;
type Worker = { fetch(req: Request, env: unknown): Promise<Response> };
const worker = ((await import(TEMPLATE)) as { default: Worker }).default;

// A status code, a network error before the headers ('throw'), or a 200 whose body read fails
// mid-stream ('body-drop').
type Step = number | 'throw' | 'body-drop';

const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' a tip ' }] } }] }), {
    status: 200,
  });

function kv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
  };
}

async function run(script: Step[]) {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    const step = script[calls++];
    if (step === 'throw') throw new TypeError('network');
    if (step === 'body-drop') {
      const body = new ReadableStream({ pull: (c) => c.error(new TypeError('terminated')) });
      return new Response(body, { status: 200 });
    }
    return step === 200 ? ok() : new Response('x', { status: step });
  });
  const env = {
    MODEL: 'm',
    GEMINI_API_KEY: 'SECRETKEY',
    RUN_TOKEN: 't',
    GREENLIGHT_ENV: 'beta',
    STATE: kv(),
  };
  const res = await worker.fetch(
    new Request('https://x/run', { method: 'POST', headers: { authorization: 'Bearer t' } }),
    env,
  );
  const body = await res.text();
  const status = (await (await worker.fetch(new Request('https://x/status'), env)).json()) as {
    ok: boolean;
    lastError: string | null;
  };
  return { http: res.status, calls, status, body };
}

describe('agent template: Gemini call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  // Fake timers + runAllTimersAsync: the backoff sleeps resolve instantly.
  const settle = async <T>(p: Promise<T>) => {
    await vi.runAllTimersAsync();
    return p;
  };

  it.each<[string, Step[], number]>([
    ['a transient 503 (the prod failure)', [503, 503, 200], 3],
    ['a 429 rate limit', [429, 200], 2],
    ['a network error', ['throw', 200], 2],
    ['a 408 request timeout', [408, 200], 2],
    ['a connection dropped mid-body', ['body-drop', 200], 2],
  ])('recovers from %s', async (_, script, calls) => {
    const r = await settle(run(script));
    expect(r).toMatchObject({ http: 200, calls, status: { ok: true, lastError: null } });
  });

  it('gives up after 3 attempts and reports it', async () => {
    const r = await settle(run([503, 503, 503]));
    expect(r).toMatchObject({
      http: 502,
      calls: 3,
      status: { ok: false, lastError: 'Gemini HTTP 503 (after 3 attempts)' },
    });
  });

  it.each([404, 403, 400])('fails fast on a non-transient %i (no retry)', async (code) => {
    const r = await settle(run([code]));
    expect(r).toMatchObject({
      http: 502,
      calls: 1,
      status: { ok: false, lastError: `Gemini HTTP ${code}` },
    });
  });

  it('never leaks the API key (it rides in the request URL)', async () => {
    const r = await settle(run(['throw', 'throw', 'throw']));
    expect(r.status.lastError).toBe('Gemini unreachable: TypeError (after 3 attempts)');
    expect(JSON.stringify(r)).not.toContain('SECRETKEY');
  });
});
