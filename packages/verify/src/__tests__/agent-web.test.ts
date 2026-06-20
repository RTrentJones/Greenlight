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

  it('fails clearly when the optional @anthropic-ai/sdk is absent (key present)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const r = await verify('https://example.dev', spec);
    // playwright is installed; the SDK is an un-installed optional dep, so the gate is
    // honest that it could not validate rather than throwing.
    expect(r.pass).toBe(false);
    expect(r.checks.some((c) => c.name.includes('@anthropic-ai/sdk'))).toBe(true);
  });
});
