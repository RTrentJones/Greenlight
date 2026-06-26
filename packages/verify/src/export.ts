import type { VerifyReport } from './types';

/**
 * Standards-shaped verify export (OTel-GenAI / OpenInference). Generic and backend-agnostic: any
 * eval/observability backend (an eval dashboard's ingest endpoint, Langfuse, Phoenix, an OTLP
 * exporter) reads this shape. It is the machine-readable equivalent of the human report `verify`
 * prints — emitted by `verify --json`.
 *
 * The schema is discriminated by the `checks` array, with dotted OpenInference keys
 * (`eval.score`/`eval.explanation`) per check and OTel-GenAI run `attributes`. Unknown keys are
 * ignored downstream, so the schema grows additively. v1 is the stable contract a consumer's ingest
 * adapter maps from.
 */
export interface VerifyExportCheck {
  name: string;
  passed: boolean;
  input?: string | null;
  expected?: string | null;
  output?: string | null;
  'eval.score'?: number | null; // 0..1
  'eval.explanation'?: string | null;
}

export interface VerifyExportResult {
  schemaVersion: '1';
  tool: string;
  mode: string; // the verify mode, or modes joined with '+' for a multi-spec run
  env: string;
  git_sha: string | null;
  passed: boolean;
  pass_rate: number; // 0..1
  duration_ms: number | null;
  attributes?: {
    'gen_ai.request.model'?: string;
    'gen_ai.usage.input_tokens'?: number;
    'gen_ai.usage.output_tokens'?: number;
    'gen_ai.response.cost'?: number;
  };
  checks: VerifyExportCheck[];
}

export interface ExportContext {
  tool: string;
  env: string;
  gitSha?: string | null;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Sum the defined numbers; undefined if none are defined (so an all-absent metric is omitted, not
 * reported as a misleading 0). */
function sumDefined(xs: Array<number | undefined>): number | undefined {
  const present = xs.filter((x): x is number => typeof x === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Combine the (possibly multiple) reports of one `verifyAll` run into a single standards-shaped
 * result: all checks flattened, a per-check `eval.score` derived 1.0/0.0 from `pass` when a mode
 * produced none (api/test/mcp/playwright), and run `attributes` merged from the LLM-driven modes
 * (eval/agent-web) where present.
 */
export function toExportResult(reports: VerifyReport[], ctx: ExportContext): VerifyExportResult {
  const checks: VerifyExportCheck[] = [];
  for (const r of reports) {
    for (const c of r.checks) {
      checks.push({
        name: c.name,
        passed: c.pass,
        input: c.input ?? null,
        expected: c.expected ?? null,
        output: c.output ?? null,
        'eval.score': c.score != null ? clamp01(c.score) : c.pass ? 1 : 0,
        'eval.explanation': c.explanation ?? null,
      });
    }
  }

  const passed = reports.length > 0 && reports.every((r) => r.pass);
  const passRate = checks.length === 0 ? 0 : checks.filter((c) => c.passed).length / checks.length;

  const model = reports.find((r) => r.model)?.model;
  const tokensIn = sumDefined(reports.map((r) => r.tokensIn));
  const tokensOut = sumDefined(reports.map((r) => r.tokensOut));
  const cost = sumDefined(reports.map((r) => r.costUsd));
  const durationMs = sumDefined(reports.map((r) => r.durationMs));

  const attributes: NonNullable<VerifyExportResult['attributes']> = {};
  if (model) attributes['gen_ai.request.model'] = model;
  if (tokensIn != null) attributes['gen_ai.usage.input_tokens'] = tokensIn;
  if (tokensOut != null) attributes['gen_ai.usage.output_tokens'] = tokensOut;
  if (cost != null) attributes['gen_ai.response.cost'] = cost;

  return {
    schemaVersion: '1',
    tool: ctx.tool,
    mode: reports.map((r) => r.mode).join('+') || 'verify',
    env: ctx.env,
    git_sha: ctx.gitSha ?? null,
    passed,
    pass_rate: passRate,
    duration_ms: durationMs ?? null,
    ...(Object.keys(attributes).length ? { attributes } : {}),
    checks,
  };
}
