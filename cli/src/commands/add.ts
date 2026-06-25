import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MATRIX, describeMatrix } from '@rtrentjones/greenlight-shared';
import { emitAgentDeployWorkflow } from '../agent-deploy';
import { templatesRoot } from '../asset-paths';
import { addTool, serializeConfig } from '../config-io';
import { loadManifest } from '../manifest';
import { emitToolTf, emitWrapperMainTf, providersForTool } from '../tf-emit';
import { materializeAgentKit } from './agent';
import { detectRepo, gatherSecrets } from './secrets';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Lane template dir (bundled in the CLI package, or the repo in dev); mcp has oci|workers subdirs. */
function templateDir(lane: string, target: string): string {
  const base = join(templatesRoot(), `_template-${lane}`);
  return lane === 'mcp' ? join(base, target) : base;
}

/** Ensure `member` (e.g. "tools/foo") is a pnpm workspace package, so the root install resolves the
 * tool's deps. No-op if already listed or covered by a `tools/*` glob. Idempotent; order-agnostic. */
export function registerWorkspaceMember(cwd: string, member: string): void {
  const wsPath = join(cwd, 'pnpm-workspace.yaml');
  if (!existsSync(wsPath)) {
    writeFileSync(wsPath, `packages:\n  - "${member}"\n`);
    console.log(`✔ created pnpm-workspace.yaml (member ${member})`);
    return;
  }
  const text = readFileSync(wsPath, 'utf8');
  if (text.includes(member) || /^\s*-\s*["']?tools\/\*/m.test(text)) return; // already covered
  const lines = text.split('\n');
  const pkgIdx = lines.findIndex((l) => /^packages\s*:/.test(l));
  if (pkgIdx === -1) {
    writeFileSync(wsPath, `${text.replace(/\s*$/, '')}\npackages:\n  - "${member}"\n`);
  } else {
    lines.splice(pkgIdx + 1, 0, `  - "${member}"`);
    writeFileSync(wsPath, lines.join('\n'));
  }
  console.log(`✔ registered ${member} in pnpm-workspace.yaml`);
}

export async function addCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: greenlight add <name> --lane <lane> --target <target> [--data <d>] [--auth <a>] [--envs beta,prod] [--port 8000] [--share <owner>]',
    );
  }
  const lane = flag(args, '--lane');
  const target = flag(args, '--target');
  if (!lane || !target) {
    throw new Error(
      `add needs --lane and --target. Valid combinations:\n${describeMatrix()}\n  (defaults: next→vercel; astro/mcp/agent→workers)`,
    );
  }
  if (!(lane in MATRIX)) {
    throw new Error(`unknown lane "${lane}". Valid lanes:\n${describeMatrix()}`);
  }
  const rule = MATRIX[lane as keyof typeof MATRIX];
  if (!rule.targets.includes(target as (typeof rule.targets)[number])) {
    throw new Error(
      `lane "${lane}" can't target "${target}" — valid target(s): ${rule.targets.join(' | ')}`,
    );
  }

  const { config, path } = await loadManifest();
  if (path.endsWith('.example.ts')) {
    throw new Error('no greenlight.config.ts — run `greenlight init` first');
  }

  // Validates the lane × target × data matrix via the schema.
  const portFlag = flag(args, '--port');
  const next = addTool(config, {
    name,
    lane,
    target,
    data: flag(args, '--data'),
    auth: flag(args, '--auth'),
    envs: flag(args, '--envs')?.split(','),
    port: portFlag ? Number(portFlag) : undefined,
    // --share <owner>: this tool reads the owner's Neon DB instead of creating its own (one DB, many services).
    dataShareWith: flag(args, '--share'),
  });
  const entry = next.tools.find((t) => t.name === name);
  const data = entry?.data ?? 'none';
  const envs = entry?.envs ?? ['beta', 'prod'];
  const toolInfo = { lane, target, data };

  const dest = resolve(process.cwd(), 'tools', name);
  if (existsSync(dest)) throw new Error(`tools/${name} already exists`);
  const src = templateDir(lane, target);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    // Rename the copied package.json so workspace tool names don't collide.
    const pkgPath = join(dest, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.name = name;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    // Templates ship `.gitignore` as `gitignore` (npm drops dotfiles from the tarball) — restore it.
    const shippedGitignore = join(dest, 'gitignore');
    if (existsSync(shippedGitignore)) renameSync(shippedGitignore, join(dest, '.gitignore'));
    // Agent (workers) templates carry a wrangler.toml with a placeholder name + route domain — bind
    // those to this tool. The account id + KV namespace id stay placeholders that the emitted deploy
    // workflow resolves in CI (the local loop has no secrets — v0.4.0; see agent-deploy.ts).
    const wranglerPath = join(dest, 'wrangler.toml');
    if (existsSync(wranglerPath)) {
      const wt = readFileSync(wranglerPath, 'utf8')
        .replaceAll('agent-tool', name)
        .replaceAll('example.dev', config.domain);
      writeFileSync(wranglerPath, wt);
    }
    console.log(`✔ copied ${src} → tools/${name}`);
    // A scaffolded JS package must be a pnpm workspace member, or a monorepo (e.g. Vercel) build
    // installs from the repo root and skips the tool's deps. Submodule tools (adopt) are excluded.
    if (existsSync(pkgPath)) registerWorkspaceMember(process.cwd(), `tools/${name}`);
  } else {
    console.log(`! no template at ${src} — manifest entry added without scaffolding`);
  }

  writeFileSync(path, serializeConfig(next));
  console.log(`✔ added "${name}" (${lane}/${target}) to the manifest`);

  // --- the IaC editor: emit declarative infra (no apply — CI/CD does that) ---
  const cwd = process.cwd();
  const providers = providersForTool(toolInfo);

  // 1) Wrapper main.tf (singleton) — scaffold only if the wrapper has none; never clobber a
  // live, tuned main.tf. When it exists, nudge the user to ensure the needed providers are there.
  const infraDir = resolve(cwd, 'infra');
  const mainTf = join(infraDir, 'main.tf');
  if (!existsSync(mainTf)) {
    mkdirSync(infraDir, { recursive: true });
    writeFileSync(mainTf, emitWrapperMainTf({ domain: config.domain, providers }));
    console.log('✔ scaffolded infra/main.tf (providers + HCP backend placeholder)');
  } else if (providers.some((p) => p !== 'cloudflare' && p !== 'github')) {
    console.log(`· infra/main.tf exists — ensure it declares provider(s): ${providers.join(', ')}`);
  }

  // 2) Per-tool module blocks
  const toolTf = join(infraDir, `${name}.tf`);
  if (existsSync(toolTf)) {
    console.log(`· infra/${name}.tf exists — left as-is`);
  } else {
    writeFileSync(
      toolTf,
      emitToolTf({
        name,
        domain: config.domain,
        lane,
        target,
        data,
        envs,
        port: entry?.port,
        tokenOverrides: entry?.tokenOverrides,
        dataShareWith: entry?.dataShareWith,
      }),
    );
    console.log(`✔ wrote infra/${name}.tf (modules: ${providers.join(', ')})`);
  }

  // 2b) Agent: emit the per-tool deploy workflow (KV-as-code + Worker secrets + seed + verify), so a
  // push to main deploys it — no hand-written CI. GEMINI_API_KEY + RUN_TOKEN are GitHub secrets.
  if (lane === 'agent') {
    const wfDir = resolve(cwd, '.github/workflows');
    const wfPath = join(wfDir, `deploy-${name}.yml`);
    if (existsSync(wfPath)) {
      console.log(`· .github/workflows/deploy-${name}.yml exists — left as-is`);
    } else {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(wfPath, emitAgentDeployWorkflow(name, config.domain));
      console.log(`✔ wrote .github/workflows/deploy-${name}.yml`);
    }
  }

  // 3) Agent kit — merge the new providers' MCP + provider skills into the wrapper's kit.
  materializeAgentKit(cwd, toolInfo);

  // 4) Per-tool secrets — gather THIS tool's provider keys straight to GitHub (link-first, hidden,
  // verified, no disk). Already-set base tokens show [already set] (Enter to keep). Interactive
  // only; CI/non-TTY (or --no-tokens) prints the command instead. So adding a tool includes getting
  // exactly the keys that tool needs.
  const repo = flag(args, '--repo') ?? detectRepo(cwd) ?? '';
  const gather = !args.includes('--no-tokens') && process.stdin.isTTY && repo !== '';
  if (gather) {
    console.log(`\nGathering ${name}'s provider keys${repo ? ` → ${repo}` : ''}:`);
    try {
      await gatherSecrets(name, repo, flag(args, '--env'));
    } catch (e) {
      console.log(`✖ secrets gather: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`  retry: greenlight secrets gather ${name}${repo ? ` --repo ${repo}` : ''}`);
    }
  }

  console.log(`
Next:${
    gather
      ? ''
      : `\n  greenlight secrets gather ${name}${repo ? ` --repo ${repo}` : ' --repo <owner/repo>'}   # this tool's keys → GitHub`
  }
  review infra/${name}.tf, then commit + push → CI (infra.yml) runs \`terraform apply\`
  greenlight preview ${name}        # local build + serve + verify`);
}
