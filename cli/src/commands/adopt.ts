import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type NewTool, addTool, serializeConfig } from '../config-io';
import { loadManifest, resolveEntry } from '../manifest';
import { materializeAgentKit } from './agent';
import { parseRepo } from './secrets';

const REF = 'v0.1.0'; // framework git ref the generated infra pins (tag when publishing)

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// --- pure-ish generators (the personal site repo's files are the template) ---

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string>; [k: string]: unknown };
  [k: string]: unknown;
}

/** Merge framework deps + pnpm.overrides + a `greenlight` script into an existing
 * package.json, preserving everything the app already has. Pure (tested). */
export function mergePackageJson(
  existing: PackageJson | null,
  repoName: string,
  vendor: Record<string, string>,
): PackageJson {
  const pkg: PackageJson = existing
    ? { ...existing }
    : { name: repoName, version: '0.0.0', private: true, type: 'module' };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), ...vendor };
  pkg.scripts = { ...(pkg.scripts ?? {}) };
  if (!pkg.scripts.greenlight) pkg.scripts.greenlight = 'greenlight';
  pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides: { ...(pkg.pnpm?.overrides ?? {}), ...vendor } };
  return pkg;
}

/** Map vendored `*.tgz` filenames back to `@rtrentjones/<pkg>` → `file:vendor/<file>`. */
function vendorDeps(vendorDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(vendorDir)) return out;
  for (const f of readdirSync(vendorDir)) {
    if (!f.endsWith('.tgz')) continue;
    const base = f.replace(/-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/, ''); // strip -<semver>.tgz
    out[`@${base.replace('-', '/')}`] = `file:vendor/${f}`; // first dash → scope slash
  }
  return out;
}

function starterVerifyConfig(lane: string): string {
  const spec =
    lane === 'mcp'
      ? "{ mode: 'mcp', expectTools: [] }"
      : "{ mode: 'api', checks: [{ path: '/', status: 200 }] }";
  return `// Greenlight verify spec — edit to assert this tool's real contract.\nexport default ${spec};\n`;
}

function infraTf(
  name: string,
  domain: string,
  lane: string,
  target: string,
  data: string,
  envs: string[],
  slug: string,
): string {
  const owner = slug.includes('/') ? slug.split('/')[0] : 'OWNER';
  const repo = slug.includes('/') ? slug.split('/')[1] : 'REPO';
  const e = envs.map((x) => `"${x}"`).join(', ');
  return `terraform {
  required_version = ">= 1.7"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
    github     = { source = "integrations/github", version = "~> 6.0" }
  }
}

provider "cloudflare" {}
provider "github" { owner = "${owner}" }

variable "cloudflare_zone_id" { type = string }

module "tool" {
  source      = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/tool?ref=${REF}"
  name        = "${name}"
  domain      = "${domain}"
  zone_id     = var.cloudflare_zone_id
  github_repo = "${slug}"
  lane        = "${lane}"
  target      = "${target}"
  data        = "${data}"
  envs        = [${e}]
}

module "repo" {
  source          = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/repo?ref=${REF}"
  repository      = "${repo}"
  required_checks = ["deploy"]
}

output "prod_url" { value = module.tool.prod_url }
`;
}

function deployYml(name: string): string {
  return `name: deploy

# develop -> beta, main -> prod. Creds-guarded; calls the Greenlight CLI.
on:
  push:
    branches: [develop, main]

permissions:
  contents: read

concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jdx/mise-action@v2
      - run: pnpm install --frozen-lockfile
      - name: Resolve target env
        id: env
        run: |
          if [ "\${{ github.ref }}" = "refs/heads/main" ]; then
            echo "env=prod" >> "$GITHUB_OUTPUT"
          else
            echo "env=beta" >> "$GITHUB_OUTPUT"
          fi
      - name: Check Cloudflare creds
        id: creds
        env:
          CF: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: if [ -n "$CF" ]; then echo "have=1" >> "$GITHUB_OUTPUT"; else echo "have=0" >> "$GITHUB_OUTPUT"; fi
      - name: Deploy + verify
        if: steps.creds.outputs.have == '1'
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          pnpm exec greenlight deploy ${name} --env "\${{ steps.env.outputs.env }}"
          pnpm exec greenlight verify ${name} --env "\${{ steps.env.outputs.env }}"
      - name: Skip notice
        if: steps.creds.outputs.have != '1'
        run: echo "No CLOUDFLARE_API_TOKEN secret — deploy/verify skipped."
`;
}

function promoteYml(name: string): string {
  return `name: promote

# Gated develop -> main fast-forward: verify beta -> FF -> deploy + verify prod.
on:
  workflow_dispatch:

permissions:
  contents: write

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jdx/mise-action@v2
      - run: pnpm install --frozen-lockfile
      - run: git fetch --no-tags origin main develop
      - name: Check Cloudflare creds
        id: creds
        env:
          CF: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: if [ -n "$CF" ]; then echo "have=1" >> "$GITHUB_OUTPUT"; else echo "have=0" >> "$GITHUB_OUTPUT"; fi
      - name: Verify beta (gate)
        if: steps.creds.outputs.have == '1'
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: pnpm exec greenlight verify ${name} --env beta
      - name: Promote (gated fast-forward)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          pnpm exec greenlight promote ${name} --perform --push
      - name: Deploy + verify prod
        if: steps.creds.outputs.have == '1'
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          pnpm exec greenlight deploy ${name} --env prod
          pnpm exec greenlight verify ${name} --env prod
`;
}

const MISE_TOML = `# Toolchain, managed by mise. \`mise install\` to set up.
[tools]
node = "24"
pnpm = "10.12.1"
`;

function writeIfAbsent(path: string, contents: string, label: string): void {
  if (existsSync(path)) {
    console.log(`· ${label} exists — left as-is`);
    return;
  }
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  console.log(`✔ ${label}`);
}

// --- the command ---

export async function adoptCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: greenlight adopt --repo <path> <name> --lane <l> --target <t> [--data --auth --envs]\n' +
        '  (run from your site/registry repo; scaffolds the consumer into <path>)',
    );
  }
  const repoPath = flag(args, '--repo');
  if (!repoPath) throw new Error('adopt needs --repo <path> (the existing tool repo to adopt)');
  const repo = resolve(process.cwd(), repoPath);
  if (!existsSync(repo)) throw new Error(`no such repo: ${repo}`);

  const lane = flag(args, '--lane');
  const target = flag(args, '--target');
  if (!lane || !target) throw new Error('adopt needs --lane and --target');
  const data = flag(args, '--data') ?? 'none';
  const auth = flag(args, '--auth') ?? 'none';
  const envs = flag(args, '--envs')?.split(',') ?? ['beta', 'prod'];

  // The cwd is the central registry (the site repo). Must be a real manifest.
  const { path: regPath, config: reg } = await loadManifest();
  if (regPath.endsWith('.example.ts')) {
    throw new Error(
      'run adopt from your site repo (needs a real greenlight.config.ts; run `greenlight init` first)',
    );
  }
  if (reg.tools.some((t) => t.name === name) || name === 'blog') {
    throw new Error(`"${name}" already in the registry`);
  }
  const domain = flag(args, '--domain') ?? reg.domain;

  // Source of the bootstrap tarballs = the registry repo's vendor/.
  const regVendor = resolve(process.cwd(), 'vendor');
  const vendor = vendorDeps(regVendor);
  if (Object.keys(vendor).length === 0) {
    throw new Error(
      "no vendor/*.tgz in this repo — adopt bootstraps the tool from the registry repo's vendored tarballs (or publish to npm first)",
    );
  }

  console.log(`adopting "${name}" (${lane}/${target}) into ${repo}\n`);

  // 1) tool repo greenlight.config.ts (one tool, no blog)
  const toolEntry: NewTool = { name, lane, target, data, auth, envs, dir: '.', adopted: true };
  const toolConfig = addTool({ domain, alerts: { sink: 'github-issue' }, tools: [] }, toolEntry);
  writeIfAbsent(
    join(repo, 'greenlight.config.ts'),
    serializeConfig(toolConfig),
    'greenlight.config.ts',
  );

  // 2) package.json — merge (never clobber app deps/scripts)
  const slug = parseRepo(safeGit(repo, ['remote', 'get-url', 'origin'])) ?? `OWNER/${name}`;
  const pkgPath = join(repo, 'package.json');
  const existingPkg = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson)
    : null;
  writeFileSync(
    pkgPath,
    `${JSON.stringify(mergePackageJson(existingPkg, name, vendor), null, 2)}\n`,
  );
  console.log('✔ package.json (merged framework deps + overrides)');

  // 3) vendor the bootstrap tarballs
  const repoVendor = join(repo, 'vendor');
  mkdirSync(repoVendor, { recursive: true });
  for (const f of readdirSync(regVendor)) {
    if (f.endsWith('.tgz')) cpSync(join(regVendor, f), join(repoVendor, f));
  }
  console.log(`✔ vendor/ (${Object.keys(vendor).length} tarballs)`);

  // 4) infra
  writeIfAbsent(
    join(repo, 'infra/main.tf'),
    infraTf(name, domain, lane, target, data, envs, slug),
    'infra/main.tf',
  );
  // 5) workflows (namespaced to avoid clobbering the repo's existing CI)
  writeIfAbsent(
    join(repo, '.github/workflows/greenlight-deploy.yml'),
    deployYml(name),
    '.github/workflows/greenlight-deploy.yml',
  );
  writeIfAbsent(
    join(repo, '.github/workflows/greenlight-promote.yml'),
    promoteYml(name),
    '.github/workflows/greenlight-promote.yml',
  );
  // 6) verify spec
  writeIfAbsent(join(repo, 'verify.config.ts'), starterVerifyConfig(lane), 'verify.config.ts');
  // 7) agent kit (MCP tailored to the tool's target/data)
  materializeAgentKit(repo, { target, data });
  // 8) toolchain
  writeIfAbsent(join(repo, 'mise.toml'), MISE_TOML, 'mise.toml');
  writeIfAbsent(join(repo, '.node-version'), '24\n', '.node-version');

  // 9) central registry entry (external pointer) in the cwd manifest
  const nextReg = addTool(reg, {
    name,
    lane,
    target,
    data,
    auth,
    envs,
    external: true,
    adopted: true,
  });
  writeFileSync(regPath, serializeConfig(nextReg));
  console.log(`✔ registered "${name}" in ${regPath.replace(`${process.cwd()}/`, '')} (external)`);

  console.log(`
Next (in the adopted repo):
  cd ${repoPath}
  pnpm install
  echo -n "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN
  git checkout -b develop && git push -u origin develop
  greenlight preview ${name}        # local; or deploy --env beta once creds are set
Note: deploying ${target} needs the ${target} adapter (workers is built; oci/vercel are follow-ups).`);
}

function safeGit(cwd: string, gitArgs: string[]): string {
  try {
    return execFileSync('git', gitArgs, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}
