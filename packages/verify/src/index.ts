import { setTimeout as sleep } from 'node:timers/promises';
import { verifyApi } from './api';
import type { VerifyReport, VerifySpec } from './types';

export * from './types';

/** Authoring helper for a per-tool `verify.config.ts` (identity + type inference). */
export function defineVerify(spec: VerifySpec): VerifySpec {
  return spec;
}
export { verifyApi } from './api';
export { verifyMcp } from './mcp';
export { verifyPlaywright } from './playwright';
export { verifyTest } from './test';
export { verifyAgentWeb } from './agent-web';
export { verifyEval, llmJudge } from './eval';

export interface VerifyOptions {
  /** Poll for the URL to become reachable before checking — absorbs the first-deploy
   * TLS/DNS provisioning window. Retries ONLY on a connection error; a real HTTP
   * response (any status) means reachable. 0 = don't wait. */
  reachableTimeoutMs?: number;
  /** Working dir for local modes (`test`): the tool dir the CLI resolves. Default cwd. */
  toolDir?: string;
}

/**
 * Wait until `url` accepts a connection (any HTTP response), or time out. Retries
 * only on thrown fetch errors (DNS/TLS/connection-refused) — never on a 4xx/5xx,
 * which is a real answer the checks should evaluate.
 */
export async function waitForReachable(url: string, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await sleep(2000);
    }
  }
}

/**
 * Run the verify harness against a deployed URL. Dispatches on `spec.mode`;
 * every mode returns the same `VerifyReport`. CI and the agent call this same
 * function (greenlight-v1.md §11). `mcp`/`playwright` are loaded lazily so the
 * common `api` path stays dependency-light.
 */
export async function verify(
  baseUrl: string,
  spec: VerifySpec,
  opts?: VerifyOptions,
): Promise<VerifyReport> {
  if (opts?.reachableTimeoutMs) await waitForReachable(baseUrl, opts.reachableTimeoutMs);
  switch (spec.mode) {
    case 'api':
      return verifyApi(baseUrl, spec);
    case 'mcp': {
      const { verifyMcp } = await import('./mcp');
      return verifyMcp(baseUrl, spec);
    }
    case 'playwright': {
      const { verifyPlaywright } = await import('./playwright');
      return verifyPlaywright(baseUrl, spec);
    }
    case 'test': {
      const { verifyTest } = await import('./test');
      return verifyTest(spec, opts?.toolDir ?? process.cwd());
    }
    case 'agent-web': {
      const { verifyAgentWeb } = await import('./agent-web');
      return verifyAgentWeb(baseUrl, spec);
    }
    case 'eval': {
      const { verifyEval } = await import('./eval');
      return verifyEval(baseUrl, spec);
    }
  }
}

/**
 * Run a list of specs against the same URL (a `verify.config.ts` may export an array to
 * combine modes — e.g. `[test, api, agent-web]`). Returns one report per spec; aggregate
 * pass = every spec passed. The reachable wait runs once, before the first spec.
 */
export async function verifyAll(
  baseUrl: string,
  specs: VerifySpec[],
  opts?: VerifyOptions,
): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = [];
  let waited = false;
  for (const spec of specs) {
    const perSpec = waited ? { ...opts, reachableTimeoutMs: 0 } : opts;
    reports.push(await verify(baseUrl, spec, perSpec));
    waited = true;
  }
  return reports;
}

/** True when every report in the list passed (the gate decision for an array of specs). */
export function allPass(reports: VerifyReport[]): boolean {
  return reports.length > 0 && reports.every((r) => r.pass);
}
