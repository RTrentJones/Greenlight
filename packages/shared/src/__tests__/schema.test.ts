import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../schema';

const base = {
  domain: 'example.dev',
  alerts: { sink: 'github-issue' },
  blog: { lane: 'astro', target: 'workers', data: 'none' },
  tools: [],
} as const;

describe('ConfigSchema', () => {
  it('accepts a valid minimal config and applies tool defaults', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'astro', target: 'workers', data: 'none', envs: ['prod'] }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tools[0]?.auth).toBe('none');
      expect(r.data.tools[0]?.access).toBe('public');
      expect(r.data.tools[0]?.adopted).toBe(false);
    }
  });

  it('rejects a malformed domain (quotes/spaces would break emitted HCL/curl/jq)', () => {
    for (const domain of ['no-tld', 'has space.dev', 'evil".dev', 'http://example.dev']) {
      expect(ConfigSchema.safeParse({ ...base, domain }).success).toBe(false);
    }
    // A normal multi-label hostname is still accepted.
    expect(ConfigSchema.safeParse({ ...base, domain: 'app.example.dev' }).success).toBe(true);
  });

  it('rejects a blog backed by supabase (it pauses; blog must stay up)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      blog: { lane: 'astro', target: 'workers', data: 'supabase' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects mcp on vercel (out of matrix)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'mcp', target: 'vercel', data: 'none', envs: ['prod'] }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts mcp on docker (a self-hosted container target)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'mcp', target: 'docker', data: 'none', envs: ['prod'] }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects next on docker (out of matrix — docker is mcp-only)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'next', target: 'docker', data: 'none', envs: ['prod'] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects next not on vercel (out of matrix)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'next', target: 'workers', data: 'supabase', envs: ['prod'] }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts an agent on workers with kv', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'muse', lane: 'agent', target: 'workers', data: 'kv', envs: ['prod'] }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an agent on vercel (out of matrix — agent is workers-only)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'muse', lane: 'agent', target: 'vercel', data: 'kv', envs: ['prod'] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an agent with supabase data (out of matrix)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'muse', lane: 'agent', target: 'workers', data: 'supabase', envs: ['prod'] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a private tool with auth none', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [
        {
          name: 'x',
          lane: 'mcp',
          target: 'oci',
          data: 'none',
          access: 'private',
          auth: 'none',
          envs: ['prod'],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts both BAMCP (mcp→oci) and a throwaway (mcp→workers)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [
        { name: 'bamcp', lane: 'mcp', target: 'oci', data: 'none', envs: ['beta', 'prod'] },
        {
          name: 'throwaway',
          lane: 'mcp',
          target: 'workers',
          data: 'none',
          envs: ['preview', 'beta'],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-kebab-case tool name', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'Bad_Name', lane: 'astro', target: 'workers', data: 'none', envs: ['prod'] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a tool with no envs', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'astro', target: 'workers', data: 'none', envs: [] }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a blog-less, tool-only manifest (poly-repo consumer)', () => {
    const { blog: _blog, ...noBlog } = base;
    const r = ConfigSchema.safeParse({
      ...noBlog,
      tools: [
        { name: 'bamcp', lane: 'mcp', target: 'oci', data: 'none', dir: '.', envs: ['prod'] },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.blog).toBeUndefined();
      expect(r.data.tools[0]?.dir).toBe('.');
      expect(r.data.tools[0]?.external).toBe(false);
    }
  });

  it('accepts an external registry entry (code lives in another repo)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [
        { name: 'bamcp', lane: 'mcp', target: 'oci', data: 'none', external: true, envs: ['prod'] },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tools[0]?.external).toBe(true);
  });

  it('accepts a preview descriptor (the local pre-deploy gate for targets with no built-in serve)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [
        {
          name: 'bamcp',
          lane: 'mcp',
          target: 'oci',
          data: 'none',
          external: true,
          envs: ['prod'],
          preview: {
            command: 'docker compose --profile preview up',
            teardown: 'docker compose --profile preview down -v',
            port: 8000,
            path: '/mcp',
          },
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tools[0]?.preview?.port).toBe(8000);
  });

  describe('shared data store (dataShareWith — multiple services on one Neon DB)', () => {
    const neon = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      lane: 'next',
      target: 'vercel',
      data: 'neon',
      envs: ['beta', 'prod'],
      ...extra,
    });
    const ok = (tools: unknown[]) => ConfigSchema.safeParse({ ...base, tools }).success;

    it('accepts a sharer pointing at a matching neon owner', () => {
      expect(ok([neon('app'), neon('worker', { dataShareWith: 'app' })])).toBe(true);
    });
    it('rejects a missing owner', () => {
      expect(ok([neon('worker', { dataShareWith: 'nope' })])).toBe(false);
    });
    it('rejects sharing with itself', () => {
      expect(ok([neon('app', { dataShareWith: 'app' })])).toBe(false);
    });
    it('rejects a chain (the owner is itself a sharer)', () => {
      expect(
        ok([
          neon('root'),
          neon('mid', { dataShareWith: 'root' }),
          neon('leaf', { dataShareWith: 'mid' }),
        ]),
      ).toBe(false);
    });
    it('rejects a neon sharer pointing at a non-neon owner', () => {
      const supa = {
        name: 'app',
        lane: 'next',
        target: 'vercel',
        data: 'supabase',
        envs: ['prod'],
      };
      expect(ok([supa, neon('worker', { dataShareWith: 'app' })])).toBe(false);
    });
    it('rejects a sharer that also overrides the Neon account', () => {
      expect(
        ok([
          neon('app'),
          neon('worker', { dataShareWith: 'app', tokenOverrides: { NEON_API_KEY: 'X' } }),
        ]),
      ).toBe(false);
    });
    it('rejects dataShareWith on a non-neon tool', () => {
      expect(
        ok([
          {
            name: 'x',
            lane: 'next',
            target: 'vercel',
            data: 'supabase',
            envs: ['prod'],
            dataShareWith: 'y',
          },
        ]),
      ).toBe(false);
    });
  });
});
