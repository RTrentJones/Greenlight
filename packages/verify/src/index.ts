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
export { verifyEval, llmJudge, clamp01 } from './eval';
export {
  toExportResult,
  type VerifyExportResult,
  type VerifyExportCheck,
  type ExportContext,
} from './export';

export interface VerifyOptions {
  /** Poll for the URL to become reachable before checking — absorbs the first-deploy
   * TLS/DNS provisioning window. Retries ONLY on a connection error; a real HTTP
   * response (any status) means reachable. 0 = don't wait. */
  reachableTimeoutMs?: number;
  /** Working dir for command-running modes (`test`, and a `playwright` suite): the tool dir the
   * CLI resolves. Default cwd. */
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
 * function (docs/archive/greenlight-v1.md §11). `mcp`/`playwright` are loaded lazily so the
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
      return verifyPlaywright(baseUrl, spec, opts?.toolDir ?? process.cwd());
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
 * combine modes — e.g. `[test, api, agent-web]`). Returns one report per spec, in spec order;
 * aggregate pass = every spec passed. The reachable wait runs once, up front.
 *
 * Scheduling: specs run serially by default. ADJACENT specs marked `concurrency: 'parallel'`
 * run as one overlapped batch — right for network-bound modes (api/mcp) where serial execution
 * just sums the waits. CPU-bound (`test`) and LLM/browser modes should stay serial.
 */
export async function verifyAll(
  baseUrl: string,
  specs: VerifySpec[],
  opts?: VerifyOptions,
): Promise<VerifyReport[]> {
  if (opts?.reachableTimeoutMs) await waitForReachable(baseUrl, opts.reachableTimeoutMs);
  const perSpec: VerifyOptions = { ...opts, reachableTimeoutMs: 0 };

  const reports: VerifyReport[] = new Array(specs.length);
  let i = 0;
  while (i < specs.length) {
    if (specs[i]?.concurrency === 'parallel') {
      const start = i;
      while (i < specs.length && specs[i]?.concurrency === 'parallel') i++;
      const batch = await Promise.all(
        specs.slice(start, i).map((spec) => verify(baseUrl, spec, perSpec)),
      );
      batch.forEach((r, j) => {
        reports[start + j] = r;
      });
    } else {
      reports[i] = await verify(baseUrl, specs[i] as VerifySpec, perSpec);
      i++;
    }
  }
  return reports;
}

/** True when every report in the list passed (the gate decision for an array of specs). */
export function allPass(reports: VerifyReport[]): boolean {
  return reports.length > 0 && reports.every((r) => r.pass);
}
