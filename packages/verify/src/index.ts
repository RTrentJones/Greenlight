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

export interface VerifyOptions {
  /** Poll for the URL to become reachable before checking — absorbs the first-deploy
   * TLS/DNS provisioning window. Retries ONLY on a connection error; a real HTTP
   * response (any status) means reachable. 0 = don't wait. */
  reachableTimeoutMs?: number;
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
  }
}
