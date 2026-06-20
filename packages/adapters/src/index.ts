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
 * OCI deploy config, read from the environment (provider-store secrets). The reusable,
 * **free-tier** model: an OCI Always-Free **Ampere A1 Compute VM** running Docker — NOT
 * OCI Container Instances (that managed service is not Always-Free). Build an ARM64 image,
 * push to a registry (GHCR by default — free), then pull+run it on the VM over SSH. The
 * app binds to localhost; the Cloudflare Tunnel (Terraform `tunnel` module) routes
 * `<name>.<domain>` → the VM's app port.
 */
export interface OciDeployConfig {
  /** Image registry (default `ghcr.io`). */
  registry?: string;
  /** Registry namespace — `GHCR_OWNER`, else the owner from `GITHUB_REPOSITORY`. */
  owner?: string;
  /** The A1 VM host (public IP / DNS) for the SSH deploy. */
  host?: string;
  /** SSH user (default `ubuntu`). */
  user?: string;
  /** Container/app port the tunnel targets (default `8000`). */
  appPort?: string;
  /** Path to the runtime env-file on the VM (default `~/<tool>.env`). */
  envFile?: string;
}

/** Read OCI deploy config from a source env (defaults to `process.env`). */
export function ociConfig(
  source: Record<string, string | undefined> = process.env,
): OciDeployConfig {
  return {
    registry: source.OCI_REGISTRY,
    owner: source.GHCR_OWNER ?? source.GITHUB_REPOSITORY?.split('/')[0],
    host: source.OCI_DEPLOY_HOST,
    user: source.OCI_DEPLOY_USER,
    appPort: source.OCI_APP_PORT,
    envFile: source.OCI_ENV_FILE,
  };
}

/** Deterministic image ref `<registry>/<owner>/<tool>:<env>` (pure). */
export function ociImageRef(tool: string, env: DeployEnv, cfg: OciDeployConfig): string {
  const registry = cfg.registry ?? 'ghcr.io';
  if (!cfg.owner) {
    throw new Error('oci: set GHCR_OWNER (or GITHUB_REPOSITORY) for the image path');
  }
  return `${registry}/${cfg.owner}/${tool}:${env}`;
}

/** The remote shell run on the VM to (re)start the container — pull, replace, run pinned to
 * localhost so only the cloudflared tunnel can reach it. Pure (tested). */
export function ociRemoteDeployScript(tool: string, image: string, cfg: OciDeployConfig): string {
  const port = cfg.appPort ?? '8000';
  const envFile = cfg.envFile ?? `~/${tool}.env`;
  return [
    `docker pull ${image}`,
    `docker rm -f ${tool} 2>/dev/null || true`,
    `docker run -d --name ${tool} --restart=always -p 127.0.0.1:${port}:${port} --env-file ${envFile} ${image}`,
  ].join(' && ');
}

const SSH_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];

function ociAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  const tool = ctx.name ?? 'app';
  return {
    target: 'oci',
    async build(toolDir, env) {
      // ARM64 for the Ampere A1 Always-Free shape. Requires docker buildx on the runner.
      const image = ociImageRef(tool, env, ociConfig());
      run(
        'docker',
        ['buildx', 'build', '--platform', 'linux/arm64', '-t', image, '--load', '.'],
        toolDir,
      );
      return { artifactDir: toolDir };
    },
    async deploy(toolDir, env) {
      const cfg = ociConfig();
      if (!cfg.host) throw new Error('oci deploy needs OCI_DEPLOY_HOST (the Always-Free A1 VM)');
      const image = ociImageRef(tool, env, cfg);
      run('docker', ['push', image], toolDir);
      // Per-env container so beta + prod can coexist on one VM (each on its own OCI_APP_PORT).
      const remote = ociRemoteDeployScript(`${tool}-${env}`, image, cfg);
      run('ssh', [...SSH_OPTS, `${cfg.user ?? 'ubuntu'}@${cfg.host}`, remote], toolDir);
      return { url: url(env) };
    },
    url,
    async teardown(env) {
      const cfg = ociConfig();
      if (!cfg.host) throw new Error('oci teardown needs OCI_DEPLOY_HOST');
      run(
        'ssh',
        [
          ...SSH_OPTS,
          `${cfg.user ?? 'ubuntu'}@${cfg.host}`,
          `docker rm -f ${tool}-${env} 2>/dev/null || true`,
        ],
        '.',
      );
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
