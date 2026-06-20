import { afterEach, describe, expect, it, vi } from 'vitest';
import { verify } from '../index';
import type { AgentWebSpec } from '../types';

const spec: AgentWebSpec = {
  mode: 'agent-web',
  scenarios: [{ name: 'smoke', task: 'open the home page', asserts: [{ urlContains: '/' }] }],
};

afterEach(() => vi.unstubAllEnvs());

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
