import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type EvalSpec,
  type Judge,
  type JudgeResult,
  type VerifyCheck,
  type VerifyReport,
  msg,
  report,
} from './types';

/** Max chars of a tool result fed into the judge prompt. A tool can return an arbitrarily large
 * payload; without a cap that flows straight into the judge's INPUT tokens (max_tokens only bounds
 * its output). 8 KB is ample for a rubric judgement; the marker keeps the truncation visible. */
const MAX_RESULT_CHARS = 8000;

/** Serialize an MCP tool result to text the judge can score (length-capped — see MAX_RESULT_CHARS). */
function resultText(res: unknown): string {
  const r = res as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  let text: string;
  if (r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  else if (Array.isArray(r.content)) {
    text = r.content
      .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
      .join('\n');
  } else text = JSON.stringify(res);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]`
    : text;
}

/** Clamp a judge score into the standard [0,1] band (1 = perfect). A stray legacy 1–5 reply clamps
 * to 1 rather than silently sailing past a 0..1 `minScore`; a non-number → 0. */
export const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
};

/** Default judge — an LLM scores the result against the rubric in [0,1] + pass + rationale (v0.6.0;
 * was a 1–5 scale before). Optional deps (@anthropic-ai/sdk) + ANTHROPIC_API_KEY; lazy so the common
 * path stays light. */
export function llmJudge(model: string): Judge {
  return async ({ rubric, result }) => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const sdkName = '@anthropic-ai/sdk';
    const Anthropic = (
      (await import(sdkName)) as {
        default: new (o: { apiKey: string; timeout?: number; maxRetries?: number }) => {
          messages: {
            create(b: unknown): Promise<{
              content: Array<{ type: string; text?: string }>;
              usage?: { input_tokens?: number; output_tokens?: number };
            }>;
          };
        };
      }
    ).default;
    // Bound the judge call (60s, one retry) so a hung request can't stall the gate.
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60_000,
      maxRetries: 1,
    });
    const resp = await client.messages.create({
      model,
      max_tokens: 512,
      system:
        'You are a strict evaluation judge. Score how well RESULT satisfies RUBRIC on a 0..1 scale ' +
        '(1 = fully satisfies). Reply ONLY with JSON: {"score": <0..1>, "pass": <bool>, "rationale": "<one sentence>"}.',
      messages: [{ role: 'user', content: `RUBRIC:\n${rubric}\n\nRESULT:\n${result}` }],
    });
    const text = resp.content.find((b) => b.type === 'text')?.text ?? '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error(`judge returned no JSON: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(json[0]) as JudgeResult;
    return {
      score: clamp01(parsed.score),
      pass: Boolean(parsed.pass),
      rationale: parsed.rationale ?? parsed.reason, // `reason` = deprecated alias, one release
      tokensIn: resp.usage?.input_tokens,
      tokensOut: resp.usage?.output_tokens,
    };
  };
}

/**
 * eval mode — call each MCP tool and have a judge score its result against a rubric. The
 * judge is injectable (a deterministic judge for tests/CI; the default LLM judge otherwise).
 * A judge error (e.g. no API key) becomes a failing check — the gate is honest it could not
 * score rather than throwing.
 */
export async function verifyEval(
  baseUrl: string,
  spec: EvalSpec,
  judge?: Judge,
): Promise<VerifyReport> {
  const model = spec.model ?? 'claude-sonnet-4-6';
  const score = judge ?? llmJudge(model);
  const checks: VerifyCheck[] = [];
  const started = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;

  const client = new Client({ name: 'greenlight-verify', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  try {
    await client.connect(transport);
  } catch (e) {
    return report('eval', baseUrl, [{ name: 'initialize handshake', pass: false, detail: msg(e) }]);
  }

  try {
    for (const c of spec.cases) {
      const min = c.minScore ?? 0.8;
      try {
        const res = await client.callTool({ name: c.tool, arguments: c.args ?? {} });
        const result = resultText(res);
        const verdict = await score({ rubric: c.rubric, result });
        const pass = verdict.pass && verdict.score >= min;
        const rationale = verdict.rationale ?? verdict.reason;
        tokensIn += verdict.tokensIn ?? 0;
        tokensOut += verdict.tokensOut ?? 0;
        checks.push({
          name: `eval: ${c.name}`,
          pass,
          score: verdict.score,
          explanation: rationale,
          output: result,
          detail: `score ${verdict.score.toFixed(2)} (min ${min})${rationale ? ` — ${rationale}` : ''}`,
        });
      } catch (e) {
        checks.push({ name: `eval: ${c.name}`, pass: false, detail: msg(e) });
      }
    }
  } finally {
    await client.close();
  }

  // Run metadata for the `--json` export (best-effort; tokens are 0 with a deterministic test judge).
  return {
    ...report('eval', baseUrl, checks),
    model,
    durationMs: Date.now() - started,
    ...(tokensIn || tokensOut ? { tokensIn, tokensOut } : {}),
  };
}
