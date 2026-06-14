import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { type DeployEnv, type Target, resolveUrl } from '@rtrentjones/greenlight-shared';

/**
 * Deploy-target adapters (greenlight-v1.md §5). Every target implements the same
 * four hooks; the contract is the product. `url()` is deterministic (delegates to
 * the shared resolver) so `verify` never scrapes deploy logs. The adapter is bound
 * to one entry via `AdapterContext` (name undefined = apex/blog).
 */

export interface BuildResult {
  artifactDir: string;
}

export interface DeployResult {
  url: string;
}

export interface AdapterContext {
  domain: string;
  /** undefined = the blog (apex domain); a tool name = a subdomain. */
  name?: string;
}

export interface Adapter {
  readonly target: Target;
  build(toolDir: string): Promise<BuildResult>;
  deploy(toolDir: string, env: DeployEnv): Promise<DeployResult>;
  /** Deterministic for beta/prod; throws for `preview` (get it from `deploy()`). */
  url(env: DeployEnv): string;
  teardown(env: DeployEnv): Promise<void>;
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** Cloudflare Workers (Static Assets + room for a future dynamic Worker). */
function workersAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  return {
    target: 'workers',
    async build(toolDir) {
      run('pnpm', ['run', 'build'], toolDir);
      return { artifactDir: join(toolDir, 'dist') };
    },
    async deploy(toolDir, env) {
      // Requires Cloudflare creds (CLOUDFLARE_API_TOKEN); DNS/custom domains via Terraform (Phase 5).
      run('pnpm', ['exec', 'wrangler', 'deploy', '--env', env], toolDir);
      return { url: url(env) };
    },
    url,
    async teardown() {
      throw new Error('workers teardown is not wired yet (later phase).');
    },
  };
}

const NOT_WIRED: Record<Exclude<Target, 'workers'>, string> = {
  oci: 'Phase 4 (mcp on OCI / BAMCP)',
  vercel: 'Phase 9 (HeistMind migration)',
};

function skeletonAdapter(target: Exclude<Target, 'workers'>, ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  const notWired = (): never => {
    throw new Error(
      `${target} deploy is not wired yet — lands in ${NOT_WIRED[target]} (greenlight-v1.md §16).`,
    );
  };
  return {
    target,
    build: async () => notWired(),
    deploy: async () => notWired(),
    url,
    teardown: async () => notWired(),
  };
}

/** Resolve the adapter for a target, bound to a manifest entry. */
export function createAdapter(target: Target, ctx: AdapterContext): Adapter {
  return target === 'workers' ? workersAdapter(ctx) : skeletonAdapter(target, ctx);
}
