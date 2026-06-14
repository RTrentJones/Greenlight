import { describe, expect, it } from 'vitest';
import { resolveUrl } from '../url';

describe('resolveUrl', () => {
  it('resolves blog (apex) prod + beta', () => {
    expect(resolveUrl({ domain: 'example.dev', env: 'prod' })).toBe('https://example.dev');
    expect(resolveUrl({ domain: 'example.dev', env: 'beta' })).toBe('https://beta.example.dev');
  });

  it('resolves a tool (subdomain) prod + beta', () => {
    expect(resolveUrl({ domain: 'example.dev', name: 'notes', env: 'prod' })).toBe(
      'https://notes.example.dev',
    );
    expect(resolveUrl({ domain: 'example.dev', name: 'notes', env: 'beta' })).toBe(
      'https://beta.notes.example.dev',
    );
  });

  it('appends /mcp for an mcp connect url', () => {
    expect(resolveUrl({ domain: 'example.dev', name: 'bamcp', env: 'prod', mcp: true })).toBe(
      'https://bamcp.example.dev/mcp',
    );
    expect(resolveUrl({ domain: 'example.dev', name: 'bamcp', env: 'beta', mcp: true })).toBe(
      'https://beta.bamcp.example.dev/mcp',
    );
  });

  it('throws for preview (per-target, not deterministic)', () => {
    expect(() => resolveUrl({ domain: 'example.dev', name: 'x', env: 'preview' })).toThrow(
      /preview/i,
    );
  });
});
