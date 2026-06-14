/**
 * Programmatic entrypoint for the Greenlight CLI.
 *
 * Phase 0 exposes nothing beyond re-exporting the shared manifest API; command
 * implementations (init / add / adopt / verify / promote / doctor) land in later
 * phases (greenlight-v1.md §16).
 */
export { loadConfig, defineConfig } from '@rtrentjones/greenlight-shared';
export type { GreenlightConfig } from '@rtrentjones/greenlight-shared';
