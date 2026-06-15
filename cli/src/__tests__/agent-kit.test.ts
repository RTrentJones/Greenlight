import { describe, expect, it } from 'vitest';
import { mergeMcpServers, recommendedMcp } from '../agent-kit';

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

  it('carries a full server descriptor (headers) through unchanged', () => {
    const r = mergeMcpServers(null, {
      supabase: { type: 'http', url: 'https://s/mcp', headers: { Authorization: 'Bearer x' } },
    });
    expect(r.mcpServers.supabase?.headers?.Authorization).toBe('Bearer x');
  });
});

describe('recommendedMcp', () => {
  it('recommends Cloudflare for any tool (and nothing provider-specific by default)', () => {
    const r = recommendedMcp();
    expect(Object.keys(r).sort()).toEqual(['cloudflare', 'cloudflare-docs']);
  });

  it('adds Vercel for a vercel target and Supabase (with auth header) for supabase data', () => {
    const r = recommendedMcp({ target: 'vercel', data: 'supabase' });
    expect(Object.keys(r)).toContain('vercel');
    const supabase = r.supabase;
    expect(typeof supabase).toBe('object');
    if (typeof supabase === 'object') {
      expect(supabase.url).toContain('read_only=true');
      expect(supabase.headers?.Authorization).toContain('SUPABASE_ACCESS_TOKEN');
    }
  });

  it('does not add Supabase for a non-supabase tool', () => {
    expect(recommendedMcp({ target: 'workers', data: 'none' }).supabase).toBeUndefined();
  });
});
