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

/** Serialize an MCP tool result to text the judge can score. */
function resultText(res: unknown): string {
  const r = res as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  if (Array.isArray(r.content)) {
    return r.content
      .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(res);
}

/** Default judge — an LLM scores the result against the rubric (1–5 + pass + reason).
 * Optional deps (@anthropic-ai/sdk) + ANTHROPIC_API_KEY; lazy so the common path stays light. */
export function llmJudge(model: string): Judge {
  return async ({ rubric, result }) => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const sdkName = '@anthropic-ai/sdk';
    const Anthropic = (
      (await import(sdkName)) as {
        default: new (o: { apiKey: string; timeout?: number; maxRetries?: number }) => {
          messages: {
            create(b: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
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
        'You are a strict evaluation judge. Score how well RESULT satisfies RUBRIC on a 1–5 scale ' +
        '(5 = fully satisfies). Reply ONLY with JSON: {"score": <1-5>, "pass": <bool>, "reason": "<short>"}.',
      messages: [{ role: 'user', content: `RUBRIC:\n${rubric}\n\nRESULT:\n${result}` }],
    });
    const text = resp.content.find((b) => b.type === 'text')?.text ?? '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error(`judge returned no JSON: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(json[0]) as JudgeResult;
    return { score: Number(parsed.score) || 0, pass: Boolean(parsed.pass), reason: parsed.reason };
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
  const score = judge ?? llmJudge(spec.model ?? 'claude-sonnet-4-6');
  const checks: VerifyCheck[] = [];

  const client = new Client({ name: 'greenlight-verify', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  try {
    await client.connect(transport);
  } catch (e) {
    return report('eval', baseUrl, [{ name: 'initialize handshake', pass: false, detail: msg(e) }]);
  }

  try {
    for (const c of spec.cases) {
      const min = c.minScore ?? 4;
      try {
        const res = await client.callTool({ name: c.tool, arguments: c.args ?? {} });
        const verdict = await score({ rubric: c.rubric, result: resultText(res) });
        const pass = verdict.pass && verdict.score >= min;
        checks.push({
          name: `eval: ${c.name}`,
          pass,
          detail: `score ${verdict.score}/5 (min ${min})${verdict.reason ? ` — ${verdict.reason}` : ''}`,
        });
      } catch (e) {
        checks.push({ name: `eval: ${c.name}`, pass: false, detail: msg(e) });
      }
    }
  } finally {
    await client.close();
  }

  return report('eval', baseUrl, checks);
}
