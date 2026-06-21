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
  /** Build is env-aware so the adapter can inject env-correct config (e.g. SITE_URL). */
  build(toolDir: string, env: DeployEnv): Promise<BuildResult>;
  deploy(toolDir: string, env: DeployEnv): Promise<DeployResult>;
  /** Deterministic for beta/prod; throws for `preview` (get it from `deploy()`). */
  url(env: DeployEnv): string;
  teardown(env: DeployEnv): Promise<void>;
  /** Fetch the last `lines` of platform logs for this env (telemetry-into-verify fallback when a
   * spec sets no `logsOnFailure`). Optional + typed-but-unwired for now, like `teardown` — each
   * target's native log fetch (oci logging-search / vercel logs / wrangler tail) lands later. */
  logs?(env: DeployEnv, lines: number): Promise<string>;
}

function run(cmd: string, args: string[], cwd: string, extraEnv?: Record<string, string>): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

/** Cloudflare Workers (Static Assets + room for a future dynamic Worker). */
function workersAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  return {
    target: 'workers',
    async build(toolDir, env) {
      // Inject the env-correct site URL so sitemap/RSS/canonicals match (beta vs prod).
      // preview URLs aren't deterministic (resolveUrl throws) — let the tool's default stand.
      let siteEnv: Record<string, string> | undefined;
      try {
        siteEnv = { SITE_URL: url(env) };
      } catch {
        siteEnv = undefined;
      }
      run('pnpm', ['run', 'build'], toolDir, siteEnv);
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

/**
 * OCI deploy config. The free-tier model is an **OCI Container Instance** (Ampere A1, within
 * the Always-Free allotment shared across VM/Bare-Metal/Container-Instances) running the tool
 * image from **GHCR** (free) + a cloudflared sidecar — NOT a provisioned VM, and NOT OCI's
 * Container *Registry* (OCIR, paid). The image is built + pushed by the TOOL's own
 * provider-agnostic CI; the instance + tunnel are Terraform (`oci-instance` + `tunnel`
 * modules). "deploy" just restarts the instance so it re-pulls the latest image. Auth is the
 * OCI CLI's own config (API-key request signing).
 */
export interface OciDeployConfig {
  /** OCID of the container instance to restart (Terraform output → OCI_CONTAINER_INSTANCE_OCID). */
  containerInstanceId?: string;
}

/** Read OCI deploy config from a source env (defaults to `process.env`). */
export function ociConfig(
  source: Record<string, string | undefined> = process.env,
): OciDeployConfig {
  return { containerInstanceId: source.OCI_CONTAINER_INSTANCE_OCID };
}

/** The OCI CLI args that restart a container instance (it re-pulls the GHCR image). Pure. */
export function ociRestartArgs(containerInstanceId: string): string[] {
  return [
    'container-instances',
    'container-instance',
    'restart',
    '--container-instance-id',
    containerInstanceId,
  ];
}

function ociAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  return {
    target: 'oci',
    async build() {
      // The tool's own CI builds + pushes the container to GHCR (provider-agnostic). Nothing
      // to build here — the image is already published.
      return { artifactDir: '.' };
    },
    async deploy(_toolDir, env) {
      const { containerInstanceId } = ociConfig();
      if (!containerInstanceId) {
        throw new Error('oci deploy needs OCI_CONTAINER_INSTANCE_OCID (the Terraform output)');
      }
      // Restart the instance → it re-pulls the latest GHCR image. Needs the OCI CLI authed.
      run('oci', ociRestartArgs(containerInstanceId), '.');
      return { url: url(env) };
    },
    url,
    async teardown() {
      throw new Error('oci teardown is Terraform — `terraform destroy` the oci-instance module.');
    },
  };
}

function vercelSkeletonAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  // Vercel deploys ride the project's git integration (Phase 9 / HeistMind); Greenlight
  // configures the project via Terraform, not a push-deploy here.
  const notWired = (): never => {
    throw new Error(
      'vercel deploy rides Vercel git-integration — Greenlight manages its infra, not a push-deploy.',
    );
  };
  return {
    target: 'vercel',
    build: async () => notWired(),
    deploy: async () => notWired(),
    url,
    teardown: async () => notWired(),
  };
}

/** Resolve the adapter for a target, bound to a manifest entry. */
export function createAdapter(target: Target, ctx: AdapterContext): Adapter {
  switch (target) {
    case 'workers':
      return workersAdapter(ctx);
    case 'oci':
      return ociAdapter(ctx);
    case 'vercel':
      return vercelSkeletonAdapter(ctx);
  }
}
