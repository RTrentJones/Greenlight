import { type DeployEnv, type Target, resolveUrl } from '@rtrentjones/greenlight-shared';

/**
 * Deploy-target adapters (greenlight-v1.md §5). Every target implements the same
 * four hooks; the contract is the product. `url()` is deterministic (delegates to
 * the shared resolver) so `verify` never scrapes deploy logs. Real cloud `deploy`
 * lands per-target in later phases — until then it throws a clear message.
 */

export interface BuildResult {
  artifactDir: string;
}

export interface DeployResult {
  url: string;
}

export interface AdapterContext {
  domain: string;
}

export interface Adapter {
  readonly target: Target;
  build(toolDir: string): Promise<BuildResult>;
  deploy(toolDir: string, env: DeployEnv): Promise<DeployResult>;
  /**
   * Deterministic deployment URL for beta/prod. Throws for `preview` (per-target,
   * not derivable from a name — get it from `deploy()`). `name` undefined = apex/blog.
   */
  url(name: string | undefined, env: DeployEnv): string;
  teardown(name: string | undefined, env: DeployEnv): Promise<void>;
}

/** Phase each target's real deploy is wired in (greenlight-v1.md §16). */
const WIRED_IN: Record<Target, string> = {
  workers: 'Phase 2 (blog) / Phase 4 (mcp on workers)',
  oci: 'Phase 4 (mcp on OCI / BAMCP)',
  vercel: 'Phase 9 (HeistMind migration)',
};

function skeleton(target: Target, ctx: AdapterContext): Adapter {
  const notWired = (): never => {
    throw new Error(
      `${target} deploy is not wired yet — lands in ${WIRED_IN[target]} (greenlight-v1.md §16).`,
    );
  };
  return {
    target,
    build: async () => notWired(),
    deploy: async () => notWired(),
    url: (name, env) => resolveUrl({ domain: ctx.domain, name, env }),
    teardown: async () => notWired(),
  };
}

/** Resolve the adapter for a target, bound to the manifest's domain. */
export function createAdapter(target: Target, ctx: AdapterContext): Adapter {
  return skeleton(target, ctx);
}
