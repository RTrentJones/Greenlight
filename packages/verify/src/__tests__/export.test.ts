import { describe, expect, it } from 'vitest';
import { toExportResult } from '../export';
import type { VerifyReport } from '../types';

// The asserted key names here are the v1 CONTRACT a consumer's OpenInference ingest adapter maps
// from: dotted `eval.score`/`eval.explanation` per check, `gen_ai.*` run attributes, discriminated by
// the `checks` array. A consumer's adapter pins the same shape with a shared golden fixture.
const evalReport: VerifyReport = {
  mode: 'eval',
  url: 'https://x.dev/mcp',
  pass: true,
  model: 'claude-opus-4-8',
  tokensIn: 1500,
  tokensOut: 800,
  durationMs: 4200,
  checks: [
    {
      name: 'eval: summarize',
      pass: true,
      score: 0.95,
      explanation: 'faithful; names both changes',
      output: 'a summary',
    },
  ],
};
const apiReport: VerifyReport = {
  mode: 'api',
  url: 'https://x.dev',
  pass: false,
  checks: [
    { name: 'GET /', pass: true },
    { name: 'GET /missing', pass: false, detail: '404' },
  ],
};

describe('toExportResult — standards-shaped verify export (v1)', () => {
  it('flattens checks, derives 1.0/0.0 for non-eval, merges attributes, matches the v1 contract', () => {
    const r = toExportResult([evalReport, apiReport], {
      tool: 'tracer',
      env: 'beta',
      gitSha: 'abc1234',
    });
    expect(r.schemaVersion).toBe('1');
    expect(r.tool).toBe('tracer');
    expect(r.env).toBe('beta');
    expect(r.git_sha).toBe('abc1234');
    expect(r.mode).toBe('eval+api'); // joined modes for a multi-spec run
    expect(r.passed).toBe(false); // allPass: the api report failed
    expect(r.duration_ms).toBe(4200);

    // OTel-GenAI run attributes from the eval report
    expect(r.attributes?.['gen_ai.request.model']).toBe('claude-opus-4-8');
    expect(r.attributes?.['gen_ai.usage.input_tokens']).toBe(1500);
    expect(r.attributes?.['gen_ai.usage.output_tokens']).toBe(800);

    // checks: OpenInference dotted keys + scores
    expect(r.checks).toHaveLength(3);
    const summarize = r.checks.find((c) => c.name === 'eval: summarize');
    expect(summarize?.['eval.score']).toBe(0.95);
    expect(summarize?.['eval.explanation']).toBe('faithful; names both changes');
    expect(summarize?.output).toBe('a summary');
    expect(r.checks.find((c) => c.name === 'GET /')?.['eval.score']).toBe(1); // derived from pass
    const bad = r.checks.find((c) => c.name === 'GET /missing');
    expect(bad?.['eval.score']).toBe(0);
    expect(bad?.passed).toBe(false);

    expect(r.pass_rate).toBeCloseTo(2 / 3); // 2 of 3 checks passed
  });

  it('omits attributes and nulls git_sha when no run metadata is present (api-only)', () => {
    const r = toExportResult([apiReport], { tool: 't', env: 'prod' });
    expect(r.attributes).toBeUndefined();
    expect(r.mode).toBe('api');
    expect(r.git_sha).toBeNull();
  });

  it('clamps an out-of-band eval score into [0,1]', () => {
    const weird: VerifyReport = {
      mode: 'eval',
      url: 'u',
      pass: true,
      checks: [{ name: 'x', pass: true, score: 5 }],
    };
    expect(toExportResult([weird], { tool: 't', env: 'prod' }).checks[0]?.['eval.score']).toBe(1);
  });
});
