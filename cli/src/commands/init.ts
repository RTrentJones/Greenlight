import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { scaffoldConfig } from '../config-io';
import { ensureTokensForTool } from '../tokens';
import { MODULE_REF } from '../version';
import { detectRepo, setGitHubSecret } from './secrets';

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
.greenlight/        # local scratch — never committed (tokens live in GitHub Actions)
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
#
# Two-job gate: \`plan\` runs free and FAILS FAST if the plan would delete/replace a stateful prod
# store (a prevent_destroy substitute — the stores live inside the Greenlight modules, so the guard
# lives here in CI). \`apply\` then waits on the \`production\` environment's manual approval, so a
# human reviews the (visible) plan before anything touches irreplaceable data.
# ARM THE GATE: repo Settings -> Environments -> production -> Required reviewers (free on public
# repos). Until it's armed, apply runs unattended — the destroy plan-guard still protects the data.
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

# Workflow-level so BOTH jobs (plan + apply) inherit the provider creds without duplication.
env:
  TF_TOKEN_app_terraform_io: \${{ secrets.TF_API_TOKEN }} # HCP state backend auth
  GITHUB_TOKEN: \${{ github.token }} # github provider (branch/protection); creates nothing risky
  CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
  # zone/account ids are enumerable identifiers, not secrets — repo VARIABLES (vars.*)
  TF_VAR_cloudflare_zone_id: \${{ vars.CLOUDFLARE_ZONE_ID }}
  TF_VAR_cloudflare_account_id: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}
  # vercel (target: vercel tools)
  VERCEL_API_TOKEN: \${{ secrets.VERCEL_API_TOKEN }}
  # supabase (data: supabase tools)
  SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}
  TF_VAR_supabase_database_password: \${{ secrets.TF_VAR_SUPABASE_DATABASE_PASSWORD }}
  # neon (data: neon tools) — the neon provider reads NEON_API_KEY natively
  NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
  # oci (target: oci tools) — VCN/subnet/AD are IaC; only auth (+ optional compartment) here
  TF_VAR_oci_tenancy_ocid: \${{ secrets.TF_VAR_OCI_TENANCY_OCID }}
  TF_VAR_oci_user_ocid: \${{ secrets.TF_VAR_OCI_USER_OCID }}
  TF_VAR_oci_fingerprint: \${{ secrets.TF_VAR_OCI_FINGERPRINT }}
  TF_VAR_oci_private_key: \${{ secrets.TF_VAR_OCI_PRIVATE_KEY }}
  TF_VAR_oci_region: \${{ secrets.TF_VAR_OCI_REGION }}
  TF_VAR_oci_compartment_id: \${{ secrets.TF_VAR_OCI_COMPARTMENT_ID }}

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: '~1.10'
          terraform_wrapper: false
      - run: terraform -chdir=infra init -input=false
      - run: terraform -chdir=infra plan -input=false -out=tf.plan
      # Data-loss backstop: FAIL — before any approval — if the plan would delete/replace a stateful
      # prod store. Matches by resource TYPE (robust to address renames). Extend the regex if you add a
      # Terraform-managed store with irreplaceable data. To intentionally tear one down, remove this
      # guard or apply locally — the same friction prevent_destroy imposes on purpose.
      - name: Guard — no destroy of a stateful prod store
        run: |
          terraform -chdir=infra show -json tf.plan > tf.plan.json
          DESTROYS=$(jq -r '[.resource_changes[] | select(.change.actions | index("delete")) | select(.type | test("^(supabase_project|neon_project|neon_branch|cloudflare_d1_database|cloudflare_r2_bucket)$")) | .address] | .[]' tf.plan.json)
          if [ -n "$DESTROYS" ]; then
            echo "::error::plan would destroy/replace a stateful prod store — blocking apply:"
            echo "$DESTROYS"
            exit 1
          fi
          echo "plan-guard: OK (no destroy/replace of a stateful prod store)"
      - name: Upload the verified plan
        uses: actions/upload-artifact@v4
        with:
          name: tf-plan
          path: infra/tf.plan
          retention-days: 1
          if-no-files-found: error

  apply:
    needs: plan
    runs-on: ubuntu-latest
    # Manual approval gate — arm it via Settings -> Environments -> production -> Required reviewers.
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: '~1.10'
          terraform_wrapper: false
      - uses: actions/download-artifact@v4
        with:
          name: tf-plan
          path: infra
      # Re-init providers (from the committed lock), then apply the SAVED plan (Terraform rejects it
      # if state drifted since plan; concurrency keeps runs serial).
      - run: terraform -chdir=infra init -input=false
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

/** Token flag → GitHub Actions secret name. Pushed straight to GitHub (no disk); a GITHUB_* name is
 * skipped (reserved by Actions, and the built-in token covers it). */
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

  // The wrapper's GitHub repo — the single secret store. Tokens are pushed STRAIGHT to GitHub
  // Actions (never written to disk). Without a repo yet (fresh dir / no remote), token-setting is
  // deferred with guidance.
  const repo = flag(args, '--repo') ?? detectRepo(cwd);

  // Non-interactive seeding: every `--*-token` flag is pushed straight to GitHub Actions (value
  // never on disk). GITHUB_* names are reserved by Actions (and the built-in token covers it), so
  // they're skipped. Needs a repo + an authenticated `gh`.
  let pushed = 0;
  if (repo && !args.includes('--no-push')) {
    for (const [f, key] of Object.entries(TOKEN_FLAGS)) {
      const v = flag(args, f);
      if (!v || key.startsWith('GITHUB_')) continue;
      try {
        setGitHubSecret(repo, undefined, key, v);
        console.log(`✔ set ${key} → ${repo} (GitHub Actions)`);
        pushed++;
      } catch (e) {
        console.log(`! could not set ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Interactive: gather + fail-fast verify the always-on base tokens (Cloudflare / HCP Terraform)
  // straight to GitHub Actions. TTY only; CI uses the --*-token flags above. `--no-tokens` skips.
  if (process.stdin.isTTY && !args.includes('--no-tokens')) {
    if (repo) {
      try {
        const results = await ensureTokensForTool(
          repo,
          {},
          {
            verify: !args.includes('--no-verify'),
          },
        );
        pushed += results.filter((r) => r.outcome === 'entered').length;
      } catch (e) {
        console.log(`✖ ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log(
        '\n· no GitHub repo detected yet — create it + `gh auth login`, then set the base secrets\n' +
          '  (CLOUDFLARE_API_TOKEN, TF_API_TOKEN) via `greenlight add <tool>` (prompts them) or `gh secret set`.',
      );
    }
  }

  console.log(`
Next:
  1. greenlight add <name> --lane <lane> --target <target>   # scaffold a tool, emit infra, and
                                                             # gather THAT tool's keys → GitHub${
                                                               pushed
                                                                 ? ''
                                                                 : '\n  (it also prompts the base tokens if they are not set yet)'
                                                             }
  2. set the HCP backend (cloud{} org + workspace) in infra/main.tf   # docs/terraform-state.md
  3. commit + push → CI (.github/workflows/infra.yml) runs \`terraform apply\`
  4. greenlight verify <name> --env prod   |   greenlight doctor`);
}
