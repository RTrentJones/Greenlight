/**
 * Verify harness types — the stable contract shared by CI and the agent
 * (greenlight-v1.md §11). `verify(baseUrl, spec)` dispatches on `spec.mode`;
 * every mode returns the same `VerifyReport` shape.
 */

export type VerifyMode = 'api' | 'mcp' | 'playwright' | 'test' | 'agent-web' | 'eval';

export interface VerifyCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface VerifyReport {
  pass: boolean;
  mode: VerifyMode;
  url: string;
  checks: VerifyCheck[];
  /** Recent platform logs, attached ONLY on a failing report when the spec set `logsOnFailure`
   * (telemetry-into-verify — gives the agent/CI the "why" without leaving the loop). */
  logs?: string;
}

/** Fields every spec shares. */
export interface VerifySpecBase {
  /** A shell command that fetches recent platform logs, run ONLY when this spec's report FAILS, and
   * attached to `VerifyReport.logs` so the agent/CI can self-correct in-loop. General, no provider
   * coupling — e.g. `curl -i "$GREENLIGHT_VERIFY_URL"`, `vercel logs "$GREENLIGHT_VERIFY_URL"`,
   * `wrangler tail --once`. The failing report's URL is injected as `$GREENLIGHT_VERIFY_URL` so the
   * command needs no hard-coded URL. Runs in the tool dir, output bounded, best-effort (never fails
   * the verify). */
  logsOnFailure?: string;
}

/** api mode — HTTP assertions (greenlight-v1.md §9/§11). */
export interface ApiCheck {
  path: string;
  /** Expected HTTP status (redirects are not followed). */
  status?: number;
  /** Substring the response body must contain. */
  contains?: string;
  /** Response header that must be present (optionally equal to `value`). */
  header?: { name: string; value?: string };
  /** Request headers to SEND — e.g. `{ 'x-vercel-protection-bypass': '…' }` to reach a Vercel
   * deployment behind Deployment Protection. Inject secrets from env in verify.config.ts. */
  requestHeaders?: Record<string, string>;
}

export interface ApiSpec extends VerifySpecBase {
  mode: 'api';
  checks?: ApiCheck[];
  /** Assert an RSS/Atom feed exists and parses. */
  rssValid?: boolean;
  /** Assert a sitemap exists and parses. */
  sitemapValid?: boolean;
  /** Crawl internal links from `/` and assert none are broken. */
  noBrokenInternalLinks?: boolean;
}

/** mcp mode — protocol-level verification (greenlight-v1.md §6). */
export interface McpSpec extends VerifySpecBase {
  mode: 'mcp';
  /** Tool names that `tools/list` must include. */
  expectTools: string[];
  /** Optionally call one tool and assert the result is non-error / has keys. */
  call?: { name: string; args?: Record<string, unknown>; expectKeys?: string[] };
  /** Assert an unauthenticated request is rejected (auth != none servers). */
  requireAuthRejection?: boolean;
  /** Extra HTTP headers for the transport — e.g. `{ Authorization: 'Bearer …' }` for an
   * OAuth-gated server. Inject the token from an env var in your verify.config.ts so it never
   * lands in a committed file. Lets `mcp` mode run the authenticated functional/eval checks. */
  headers?: Record<string, string>;
}

/** playwright mode — light render check via the accessibility tree. */
export interface PlaywrightSpec extends VerifySpecBase {
  mode: 'playwright';
  /** Paths that must load with a non-empty accessibility tree. */
  renders: string[];
}

/** test mode — run the tool's own unit/integration command in its dir and gate on the exit
 * code (greenlight-v1.md §11 — classic tests in the same gate CI + the agent use). Unlike
 * the URL modes this runs locally; the deployed URL is ignored (it's still in the report). */
export interface TestSpec extends VerifySpecBase {
  mode: 'test';
  /** Command to run. Default: `pnpm test`. Use e.g. `pnpm test:integ` for integration. */
  command?: string;
  /** Working directory (default: the tool dir the CLI passes, else cwd). */
  cwd?: string;
  /** Per-run timeout in ms (default 600000). */
  timeoutMs?: number;
}

/** agent-web mode — agentic end-to-end UI validation: an LLM drives the live UI via
 * Playwright to accomplish a natural-language task, then assertions confirm the outcome
 * (the HeistMind case). Needs ANTHROPIC_API_KEY + playwright + @anthropic-ai/sdk (both
 * optional deps, lazy-loaded — the common api path stays light). */
export interface AgentWebAssert {
  /** Final URL must contain this substring. */
  urlContains?: string;
  /** Rendered page text must contain this. */
  textContains?: string;
  /** A selector that must be present (count > 0). */
  selector?: string;
}

export interface AgentWebScenario {
  /** Human label for the scenario. */
  name: string;
  /** The task to accomplish, in natural language (the agent acts to fulfill it). */
  task: string;
  /** Path to start at (default `/`). */
  start?: string;
  /** Assertions checked after the agent finishes. All must pass for the scenario to pass. */
  asserts?: AgentWebAssert[];
}

export interface AgentWebSpec extends VerifySpecBase {
  mode: 'agent-web';
  scenarios: AgentWebScenario[];
  /** Model id (default `claude-sonnet-4-6`). */
  model?: string;
  /** Max agent steps per scenario (default 12). */
  maxSteps?: number;
  /** Run a headed browser (default false/headless). */
  headed?: boolean;
}

/** eval mode — scored quality assertions over an MCP tool's output (greenlight-v1.md §6,
 * beyond protocol-shape `mcp`). Each case calls a tool and an LLM judge scores the result
 * against a rubric. STRETCH/thin cut: spec + judge interface are stable; the default LLM
 * judge needs ANTHROPIC_API_KEY + @anthropic-ai/sdk (optional, lazy). */
export interface EvalCase {
  name: string;
  /** MCP tool to call on the server at the verify URL. */
  tool: string;
  args?: Record<string, unknown>;
  /** Natural-language rubric the judge scores the tool's result against. */
  rubric: string;
  /** Minimum score [1-5] to pass (default 4). */
  minScore?: number;
}

export interface EvalSpec extends VerifySpecBase {
  mode: 'eval';
  cases: EvalCase[];
  /** Judge model id (default `claude-sonnet-4-6`). */
  model?: string;
}

/** The judge contract — swap the default LLM judge for a deterministic one in tests/CI. */
export interface JudgeInput {
  rubric: string;
  result: string;
}
export interface JudgeResult {
  score: number; // 1–5
  pass: boolean;
  reason?: string;
}
export type Judge = (input: JudgeInput) => Promise<JudgeResult>;

export type VerifySpec = ApiSpec | McpSpec | PlaywrightSpec | TestSpec | AgentWebSpec | EvalSpec;

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function report(mode: VerifyMode, url: string, checks: VerifyCheck[]): VerifyReport {
  return { pass: checks.length > 0 && checks.every((c) => c.pass), mode, url, checks };
}
