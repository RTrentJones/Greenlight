import { verifyApi } from './api';
import type { VerifyReport, VerifySpec } from './types';

export * from './types';
export { verifyApi } from './api';
export { verifyMcp } from './mcp';
export { verifyPlaywright } from './playwright';

/**
 * Run the verify harness against a deployed URL. Dispatches on `spec.mode`;
 * every mode returns the same `VerifyReport`. CI and the agent call this same
 * function (greenlight-v1.md §11). `mcp`/`playwright` are loaded lazily so the
 * common `api` path stays dependency-light.
 */
export async function verify(baseUrl: string, spec: VerifySpec): Promise<VerifyReport> {
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
