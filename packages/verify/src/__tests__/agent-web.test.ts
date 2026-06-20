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

  it('degrades honestly (fails, names a missing optional dep) when a key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const r = await verify('https://example.dev', spec);
    // The SDK is an un-installed optional dep, so the gate is honest that it could not
    // validate rather than throwing. (Robust to whichever optional dep is reported first.)
    expect(r.pass).toBe(false);
    expect(r.checks.some((c) => /@anthropic-ai\/sdk|playwright/.test(c.name))).toBe(true);
  });
});
