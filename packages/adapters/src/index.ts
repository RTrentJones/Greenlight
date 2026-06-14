import type { DeployEnv, Target } from '@rtrentjones/greenlight-shared';

/**
 * Deploy-target adapter contract — CONTRACTS ONLY (Phase 0).
 *
 * Every target (`workers` | `vercel` | `oci`) implements the same four hooks
 * (greenlight-v1.md §5). The contract is the product; frameworks are swappable.
 * `url()` is deterministic so `verify` can target a deploy without scraping logs.
 * Implementations land in Phase 1.
 */

export interface BuildResult {
  artifactDir: string;
}

export interface DeployResult {
  url: string;
}

export interface Adapter {
  readonly target: Target;
  build(toolDir: string): Promise<BuildResult>;
  deploy(toolDir: string, env: DeployEnv): Promise<DeployResult>;
  /** Deterministic — same inputs always yield the same URL. */
  url(toolName: string, env: DeployEnv): string;
  teardown(toolName: string, env: DeployEnv): Promise<void>;
}
