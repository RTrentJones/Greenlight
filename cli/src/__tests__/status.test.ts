import { describe, expect, it } from 'vitest';
import { workflowsFor } from '../commands/status';
import type { ResolvedEntry } from '../manifest';

const entry = (over: Partial<ResolvedEntry>): ResolvedEntry => ({
  name: 'x',
  lane: 'mcp',
  target: 'oci',
  data: 'none',
  dir: 'tools/x',
  external: true,
  ...over,
});

describe('workflowsFor', () => {
  it('oci external → build on the tool repo, deploy + self-heal on the wrapper', () => {
    const w = workflowsFor(entry({ name: 'bamcp' }), 'bamcp', 'o/wrap', 'o/bamcp');
    expect(w.map((x) => x.workflow)).toEqual([
      'greenlight-build.yml',
      'greenlight-deploy-bamcp.yml',
      'greenlight-remediate-bamcp.yml',
    ]);
    expect(w[0]?.repo).toBe('o/bamcp'); // build runs in the tool repo
    expect(w[1]?.repo).toBe('o/wrap'); // deploy runs in the wrapper
  });

  it('vercel external → verify on the tool repo (deployment_status)', () => {
    const w = workflowsFor(
      entry({ lane: 'next', target: 'vercel' }),
      'heistmind',
      'o/wrap',
      'o/hm',
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.workflow).toBe('greenlight-verify.yml');
    expect(w[0]?.repo).toBe('o/hm');
  });

  it('local tool → the wrapper deploy workflow', () => {
    const w = workflowsFor(
      entry({ lane: 'astro', target: 'workers', external: false }),
      'blog',
      'o/wrap',
      'o/wrap',
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.workflow).toBe('deploy.yml');
    expect(w[0]?.repo).toBe('o/wrap');
  });
});
