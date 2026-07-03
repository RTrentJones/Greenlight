import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DeployEnv, type Target, resolveUrl } from '@rtrentjones/greenlight-shared';

/**
 * Deploy-target adapters (docs/archive/greenlight-v1.md §5). Every target implements the same
 * four hooks; the contract is the product. `url()` is deterministic (delegates to
 * the shared resolver) so `verify` never scrapes deploy logs. The adapter is bound
 * to one entry via `AdapterContext` (name undefined = apex/blog).
 */

export interface BuildResult {
  artifactDir: string;
}

export interface DeployResult {
  url: string;
  /** The previously-live version, captured BEFORE this deploy — the rollback target `ship`
   * hands back to `rollback()` when the post-deploy verify fails. Absent when the target has no
   * addressable versions (oci/docker mutable-tag restarts) or the capture failed. */
  previous?: { versionId?: string };
}

export interface RollbackResult {
  ok: boolean;
  detail: string;
}

export interface AdapterContext {
  domain: string;
  /** undefined = the blog (apex domain); a tool name = a subdomain. */
  name?: string;
}

export interface Adapter {
  readonly target: Target;
  /** How deployments reach this target: `'push'` — Greenlight builds+deploys directly (workers/
   * oci/docker); `'git'` — the platform's git integration deploys on push (vercel), so `deploy`/
   * `ship` skip the push-deploy and callers must NOT treat build/deploy as callable. Branch on
   * this instead of catching a not-wired throw. */
  readonly deployStyle: 'push' | 'git';
  /** Build is env-aware so the adapter can inject env-correct config (e.g. SITE_URL). */
  build(toolDir: string, env: DeployEnv): Promise<BuildResult>;
  deploy(toolDir: string, env: DeployEnv): Promise<DeployResult>;
  /** Deterministic for beta/prod; throws for `preview` (get it from `deploy()`). */
  url(env: DeployEnv): string;
  /** Restore the previously-live version after a failed post-deploy verify (`ship`'s reaction
   * path). Optional: targets without an addressable previous version return `{ ok: false }` with
   * the manual heal path in `detail` — never throw. (Replaces `teardown`, which every adapter
   * only ever threw from — a contract nobody implements is documentation, not a contract.) */
  rollback?(
    toolDir: string,
    env: DeployEnv,
    previous?: DeployResult['previous'],
  ): Promise<RollbackResult>;
  /** Fetch the last `lines` of platform logs for this env (telemetry-into-verify fallback when a
   * spec sets no `logsOnFailure`). Optional + typed-but-unwired for now — each target's native
   * log fetch (oci logging-search / vercel logs / wrangler tail) lands later. */
  logs?(env: DeployEnv, lines: number): Promise<string>;
}

function run(cmd: string, args: string[], cwd: string, extraEnv?: Record<string, string>): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

/** The commit being deployed (E3 artifact identity): CI's GITHUB_SHA, else the local HEAD.
 * Injected into builds as GREENLIGHT_SHA so a tool can expose it at `/__version` and verify
 * can assert "this URL serves the artifact I'm gating". Best-effort — undefined outside git. */
export function buildSha(cwd: string): string | undefined {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Best-effort: the currently-live Workers version id for this env — captured BEFORE a deploy so
 * it can be the rollback target. Undefined when wrangler/the JSON shape is unavailable (older
 * wrangler, first deploy, no creds); rollback then degrades to a manual-path message. */
export function currentWorkersVersionId(toolDir: string, env: DeployEnv): string | undefined {
  try {
    const out = execFileSync(
      'pnpm',
      ['exec', 'wrangler', 'versions', 'list', '--env', env, '--json'],
      { cwd: toolDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const versions = JSON.parse(out) as Array<{ id?: string; metadata?: { created_on?: string } }>;
    if (!Array.isArray(versions) || versions.length === 0) return undefined;
    const latest = [...versions].sort((a, b) =>
      (b.metadata?.created_on ?? '').localeCompare(a.metadata?.created_on ?? ''),
    )[0];
    return latest?.id;
  } catch {
    return undefined;
  }
}

/** The wrangler argv that restores a previous version. Pure (exported for unit tests). */
export function wranglerRollbackArgs(versionId: string, env: DeployEnv): string[] {
  return [
    'exec',
    'wrangler',
    'rollback',
    versionId,
    '--env',
    env,
    '--message',
    'greenlight auto-rollback (post-deploy verify failed)',
  ];
}

/** Cloudflare Workers (Static Assets + room for a future dynamic Worker). */
function workersAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  return {
    target: 'workers',
    deployStyle: 'push',
    async build(toolDir, env) {
      // Inject the env-correct site URL so sitemap/RSS/canonicals match (beta vs prod).
      // preview URLs aren't deterministic (resolveUrl throws) — let the tool's default stand.
      let siteEnv: Record<string, string> = {};
      try {
        siteEnv = { SITE_URL: url(env) };
      } catch {
        // preview — no deterministic URL
      }
      // Bake the deployed commit into the build (same seam as SITE_URL) so the tool can serve it
      // at /__version and `verify --expect-sha` can assert artifact identity, not just URL health.
      const sha = buildSha(toolDir);
      if (sha) siteEnv.GREENLIGHT_SHA = sha;
      run('pnpm', ['run', 'build'], toolDir, siteEnv);
      return { artifactDir: join(toolDir, 'dist') };
    },
    async deploy(toolDir, env) {
      // Capture the live version FIRST — it's the rollback target if the post-deploy verify fails.
      const previousVersionId = currentWorkersVersionId(toolDir, env);
      // Requires Cloudflare creds (CLOUDFLARE_API_TOKEN); DNS/custom domains via Terraform (Phase 5).
      run('pnpm', ['exec', 'wrangler', 'deploy', '--env', env], toolDir);
      return { url: url(env), previous: { versionId: previousVersionId } };
    },
    url,
    async rollback(toolDir, env, previous) {
      if (!previous?.versionId) {
        return {
          ok: false,
          detail:
            'no previous version id was captured before the deploy — roll back manually: `wrangler versions list` then `wrangler rollback <version-id>` (or the Cloudflare dashboard).',
        };
      }
      try {
        run('pnpm', wranglerRollbackArgs(previous.versionId, env), toolDir);
        return { ok: true, detail: `rolled back to version ${previous.versionId}` };
      } catch (e) {
        return {
          ok: false,
          detail: `wrangler rollback failed: ${e instanceof Error ? e.message : String(e)} — roll back via the Cloudflare dashboard.`,
        };
      }
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

/** oci/docker share a rollback story: "deploy" restarts against the mutable `:prod` GHCR tag, so
 * there is no addressable previous version to restore — a true rollback needs the instance pinned
 * to an image DIGEST (a Terraform-plane change, planned follow-up). Until then the honest answer
 * is a typed no with the heal path, not a throw. */
function mutableTagRollback(target: string, healPath: string): Adapter['rollback'] {
  return async () => ({
    ok: false,
    detail: `${target} rollback is not possible with the mutable :prod image tag — ${healPath}. Digest-pinned rollback is a planned follow-up.`,
  });
}

function ociAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  return {
    target: 'oci',
    deployStyle: 'push',
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
    rollback: mutableTagRollback(
      'oci',
      'push a revert commit (the tool CI rebuilds :prod) or re-run the remediate workflow after re-tagging',
    ),
  };
}

/**
 * Docker deploy config — a host YOU own (VPS/homelab), reached over SSH. Same build model as oci
 * (the tool's CI pushes the image to GHCR), but deploy is `docker compose pull && up -d` on the host
 * (the compose runs the GHCR image + a cloudflared sidecar using the tunnel token, set up once on
 * the host). A stable alternative to OCI's idle-reclaimed free tier.
 */
export interface DockerDeployConfig {
  host?: string;
  /** SSH user (default root). */
  user: string;
  /** SSH port (default 22). */
  port: string;
  /** Remote dir holding the tool's docker-compose (default `greenlight/<name>`). */
  remoteDir: string;
  /** SSH private key PEM content (DOCKER_SSH_KEY). */
  key?: string;
}

/** Read docker SSH deploy config from a source env (defaults to `process.env`). `name` sets the
 * default remote compose dir. Pure. */
export function dockerConfig(
  name: string | undefined,
  source: Record<string, string | undefined> = process.env,
): DockerDeployConfig {
  return {
    host: source.DOCKER_SSH_HOST,
    user: source.DOCKER_SSH_USER || 'root',
    port: source.DOCKER_SSH_PORT || '22',
    remoteDir: source.DOCKER_COMPOSE_DIR || `greenlight/${name ?? 'app'}`,
    key: source.DOCKER_SSH_KEY,
  };
}

/** The `ssh` argv that pulls the latest image and restarts the compose on the host. `identityPath`
 * is the temp file the key was written to. Pure (host presence is validated by the caller). */
export function sshDeployArgs(cfg: DockerDeployConfig, identityPath: string): string[] {
  const remoteCmd = `cd ${cfg.remoteDir} && docker compose pull && docker compose up -d`;
  return [
    '-i',
    identityPath,
    '-p',
    cfg.port,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'BatchMode=yes',
    `${cfg.user}@${cfg.host}`,
    remoteCmd,
  ];
}

function dockerAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  return {
    target: 'docker',
    deployStyle: 'push',
    async build() {
      // The tool's own CI builds + pushes the container to GHCR (like oci) — nothing to build here.
      return { artifactDir: '.' };
    },
    async deploy(_toolDir, env) {
      const cfg = dockerConfig(ctx.name);
      if (!cfg.host) throw new Error('docker deploy needs DOCKER_SSH_HOST (the host you own)');
      if (!cfg.key) {
        throw new Error("docker deploy needs DOCKER_SSH_KEY (the deploy user's private key)");
      }
      // Write the key to a private temp file for `ssh -i` (never to the repo / a fixed path).
      const dir = mkdtempSync(join(tmpdir(), 'gl-ssh-'));
      const keyPath = join(dir, 'id');
      try {
        writeFileSync(keyPath, cfg.key.endsWith('\n') ? cfg.key : `${cfg.key}\n`);
        chmodSync(keyPath, 0o600); // ssh refuses a world-readable key
        run('ssh', sshDeployArgs(cfg, keyPath), '.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return { url: url(env) };
    },
    url,
    rollback: mutableTagRollback(
      'docker',
      'push a revert commit (the tool CI rebuilds :prod) or `ssh … docker compose pull && up -d` after re-tagging',
    ),
  };
}

function vercelSkeletonAdapter(ctx: AdapterContext): Adapter {
  const url = (env: DeployEnv) => resolveUrl({ domain: ctx.domain, name: ctx.name, env });
  // Vercel deploys ride the project's git integration (Phase 9 / HeistMind); Greenlight
  // configures the project via Terraform, not a push-deploy here. deployStyle:'git' is the
  // contract-level signal — callers branch on it instead of catching these backstop throws.
  const notWired = (): never => {
    throw new Error(
      'vercel deploy rides Vercel git-integration — Greenlight manages its infra, not a push-deploy. (Callers should branch on deployStyle === "git", not reach this.)',
    );
  };
  return {
    target: 'vercel',
    deployStyle: 'git',
    build: async () => notWired(),
    deploy: async () => notWired(),
    url,
  };
}

/** Resolve the adapter for a target, bound to a manifest entry. */
export function createAdapter(target: Target, ctx: AdapterContext): Adapter {
  switch (target) {
    case 'workers':
      return workersAdapter(ctx);
    case 'oci':
      return ociAdapter(ctx);
    case 'docker':
      return dockerAdapter(ctx);
    case 'vercel':
      return vercelSkeletonAdapter(ctx);
  }
}
