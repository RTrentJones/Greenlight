import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { scaffoldConfig } from '../config-io';
import { syncSecrets } from './secrets';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Token flag → provider-store env var. Stored only in the local gitignored file (+ later provider stores). */
const TOKEN_FLAGS: Record<string, string> = {
  '--cf-token': 'CLOUDFLARE_API_TOKEN',
  '--github-token': 'GITHUB_TOKEN',
  '--vercel-token': 'VERCEL_TOKEN',
  '--supabase-url': 'SUPABASE_URL',
  '--supabase-key': 'SUPABASE_SERVICE_ROLE_KEY',
};

export async function initCommand(args: string[]): Promise<void> {
  const force = args.includes('--force');
  let domain = flag(args, '--domain');
  if (!domain) {
    if (!process.stdin.isTTY) throw new Error('init needs --domain <domain> (no TTY for prompts)');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    domain = (await rl.question('Domain (e.g. example.dev): ')).trim();
    rl.close();
  }
  if (!domain) throw new Error('a domain is required');

  const cwd = process.cwd();
  const configPath = resolve(cwd, 'greenlight.config.ts');
  if (existsSync(configPath) && !force) {
    throw new Error('greenlight.config.ts already exists — pass --force to overwrite');
  }
  writeFileSync(configPath, scaffoldConfig(domain));
  console.log(`✔ wrote greenlight.config.ts (domain: ${domain})`);

  const secrets: string[] = [];
  for (const [f, key] of Object.entries(TOKEN_FLAGS)) {
    const v = flag(args, f);
    if (v) secrets.push(`${key}=${v}`);
  }
  let pushed = false;
  if (secrets.length > 0) {
    mkdirSync(resolve(cwd, '.greenlight'), { recursive: true });
    writeFileSync(resolve(cwd, '.greenlight/secrets.env'), `${secrets.join('\n')}\n`, {
      mode: 0o600,
    });
    console.log(`✔ wrote .greenlight/secrets.env (${secrets.length} token(s), gitignored)`);

    // One-and-done: also push the tokens to GitHub Actions secrets (best-effort).
    if (!args.includes('--no-push')) {
      try {
        const { repo, count } = syncSecrets({ cwd, repo: flag(args, '--repo') });
        console.log(`✔ pushed ${count} secret(s) to ${repo} (GitHub Actions)`);
        pushed = true;
      } catch (e) {
        console.log(`! skipped pushing secrets: ${e instanceof Error ? e.message : String(e)}`);
        console.log('  run `greenlight secrets sync` once `gh` is authenticated.');
      }
    }
  }

  console.log(`
Next:
  greenlight add <name> --lane mcp --target oci   # scaffold a tool${
    pushed
      ? ''
      : '\n  greenlight secrets sync                         # push tokens to GitHub Actions'
  }
  greenlight doctor                               # check consistency
  terraform -chdir=infra apply                    # branches/protection/DNS (module "repo"/"tool")
  greenlight deploy blog --env prod               # first live deploy`);
}
