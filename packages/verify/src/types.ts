/**
 * Verify harness types — the stable contract shared by CI and the agent
 * (docs/archive/greenlight-v1.md §11). `verify(baseUrl, spec)` dispatches on `spec.mode`;
 * every mode returns the same `VerifyReport` shape.
 */

export type VerifyMode = 'api' | 'mcp' | 'playwright' | 'test' | 'agent-web' | 'eval';

export interface VerifyCheck {
  name: string;
  pass: boolean;
  detail?: string;
  /** Scored quality in [0,1] (1 = perfect), when a mode produces one (today: `eval`). Other modes
   * leave it undefined; the `--json` export derives 1.0/0.0 from `pass`. Standards-aligned (0..1,
   * like OpenInference / autoevals). */
  score?: number;
  /** One-line "why" behind the score (the judge rationale) — exported as `eval.explanation`. */
  explanation?: string;
  /** Optional case context, surfaced in the `--json` export (e.g. an eval case's prompt/result). */
  input?: string;
  expected?: string;
  output?: string;
}

export interface VerifyReport {
  pass: boolean;
  mode: VerifyMode;
  url: string;
  checks: VerifyCheck[];
  /** Recent platform logs, attached ONLY on a failing report when the spec set `logsOnFailure`
   * (telemetry-into-verify — gives the agent/CI the "why" without leaving the loop). */
  logs?: string;
  /** Optional run-level metadata for the `--json` export (OTel-GenAI attributes). Set best-effort by
   * the LLM-driven modes (`eval` judge, `agent-web` driver); omitted by the others. */
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
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

/** api mode — HTTP assertions (docs/archive/greenlight-v1.md §9/§11). */
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
  /** Max internal links to crawl from `/` (default 50). The check reports when the cap is hit so a
   * silently-truncated crawl never reads as "all links checked". */
  maxLinks?: number;
  /** Per-request timeout in ms for every HTTP fetch this spec makes (default 10000). Bounds a hung
   * endpoint so the gate fails instead of blocking forever — and bounds total settle time too. */
  timeoutMs?: number;
  /** Eventual-consistency settle: if any check fails, re-run ONLY the still-failing checks up to
   * `settleRetries` more times, waiting `settleMs` between tries. Absorbs the propagation lag of
   * statically-served hosts (e.g. Cloudflare Workers Static Assets serve some paths before others
   * for a few seconds right after a deploy). A genuine failure still fails — just after the retries.
   * Absent/0 ⇒ no retry (the default; a local `preview` against a built dir needs none). Bounded by
   * `timeoutMs` per fetch, so the whole settle window is finite. */
  settleRetries?: number;
  /** Delay between settle retries, in ms (default 5000). */
  settleMs?: number;
}

/** mcp mode — protocol-level verification (docs/archive/greenlight-v1.md §6). */
export interface McpSpec extends VerifySpecBase {
  mode: 'mcp';
  /** Tool names that `tools/list` must include. */
  expectTools: string[];
  /** Drift guard: require `tools/list` to equal `expectTools` EXACTLY — no missing, no extras. Use
   * this to enforce that a capability added in code is also added to the verify loop (an unexpected
   * tool, or a renamed/removed one, fails the gate). Default false (subset check via expectTools). */
  exactTools?: boolean;
  /** Optionally call one tool and assert the result is non-error / has keys. */
  call?: { name: string; args?: Record<string, unknown>; expectKeys?: string[] };
  /** Assert an unauthenticated request is rejected (auth != none servers). */
  requireAuthRejection?: boolean;
  /** Extra HTTP headers for the transport — e.g. `{ Authorization: 'Bearer …' }` for an
   * OAuth-gated server. Inject the token from an env var in your verify.config.ts so it never
   * lands in a committed file. Lets `mcp` mode run the authenticated functional/eval checks. */
  headers?: Record<string, string>;
  /** Per-operation timeout in ms for each protocol step (connect/list/call) and the auth probe
   * (default 10000). Bounds a hung server so the gate fails instead of blocking forever — matches
   * `api` mode's timeout discipline. */
  timeoutMs?: number;
}

/** playwright mode — a render smoke and/or a real Playwright test suite against the deploy URL.
 *
 * Two complementary checks, either or both:
 *  - `renders`: a zero-config light smoke — each path must load with a non-empty accessibility
 *    tree (no suite, no auth).
 *  - `suite`: run a real `playwright test` suite (fixtures, assertions, authenticated flows)
 *    against the EXACT deployed URL. The harness injects that URL into the suite's environment as
 *    `PLAYWRIGHT_BASE_URL` (Playwright's de-facto baseURL var) and `GREENLIGHT_VERIFY_URL`, so the
 *    same suite runs unchanged in PR CI (local stack) and as the deploy gate — the path to gating
 *    on full user journeys (e.g. an authenticated session injected via a service-role key,
 *    bypassing third-party OAuth that can't be scripted). */
export interface PlaywrightSuite {
  /** Command to run. Default: `pnpm exec playwright test`. */
  command?: string;
  /** Working directory (default: the tool dir the CLI passes, else cwd). */
  cwd?: string;
  /** Per-run timeout in ms (default 600000). */
  timeoutMs?: number;
  /** Extra env to forward to the suite (e.g. a secret already in the harness env). The deploy URL
   * is always provided as PLAYWRIGHT_BASE_URL / GREENLIGHT_VERIFY_URL regardless. */
  env?: Record<string, string>;
}

export interface PlaywrightSpec extends VerifySpecBase {
  mode: 'playwright';
  /** Paths that must load with a non-empty accessibility tree. */
  renders?: string[];
  /** Run a real Playwright suite against the deployed URL (see PlaywrightSuite). */
  suite?: PlaywrightSuite;
}

/** test mode — run the tool's own unit/integration command in its dir and gate on the exit
 * code (docs/archive/greenlight-v1.md §11 — classic tests in the same gate CI + the agent use). Unlike
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
  /** How many recent turns (assistant+tool-result pairs) to keep in the model context, besides
   * the initial task message (default 6). Older turns — each carrying a ~6 KB page snapshot — are
   * dropped so input tokens don't grow quadratically over a long scenario. Pairs are preserved so
   * a tool_use always keeps its matching tool_result. */
  historyWindow?: number;
  /** Optional per-scenario token budget (input+output, summed across steps). When the running
   * total reaches it, the scenario stops and fails with a "token budget exceeded" check rather
   * than burning the full `maxSteps`. Absent ⇒ no budget (bounded only by `maxSteps`). */
  maxTokens?: number;
  /** Abort a scenario after this many consecutive identical FAILING tool calls (default 3) — a
   * stuck agent retrying the same dead action shouldn't waste the rest of `maxSteps`. */
  maxRepeats?: number;
  /** Run a headed browser (default false/headless). */
  headed?: boolean;
}

/** eval mode — scored quality assertions over an MCP tool's output (docs/archive/greenlight-v1.md §6,
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
  /** Minimum score in [0,1] to pass (default 0.8). (Was a 1–5 scale + default 4 before v0.6.0.) */
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
  score: number; // 0..1 (1 = fully satisfies). Was 1–5 before v0.6.0.
  pass: boolean;
  /** One-line justification. `reason` is the deprecated alias kept for one release. */
  rationale?: string;
  reason?: string;
  /** Best-effort judge token usage (for the `--json` export); set by the default LLM judge. */
  tokensIn?: number;
  tokensOut?: number;
}
export type Judge = (input: JudgeInput) => Promise<JudgeResult>;

export type VerifySpec = ApiSpec | McpSpec | PlaywrightSpec | TestSpec | AgentWebSpec | EvalSpec;

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function report(mode: VerifyMode, url: string, checks: VerifyCheck[]): VerifyReport {
  return { pass: checks.length > 0 && checks.every((c) => c.pass), mode, url, checks };
}
