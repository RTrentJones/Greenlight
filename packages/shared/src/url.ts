import type { DeployEnv } from './schema';

/**
 * Deterministic URL scheme (docs/archive/greenlight-v1.md §10/§12, Phase 1 plan).
 *
 * The scheme is computed, never scraped from deploy logs, so `verify` can always
 * target a deployment. `preview` is per-target (not derivable from a tool name
 * alone) — the adapter supplies it — so this resolver throws for `preview`.
 */

export interface ResolveUrlOptions {
  domain: string;
  /** Omit for the blog (apex domain); provide for a subdomain tool. */
  name?: string;
  env: DeployEnv;
  /** Append the MCP connect path (`/mcp`). */
  mcp?: boolean;
}

export function resolveUrl({ domain, name, env, mcp }: ResolveUrlOptions): string {
  if (env === 'preview') {
    throw new Error(
      'preview URLs are per-target and not deterministic — get them from the adapter (deploy result / adapter.url), not resolveUrl().',
    );
  }

  const host =
    name === undefined
      ? env === 'beta'
        ? `beta.${domain}`
        : domain
      : env === 'beta'
        ? `beta.${name}.${domain}`
        : `${name}.${domain}`;

  return `https://${host}${mcp ? '/mcp' : ''}`;
}
