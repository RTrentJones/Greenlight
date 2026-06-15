import { describe, expect, it } from 'vitest';
import { mergeMcpServers } from '../agent-kit';

describe('mergeMcpServers', () => {
  it('adds recommended servers to an empty/absent config', () => {
    const r = mergeMcpServers(null, { cloudflare: 'https://x/mcp' });
    expect(r.mcpServers.cloudflare).toEqual({ type: 'http', url: 'https://x/mcp' });
  });

  it('preserves existing servers and adds new ones', () => {
    const existing = { mcpServers: { custom: { type: 'http', url: 'https://custom/mcp' } } };
    const r = mergeMcpServers(existing, { cloudflare: 'https://x/mcp' });
    expect(Object.keys(r.mcpServers).sort()).toEqual(['cloudflare', 'custom']);
  });

  it('does not overwrite an existing server with the same name', () => {
    const existing = { mcpServers: { cloudflare: { type: 'http', url: 'https://mine/mcp' } } };
    const r = mergeMcpServers(existing, { cloudflare: 'https://x/mcp' });
    expect(r.mcpServers.cloudflare?.url).toBe('https://mine/mcp');
  });
});
