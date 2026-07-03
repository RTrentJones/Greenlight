import { createAdapter } from '@rtrentjones/greenlight-adapters';
import type { DeployEnv } from '@rtrentjones/greenlight-shared';
import { parseFlags } from '../args';
import { loadManifest, resolveEntry } from '../manifest';

/**
 * Build + deploy a manifest entry to an env via its target adapter, printing the
 * deterministic URL. The real cloud deploy needs the target's creds (e.g.
 * CLOUDFLARE_API_TOKEN); the build step runs regardless.
 */
export async function deployCommand(args: string[]): Promise<number> {
  const parsed = parseFlags('deploy', args, { value: ['--env'] });
  const name = parsed.positional[0];
  if (!name) {
    throw new Error('usage: greenlight deploy <name> --env <preview|beta|prod>');
  }
  const env = parsed.values['--env'] as DeployEnv | undefined;
  if (env !== 'preview' && env !== 'beta' && env !== 'prod') {
    throw new Error('deploy needs --env preview|beta|prod');
  }

  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  // External tools (registry pointers) have no local app code to build here. For container targets
  // (oci: restart the instance; docker: SSH `compose pull && up -d`) "deploy" re-pulls the GHCR image
  // the tool's OWN CI built — legitimately run from the wrapper, which owns the host/instance. For
  // other targets an external tool deploys from its own repo (e.g. Vercel git integration).
  if (entry.external && entry.target !== 'oci' && entry.target !== 'docker') {
    throw new Error(`"${name}" is external (registry pointer) — deploy it from its own repo`);
  }
  const adapter = createAdapter(entry.target, { domain: config.domain, name: entry.name });

  // Git-integration targets (vercel) deploy on push to THEIR repo — branch on the contract's
  // deployStyle instead of catching the adapter's backstop throw.
  if (adapter.deployStyle === 'git') {
    console.log(
      `"${name}" deploys via ${entry.target}'s git integration — push to its repo to deploy; Greenlight manages its infra and verifies the deployment (greenlight verify ${name} --env ${env}).`,
    );
    return 0;
  }

  console.log(`build ${name} (${entry.lane}/${entry.target}) in ${entry.dir}`);
  await adapter.build(entry.dir, env);
  console.log(`deploy ${name} → ${env}`);
  const { url } = await adapter.deploy(entry.dir, env);
  console.log(`✔ deployed: ${url}`);
  if (entry.lane === 'mcp') console.log(`  connect: ${url}/mcp`);
  return 0;
}
