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

  it('rejects next not on vercel (out of matrix)', () => {
    const r = ConfigSchema.safeParse({
      ...base,
      tools: [{ name: 'x', lane: 'next', target: 'workers', data: 'supabase', envs: ['prod'] }],
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
});
