import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelsConfigSchema } from '../../schema';
import { clientForRole, createLimiters } from '../models';
import { runReact } from '../react';

// ONE live smoke test against the real Gemini API (small model, a tiny tool-use task: about two
// requests). Skipped unless GREENLIGHT_LIVE_GEMINI=1, so CI never spends the shared free-tier quota.
// Needs either GEMINI_API_KEY or a key-injecting egress proxy; behind a proxy, Node's fetch also
// needs NODE_USE_ENV_PROXY=1 (see bench/README-models.md).
const live = process.env.GREENLIGHT_LIVE_GEMINI === '1';

describe.skipIf(!live)('live: gemini harness smoke', () => {
  it('gemini-3.6-flash completes a one-tool task through finish', async () => {
    const root = resolve(__dirname, '../../../../..');
    const config = ModelsConfigSchema.parse(
      JSON.parse(readFileSync(resolve(root, 'bench/models.json'), 'utf8')),
    );
    const client = clientForRole(config, 'small', {
      findSecrets: () => [],
      limiters: createLimiters(config),
    });
    const r = await runReact({
      client,
      skills: [],
      rolePrompt: 'You answer arithmetic questions using the provided tools only.',
      task: 'What is 17 multiplied by 23? Use the multiply tool, then call finish with the product.',
      tools: [
        {
          name: 'multiply',
          description: 'Multiplies two integers and returns the product.',
          parameters: {
            type: 'object',
            properties: { a: { type: 'integer' }, b: { type: 'integer' } },
            required: ['a', 'b'],
          },
          run: (a) => (a.a as number) * (a.b as number),
        },
      ],
      finish: {
        description: 'Submit the final answer.',
        parameters: {
          type: 'object',
          properties: { product: { type: 'integer' } },
          required: ['product'],
        },
        schema: z.object({ product: z.number().int() }),
      },
      maxSteps: 4,
      callTimeoutMs: 60_000,
    });
    console.log(
      JSON.stringify({
        ok: r.ok,
        result: r.result,
        error: r.error,
        servedBy: r.servedBy,
        requests: r.requests,
        usage: r.usage,
        kinds: r.transcript.map((e) => e.kind),
      }),
    );
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ product: 391 });
    expect(r.servedBy).toEqual(['gemini-3.6-flash']);
  }, 180_000);
});
