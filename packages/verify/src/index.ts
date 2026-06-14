/**
 * Verify harness — CONTRACTS ONLY (Phase 0).
 *
 * Implementations of each mode land in Phase 1 (greenlight-v1.md §16). CI and
 * the agent both call `verify()`; the report shape is stable so callers can be
 * written against it now.
 */

/** Verify mode is selected by a tool's lane. */
export type VerifyMode = 'api' | 'playwright' | 'mcp';

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

export interface VerifySpec {
  mode: VerifyMode;
  /** Mode-specific expectations are filled in during Phase 1. */
}

/** Implemented in Phase 1. */
export async function verify(_baseUrl: string, _spec: VerifySpec): Promise<VerifyReport> {
  throw new Error('verify() is not implemented until Phase 1');
}
