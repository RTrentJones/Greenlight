import { describe, expect, it } from 'vitest';
import { emitAgentDeployWorkflow } from '../agent-deploy';

describe('emitAgentDeployWorkflow', () => {
  it('parameterizes by tool + domain with account-id + KV as code, secrets, seed, verify', () => {
    const wf = emitAgentDeployWorkflow('muse', 'example.dev');
    expect(wf).toContain('name: deploy-muse');
    expect(wf).toContain("paths: ['tools/muse/**']");
    // account id as code: resolved from the domain's zone in CI + injected (no local secrets — v0.4.0)
    expect(wf).toContain('zones?name=example.dev');
    expect(wf).toContain('REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID');
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
