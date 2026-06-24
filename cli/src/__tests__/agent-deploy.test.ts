import { describe, expect, it, vi } from 'vitest';
import { emitAgentDeployWorkflow, resolveCloudflareAccountId } from '../agent-deploy';

describe('emitAgentDeployWorkflow', () => {
  it('parameterizes by tool name + domain with the KV-as-code + secrets + seed + verify steps', () => {
    const wf = emitAgentDeployWorkflow('muse', 'example.dev');
    expect(wf).toContain('name: deploy-muse');
    expect(wf).toContain("paths: ['tools/muse/**']");
    // KV namespace as code (find-or-create, scoped to this tool)
    expect(wf).toContain('wrangler kv namespace create STATE');
    expect(wf).toContain('test("muse.*STATE")');
    expect(wf).toContain('wrangler secret put GEMINI_API_KEY --env prod');
    expect(wf).toContain('https://muse.example.dev/run'); // seed
    expect(wf).toContain('greenlight verify muse --env prod');
    // GitHub Actions secret refs survive the JS template (not interpolated away)
    expect(wf).toContain('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(wf).toContain('${{ secrets.GEMINI_API_KEY }}');
  });
});

describe('resolveCloudflareAccountId', () => {
  it('returns the account id from the domain zone', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: [{ account: { id: 'acct_123' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveCloudflareAccountId('example.dev', 't')).toBe('acct_123');
    vi.unstubAllGlobals();
  });

  it('returns null on a non-ok response (add falls back to a placeholder)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    expect(await resolveCloudflareAccountId('example.dev', 't')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns null when fetch throws (network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await resolveCloudflareAccountId('example.dev', 't')).toBeNull();
    vi.unstubAllGlobals();
  });
});
