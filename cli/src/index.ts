/**
 * Programmatic entrypoint for the Greenlight CLI — the single published package. The
 * shared manifest API + the verify-spec helpers are re-exported here (and the framework
 * libs are bundled into dist), so a consumer needs only `@rtrentjones/greenlight`.
 */
export { loadConfig, defineConfig } from '@rtrentjones/greenlight-shared';
export type { GreenlightConfig } from '@rtrentjones/greenlight-shared';
// The deterministic per-env URL scheme (prod `<name>.domain`, beta `beta.<name>.domain`, `/mcp` for
// MCP, apex for the blog). Exported so consumers (the site) link to the right environment without
// reimplementing the convention.
export { resolveUrl } from '@rtrentjones/greenlight-shared';
export type { ResolveUrlOptions } from '@rtrentjones/greenlight-shared';
// Re-exported so typed manifest + verify configs both import from here. (verify specs can
// also be plain objects with no import.)
export { defineVerify } from '@rtrentjones/greenlight-verify';
export type { VerifySpec } from '@rtrentjones/greenlight-verify';
