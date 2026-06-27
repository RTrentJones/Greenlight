import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScenario } from '../agent-web';
import { verify } from '../index';
import type { AgentWebScenario, AgentWebSpec } from '../types';

const spec: AgentWebSpec = {
  mode: 'agent-web',
  scenarios: [{ name: 'smoke', task: 'open the home page', asserts: [{ urlContains: '/' }] }],
};

afterEach(() => vi.unstubAllEnvs());

/** A minimal Playwright Page stub. `clickFails` makes every browser_click reject (→ an "error:"
 * tool result), which drives the stuck-loop guard. `ariaSnapshot` is non-empty so snapshots succeed. */
function fakePage(opts: { clickFails?: boolean } = {}): Page {
  const locator = {
    ariaSnapshot: async () => 'page snapshot',
    innerText: async () => 'body text',
    count: async () => 1,
  };
  const element = {
    click: async () => {
      if (opts.clickFails) throw new Error('no such element');
    },
    fill: async () => {},
    press: async () => {},
  };
  return {
    goto: async () => null,
    url: () => 'https://example.dev/',
    locator: () => locator,
    getByRole: () => ({ first: () => element }),
  } as unknown as Page;
}

/** An Anthropic-client stub that returns the same tool_use every step (never finishes), recording
 * how many times it was called and the message-history length it saw on each call. `usage` lets a
 * test drive the token-budget path. */
function fakeClient(toolName: string, input: Record<string, unknown>, usage = { i: 0, o: 0 }) {
  const historyLengths: number[] = [];
  let calls = 0;
  const client = {
    messages: {
      create: async (body: unknown) => {
        calls++;
        historyLengths.push((body as { messages: unknown[] }).messages.length);
        return {
          content: [{ type: 'tool_use', id: `t${calls}`, name: toolName, input }],
          usage: { input_tokens: usage.i, output_tokens: usage.o },
        };
      },
    },
  };
  return {
    client,
    get calls() {
      return calls;
    },
    historyLengths,
  };
}

const scenario: AgentWebScenario = { name: 'loop', task: 'do the thing' };

describe('runScenario bounds (token usage)', () => {
  it('short-circuits after maxRepeats identical FAILING actions instead of using all maxSteps', async () => {
    const f = fakeClient('browser_click', { role: 'button', name: 'Go' });
    const r = await runScenario(
      f.client,
      fakePage({ clickFails: true }),
      'https://example.dev',
      { mode: 'agent-web', scenarios: [scenario], maxSteps: 12, maxRepeats: 3 },
      scenario,
    );
    expect(f.calls).toBe(3); // stopped at the 3rd identical failure, not 12
    expect(r.checks.some((c) => c.detail?.includes('stuck repeating'))).toBe(true);
  });

  it('stops at the token budget and reports it', async () => {
    const f = fakeClient('browser_click', { role: 'button', name: 'Go' }, { i: 8, o: 8 });
    const r = await runScenario(
      f.client,
      fakePage({ clickFails: true }),
      'https://example.dev',
      { mode: 'agent-web', scenarios: [scenario], maxSteps: 12, maxTokens: 10 },
      scenario,
    );
    expect(f.calls).toBe(1); // 16 tokens after one call ≥ budget → no second call
    expect(r.checks.some((c) => c.name.includes('token budget'))).toBe(true);
  });

  it('clips the message history to the sliding window (input tokens stay bounded)', async () => {
    // browser_snapshot succeeds (not an error), so the repeat guard never trips — the run goes the
    // full maxSteps and we can observe the history window holding.
    const f = fakeClient('browser_snapshot', {});
    await runScenario(
      f.client,
      fakePage(),
      'https://example.dev',
      { mode: 'agent-web', scenarios: [scenario], maxSteps: 8, historyWindow: 2 },
      scenario,
    );
    // keep = historyWindow*2 = 4; the task message is always retained → max length keep+1 = 5.
    expect(Math.max(...f.historyLengths)).toBeLessThanOrEqual(5);
  });
});

describe('verifyAgentWeb guards', () => {
  it('dispatches through verify() and fails clearly without an API key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const r = await verify('https://example.dev', spec);
    expect(r.mode).toBe('agent-web');
    expect(r.pass).toBe(false);
    expect(r.checks[0]?.name).toContain('ANTHROPIC_API_KEY');
  });

  it('degrades honestly (failing report, never throws) when a key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const r = await verify('https://example.dev', spec);
    // With a key but no usable browser/SDK, the gate must return a FAILING report rather than
    // throw. The specific failing check varies by environment (which optional dep / browser is
    // present), so assert the invariant: agent-web mode, not passing, and every check failed.
    expect(r.mode).toBe('agent-web');
    expect(r.pass).toBe(false);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c) => !c.pass)).toBe(true);
  });
});
