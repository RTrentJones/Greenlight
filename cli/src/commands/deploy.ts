import { createAdapter } from '@rtrentjones/greenlight-adapters';
import type { DeployEnv } from '@rtrentjones/greenlight-shared';
import { loadManifest, resolveEntry } from '../manifest';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Build + deploy a manifest entry to an env via its target adapter, printing the
 * deterministic URL. The real cloud deploy needs the target's creds (e.g.
 * CLOUDFLARE_API_TOKEN); the build step runs regardless.
 */
export async function deployCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error('usage: greenlight deploy <name> --env <preview|beta|prod>');
  }
  const env = flag(args, '--env') as DeployEnv | undefined;
  if (env !== 'preview' && env !== 'beta' && env !== 'prod') {
    throw new Error('deploy needs --env preview|beta|prod');
  }

  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  const adapter = createAdapter(entry.target, { domain: config.domain, name: entry.name });

  console.log(`build ${name} (${entry.lane}/${entry.target}) in ${entry.dir}`);
  await adapter.build(entry.dir);
  console.log(`deploy ${name} → ${env}`);
  const { url } = await adapter.deploy(entry.dir, env);
  console.log(`✔ deployed: ${url}`);
  if (entry.lane === 'mcp') console.log(`  connect: ${url}/mcp`);
}
