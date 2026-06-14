import { describe, expect, it } from 'vitest';
import { servePlan } from '../commands/preview';

describe('servePlan', () => {
  it('serves mcp via `start` on 8787 and verifies /mcp', () => {
    expect(servePlan('mcp')).toEqual({ build: false, script: 'start', port: 8787, path: '/mcp' });
  });

  it('builds + serves web lanes via `preview` on 4321 at the root', () => {
    expect(servePlan('astro')).toEqual({ build: true, script: 'preview', port: 4321, path: '' });
    expect(servePlan('next')).toEqual({ build: true, script: 'preview', port: 4321, path: '' });
  });

  it('honors a custom port', () => {
    expect(servePlan('mcp', 9000).port).toBe(9000);
    expect(servePlan('astro', 5050).port).toBe(5050);
  });
});
