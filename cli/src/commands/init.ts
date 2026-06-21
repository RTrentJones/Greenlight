import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { scaffoldConfig } from '../config-io';
import { ensureTokensForTool } from '../tokens';
import { MODULE_REF } from '../version';
import { syncSecrets } from './secrets';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Published npm range matching the module tag, e.g. v0.2.9 → ^0.2.9. */
const NPM_DEP = `^${MODULE_REF.replace(/^v/, '')}`;

function wrapperPackageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      scripts: { greenlight: 'greenlight' },
      dependencies: { '@rtrentjones/greenlight': NPM_DEP },
    },
    null,
    2,
  )}\n`;
}

const WRAPPER_GITIGNORE = `# Greenlight wrapper
node_modules/
.greenlight/        # gathered tokens — never committed
.terraform/
*.tfplan
tf.plan
dist/
`;

const WRAPPER_MISE = `[tools]
node = "24"
pnpm = "10.12.1"
`;

/** The apply-on-push CI: HCP-backed Terraform, provider creds from GitHub secrets. Maps the full
 * V1 provider set — unset secrets resolve empty (harmless for providers no tool uses yet); each
 * tool's keys are populated by \`greenlight secrets gather <tool>\`. */
function wrapperInfraYml(): string {
  return `name: infra

# Apply the wrapper's Terraform on push to main (paths: infra/**). State + locking are in HCP
# Terraform (set the cloud{} block in infra/main.tf); the run happens here with provider creds
# from GitHub Actions secrets (populate them per tool via \`greenlight secrets gather\`).
on:
  push:
    branches: [main]
    paths: ['infra/**']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: infra
  cancel-in-progress: false # never interrupt an in-flight apply

jobs:
  apply:
    runs-on: ubuntu-latest
    env:
      TF_TOKEN_app_terraform_io: \${{ secrets.TF_API_TOKEN }} # HCP state backend auth
      GITHUB_TOKEN: \${{ github.token }} # github provider (branch/protection); creates nothing risky
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      TF_VAR_cloudflare_zone_id: \${{ secrets.TF_VAR_CLOUDFLARE_ZONE_ID }}
      TF_VAR_cloudflare_account_id: \${{ secrets.TF_VAR_CLOUDFLARE_ACCOUNT_ID }}
      # vercel (target: vercel tools)
      VERCEL_API_TOKEN: \${{ secrets.VERCEL_API_TOKEN }}
      # supabase (data: supabase tools)
      SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}
      TF_VAR_supabase_database_password: \${{ secrets.TF_VAR_SUPABASE_DATABASE_PASSWORD }}
      # oci (target: oci tools) — VCN/subnet/AD are IaC; only auth (+ optional compartment) here
      TF_VAR_oci_tenancy_ocid: \${{ secrets.TF_VAR_OCI_TENANCY_OCID }}
      TF_VAR_oci_user_ocid: \${{ secrets.TF_VAR_OCI_USER_OCID }}
      TF_VAR_oci_fingerprint: \${{ secrets.TF_VAR_OCI_FINGERPRINT }}
      TF_VAR_oci_private_key: \${{ secrets.TF_VAR_OCI_PRIVATE_KEY }}
      TF_VAR_oci_region: \${{ secrets.TF_VAR_OCI_REGION }}
      TF_VAR_oci_compartment_id: \${{ secrets.TF_VAR_OCI_COMPARTMENT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: '~1.10'
          terraform_wrapper: false
      - run: terraform -chdir=infra init -input=false
      - run: terraform -chdir=infra plan -input=false -out=tf.plan
      - run: terraform -chdir=infra apply -input=false tf.plan
`;
}

function scaffoldIfAbsent(path: string, contents: string, label: string): void {
  if (existsSync(path)) {
    console.log(`· ${label} exists — left as-is`);
    return;
  }
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  console.log(`✔ wrote ${label}`);
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

  // Scaffold the rest of a runnable thin wrapper (never clobber existing files).
  const repoName = domain.replace(/\./g, '-');
  scaffoldIfAbsent(
    resolve(cwd, '.github/workflows/infra.yml'),
    wrapperInfraYml(),
    '.github/workflows/infra.yml (HCP-backed terraform apply on push)',
  );
  scaffoldIfAbsent(resolve(cwd, '.gitignore'), WRAPPER_GITIGNORE, '.gitignore');
  scaffoldIfAbsent(resolve(cwd, 'package.json'), wrapperPackageJson(repoName), 'package.json');
  scaffoldIfAbsent(resolve(cwd, 'mise.toml'), WRAPPER_MISE, 'mise.toml');
  scaffoldIfAbsent(resolve(cwd, '.node-version'), '24\n', '.node-version');

  const secrets: string[] = [];
  for (const [f, key] of Object.entries(TOKEN_FLAGS)) {
    const v = flag(args, f);
    if (v) secrets.push(`${key}=${v}`);
  }
  if (secrets.length > 0) {
    mkdirSync(resolve(cwd, '.greenlight'), { recursive: true });
    writeFileSync(resolve(cwd, '.greenlight/secrets.env'), `${secrets.join('\n')}\n`, {
      mode: 0o600,
    });
    console.log(`✔ wrote .greenlight/secrets.env (${secrets.length} token(s), gitignored)`);
  }

  // Interactive: gather + fail-fast verify the always-on provider tokens (Cloudflare / HCP /
  // GitHub) from the registry. TTY only — CI uses the --*-token flags above. `--no-tokens` skips.
  if (process.stdin.isTTY && !args.includes('--no-tokens')) {
    try {
      await ensureTokensForTool(cwd, {}, { verify: !args.includes('--no-verify') });
    } catch (e) {
      console.log(`✖ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Push whatever's in secrets.env to GitHub Actions secrets (best-effort, one-and-done).
  let pushed = false;
  if (existsSync(resolve(cwd, '.greenlight/secrets.env')) && !args.includes('--no-push')) {
    try {
      const { repo, count } = syncSecrets({ cwd, repo: flag(args, '--repo') });
      console.log(`✔ pushed ${count} secret(s) to ${repo} (GitHub Actions)`);
      pushed = true;
    } catch (e) {
      console.log(`! skipped pushing secrets: ${e instanceof Error ? e.message : String(e)}`);
      console.log('  run `greenlight secrets sync` once `gh` is authenticated.');
    }
  }

  console.log(`
Next:
  1. greenlight add <name> --lane <lane> --target <target>   # scaffold a tool, emit infra, and
                                                             # gather THAT tool's keys → GitHub${
                                                               pushed
                                                                 ? ''
                                                                 : '\n  (run `greenlight secrets sync` if base tokens were not pushed)'
                                                             }
  2. set the HCP backend (cloud{} org + workspace) in infra/main.tf   # docs/terraform-state-r2.md
  3. commit + push → CI (.github/workflows/infra.yml) runs \`terraform apply\`
  4. greenlight verify <name> --env prod   |   greenlight doctor`);
}
