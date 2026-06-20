/**
 * Programmatic entrypoint for the Greenlight CLI — the single published package. The
 * shared manifest API + the verify-spec helpers are re-exported here (and the framework
 * libs are bundled into dist), so a consumer needs only `@rtrentjones/greenlight`.
 */
export { loadConfig, defineConfig } from '@rtrentjones/greenlight-shared';
export type { GreenlightConfig } from '@rtrentjones/greenlight-shared';
// Re-exported so typed manifest + verify configs both import from here. (verify specs can
// also be plain objects with no import.)
export { defineVerify } from '@rtrentjones/greenlight-verify';
export type { VerifySpec } from '@rtrentjones/greenlight-verify';
