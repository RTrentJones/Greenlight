/**
 * Verify harness types — the stable contract shared by CI and the agent
 * (greenlight-v1.md §11). `verify(baseUrl, spec)` dispatches on `spec.mode`;
 * every mode returns the same `VerifyReport` shape.
 */

export type VerifyMode = 'api' | 'mcp' | 'playwright';

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
}

export interface ApiSpec {
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
export interface McpSpec {
  mode: 'mcp';
  /** Tool names that `tools/list` must include. */
  expectTools: string[];
  /** Optionally call one tool and assert the result is non-error / has keys. */
  call?: { name: string; args?: Record<string, unknown>; expectKeys?: string[] };
  /** Assert an unauthenticated request is rejected (auth != none servers). */
  requireAuthRejection?: boolean;
}

/** playwright mode — light render check via the accessibility tree. */
export interface PlaywrightSpec {
  mode: 'playwright';
  /** Paths that must load with a non-empty accessibility tree. */
  renders: string[];
}

export type VerifySpec = ApiSpec | McpSpec | PlaywrightSpec;

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function report(mode: VerifyMode, url: string, checks: VerifyCheck[]): VerifyReport {
  return { pass: checks.length > 0 && checks.every((c) => c.pass), mode, url, checks };
}
