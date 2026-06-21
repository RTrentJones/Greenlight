import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type NewTool, addTool, serializeConfig } from '../config-io';
import { loadManifest, resolveEntry } from '../manifest';
import { emitToolTf, providersForTool } from '../tf-emit';
import { MODULE_REF } from '../version';
import { materializeAgentKit } from './agent';
import { parseRepo } from './secrets';

const REF = MODULE_REF; // framework git ref the generated infra pins (centralized in version.ts)

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

/** Option-B, tool side: a provider-agnostic workflow that builds the container, pushes to GHCR,
 * then fires a generic `repository_dispatch(deploy-<name>)` to the wrapper. No OCI here. */
function containerBuildYml(name: string, wrapperRepo: string): string {
  return `name: greenlight-build

# Provider-agnostic: build the container -> push to GHCR -> notify the wrapper to deploy.
# The wrapper owns the OCI infra + creds; this repo only needs GREENLIGHT_DISPATCH_TOKEN
# (a fine-grained PAT with "Contents: write" on ${wrapperRepo}) to fire the dispatch.
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

concurrency:
  group: build-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Resolve image ref (GHCR namespaces are lowercase)
        id: img
        run: echo "ref=ghcr.io/\${GITHUB_REPOSITORY_OWNER,,}/${name}:prod" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/arm64
          push: true
          tags: \${{ steps.img.outputs.ref }}
      - name: Notify wrapper to deploy
        env:
          GH_TOKEN: \${{ secrets.GREENLIGHT_DISPATCH_TOKEN }}
        if: \${{ env.GH_TOKEN != '' }}
        run: |
          gh api repos/${wrapperRepo}/dispatches \\
            -f event_type=deploy-${name} \\
            -F client_payload[sha]=\${{ github.sha }}
`;
}

/** Option-B, wrapper side: on the tool's dispatch, restart the OCI container instance (re-pull)
 * via \`greenlight deploy\`, then post a commit status back to the tool repo (so push->result
 * feedback returns there even though the deploy ran here). OCI creds live ONLY here. */
function deployListenerYml(name: string, toolRepo: string): string {
  return `name: greenlight-deploy-${name}

# Option B: ${toolRepo} fires repository_dispatch(deploy-${name}) after pushing a new image.
on:
  repository_dispatch:
    types: [deploy-${name}]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jdx/mise-action@v2
      - run: pnpm install --frozen-lockfile
      - run: pip install --quiet oci-cli
      - name: Deploy (resolve instance OCID by name -> restart -> re-pull GHCR image)
        env:
          # The OCI CLI reuses the SAME TF_VAR_OCI_* secrets the apply uses — one secret set.
          OCI_CLI_TENANCY: \${{ secrets.TF_VAR_OCI_TENANCY_OCID }}
          OCI_CLI_USER: \${{ secrets.TF_VAR_OCI_USER_OCID }}
          OCI_CLI_FINGERPRINT: \${{ secrets.TF_VAR_OCI_FINGERPRINT }}
          OCI_CLI_KEY_CONTENT: \${{ secrets.TF_VAR_OCI_PRIVATE_KEY }}
          OCI_CLI_REGION: \${{ secrets.TF_VAR_OCI_REGION }}
          OCI_COMPARTMENT_ID: \${{ secrets.TF_VAR_OCI_COMPARTMENT_ID }}
        run: |
          # The instance OCID is abstracted from the developer: resolve it from OCI by the
          # instance's display name (= the tool name, set by the oci-container-instance module).
          # No manually-fetched/stored OCID secret. Compartment falls back to the tenancy (root).
          COMPARTMENT="\${OCI_COMPARTMENT_ID:-\$OCI_CLI_TENANCY}"
          OCID=\$(oci container-instances container-instance list \\
            --compartment-id "\$COMPARTMENT" --display-name ${name} \\
            --lifecycle-state ACTIVE --query 'data.items[0].id' --raw-output 2>/dev/null)
          if [ -z "\$OCID" ] || [ "\$OCID" = "null" ]; then
            echo "::error::no ACTIVE container instance named '${name}' in compartment \$COMPARTMENT"
            exit 1
          fi
          echo "Resolved ${name} instance: \$OCID"
          OCI_CONTAINER_INSTANCE_OCID="\$OCID" pnpm exec greenlight deploy ${name} --env prod
      - name: Verify prod (gate the signal on real health, not just the restart)
        # The deploy "succeeds" only if the NEW image is actually serving. verify has a built-in
        # readiness wait (re-pull + container start). A failure here fails the job → the status
        # posted back is red. oci is verify-gated direct-to-prod (no cheap standing beta on free A1).
        run: pnpm exec greenlight verify ${name} --env prod
      - name: Report status back to ${toolRepo}
        if: \${{ always() && github.event.client_payload.sha != '' }}
        env:
          GH_TOKEN: \${{ secrets.GREENLIGHT_STATUS_TOKEN }}
        run: |
          [ -z "$GH_TOKEN" ] && exit 0
          gh api repos/${toolRepo}/statuses/\${{ github.event.client_payload.sha }} \\
            -f state="\${{ job.status == 'success' && 'success' || 'failure' }}" \\
            -f context="greenlight/deploy-${name}" \\
            -f description="\${{ job.status }}"
`;
}

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

interface AdoptCtx {
  name: string;
  repoArg: string;
  lane: string;
  target: string;
  data: string;
  auth: string;
  envs: string[];
  domain: string;
  reg: Awaited<ReturnType<typeof loadManifest>>['config'];
  regPath: string;
}

export async function adoptCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: greenlight adopt <name> --repo <url|path> --lane <l> --target <t> [--data --auth --envs] [--standalone]\n' +
        '  default: wrap <repo> as a tools/<name> submodule + edit infra in this wrapper + push the loop kit into the tool repo.\n' +
        '  --standalone: scaffold a full self-contained consumer into the tool repo (it owns its whole stack).',
    );
  }
  const repoArg = flag(args, '--repo');
  if (!repoArg) throw new Error('adopt needs --repo <url|path> (the existing tool repo to adopt)');

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

  const ctx: AdoptCtx = { name, repoArg, lane, target, data, auth, envs, domain, reg, regPath };
  if (args.includes('--standalone')) return adoptStandalone(ctx);
  return adoptWrapper(ctx);
}

/**
 * Default (wrapper-centric, the proven HeistMind model): wrap the tool repo as a
 * `tools/<name>` git submodule, edit ITS infra in this wrapper, and push the Greenlight
 * loop kit back INTO the tool repo so dev there runs the same loop. The tool keeps its own
 * history + deploy; the submodule is dev-unification + the wrapper's infra/verify reference.
 */
async function adoptWrapper(ctx: AdoptCtx): Promise<void> {
  const { name, repoArg, lane, target, data, auth, envs, domain, reg, regPath } = ctx;
  const cwd = process.cwd();
  const toolRel = `tools/${name}`;
  const dest = resolve(cwd, toolRel);

  console.log(`adopting "${name}" (${lane}/${target}) as the submodule ${toolRel}\n`);

  // 1) Wrap the repo as a submodule (skip if the dir already exists — re-runs / pre-staged).
  if (!existsSync(dest)) {
    try {
      execFileSync('git', ['submodule', 'add', repoArg, toolRel], { cwd, stdio: 'inherit' });
      console.log(`✔ git submodule add ${repoArg} ${toolRel}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `git submodule add failed (${detail}). Ensure this wrapper is a git repo and <repo> is reachable.`,
      );
    }
  } else {
    console.log(`· ${toolRel} exists — skipping submodule add`);
  }

  // 2) Wrapper manifest: an external pointer with dir = the submodule path.
  const nextReg = addTool(reg, {
    name,
    lane,
    target,
    data,
    auth,
    envs,
    dir: toolRel,
    external: true,
    adopted: true,
  });
  writeFileSync(regPath, serializeConfig(nextReg));
  console.log(`✔ registered "${name}" (external, dir ${toolRel}) in the wrapper manifest`);

  // 3) Infra + verify spec live in the WRAPPER (the tool repo gets none).
  const slug =
    parseRepo(repoArg) ??
    parseRepo(safeGit(dest, ['remote', 'get-url', 'origin'])) ??
    `OWNER/${name}`;
  writeIfAbsent(
    join(cwd, `infra/${name}.tf`),
    emitToolTf({ name, domain, lane, target, data, envs, slug, external: true }),
    `infra/${name}.tf`,
  );
  writeIfAbsent(
    join(cwd, `verify/${name}.config.ts`),
    starterVerifyConfig(lane),
    `verify/${name}.config.ts`,
  );
  const providers = providersForTool({ target, data });
  if (
    existsSync(join(cwd, 'infra/main.tf')) &&
    providers.some((p) => p !== 'cloudflare' && p !== 'github')
  ) {
    console.log(`· ensure infra/main.tf declares provider(s): ${providers.join(', ')}`);
  }

  // 4) Bidirectional kit INTO the tool repo (committed there → travels with the submodule).
  materializeAgentKit(dest, { target, data });
  addGreenlightScript(dest);

  // 5) Event-driven deploy (option B) for container-built targets: the tool builds + pushes +
  // dispatches; the wrapper restarts the instance + reports back. OCI creds stay in the wrapper.
  if (target === 'oci') {
    const wrapperSlug = parseRepo(safeGit(cwd, ['remote', 'get-url', 'origin'])) ?? 'OWNER/REPO';
    writeIfAbsent(
      join(cwd, `.github/workflows/greenlight-deploy-${name}.yml`),
      deployListenerYml(name, slug),
      `.github/workflows/greenlight-deploy-${name}.yml (wrapper deploy listener)`,
    );
    writeIfAbsent(
      join(dest, '.github/workflows/greenlight-build.yml'),
      containerBuildYml(name, wrapperSlug),
      `${toolRel}/.github/workflows/greenlight-build.yml (provider-agnostic build → GHCR → dispatch)`,
    );
  }

  console.log(`
Next:
  (in the tool repo) commit the Greenlight kit + build workflow so they travel with the submodule:
    cd ${toolRel} && git add .claude .mcp.json CLAUDE.md .github && git commit -m "chore: greenlight loop kit + build"
  (in the wrapper) review infra/${name}.tf, then commit the submodule + infra + listener:
    git add .gitmodules ${toolRel} infra/${name}.tf verify/${name}.config.ts greenlight.config.ts .github
    git commit && git push      # CI (infra.yml) applies. Tool's CI builds; wrapper deploys.${
      target === 'oci'
        ? `
  Secrets (guided): greenlight secrets gather ${name} --repo <wrapper>   # TF_VAR_OCI_* + GREENLIGHT_STATUS_TOKEN
                    greenlight secrets gather ${name} --repo ${slug}   # GREENLIGHT_DISPATCH_TOKEN
  The instance OCID is auto-resolved by the deploy workflow (by display name) — nothing to set.`
        : ''
    }`);
}

/**
 * `--standalone`: the self-contained consumer — scaffold the full Greenlight stack
 * (config + merged package.json + vendored tarballs + infra + namespaced workflows + verify
 * + kit) INTO the tool repo, for tools that own their whole stack. Registers an external
 * pointer in the wrapper. (The pre-publish bootstrap; post-publish the deps come from npm.)
 */
async function adoptStandalone(ctx: AdoptCtx): Promise<void> {
  const { name, repoArg, lane, target, data, auth, envs, domain, reg, regPath } = ctx;
  const repo = resolve(process.cwd(), repoArg);
  if (!existsSync(repo)) throw new Error(`no such repo: ${repo} (--standalone needs a local path)`);

  // Source of the bootstrap tarballs = the registry repo's vendor/.
  const regVendor = resolve(process.cwd(), 'vendor');
  const vendor = vendorDeps(regVendor);
  if (Object.keys(vendor).length === 0) {
    throw new Error(
      "no vendor/*.tgz in this repo — --standalone bootstraps the tool from the registry repo's vendored tarballs (or publish to npm first)",
    );
  }

  console.log(`adopting "${name}" (${lane}/${target}) into ${repo} (standalone)\n`);

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
  cd ${repoArg}
  pnpm install
  echo -n "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN
  git checkout -b develop && git push -u origin develop
  greenlight preview ${name}        # local; or deploy --env beta once creds are set
Note: deploying ${target} needs the ${target} adapter (workers is built; oci/vercel are follow-ups).`);
}

/** Add a `greenlight` npm script (runnable via npx post-publish) to a Node tool's existing
 * package.json. For a non-Node tool (no package.json — e.g. a Python MCP server), DON'T
 * fabricate one; the loop is still runnable via `npx @rtrentjones/greenlight`. */
function addGreenlightScript(dir: string): void {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log(
      '· no package.json (non-Node tool) — run the loop via `npx @rtrentjones/greenlight`',
    );
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  pkg.scripts = { ...(pkg.scripts ?? {}) };
  if (pkg.scripts.greenlight) {
    console.log('· package.json already has a greenlight script');
    return;
  }
  pkg.scripts.greenlight = 'npx @rtrentjones/greenlight';
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('✔ package.json (greenlight script — runnable via npx post-publish)');
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
