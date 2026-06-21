import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { templatesRoot } from '../asset-paths';
import { addTool, serializeConfig } from '../config-io';
import { loadManifest } from '../manifest';
import { emitToolTf, emitWrapperMainTf, providersForTool } from '../tf-emit';
import { ensureTokensForTool } from '../tokens';
import { materializeAgentKit } from './agent';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Lane template dir (bundled in the CLI package, or the repo in dev); mcp has oci|workers subdirs. */
function templateDir(lane: string, target: string): string {
  const base = join(templatesRoot(), `_template-${lane}`);
  return lane === 'mcp' ? join(base, target) : base;
}

export async function addCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: greenlight add <name> --lane <lane> --target <target> [--data <d>] [--auth <a>] [--envs beta,prod] [--port 8000]',
    );
  }
  const lane = flag(args, '--lane');
  const target = flag(args, '--target');
  if (!lane || !target) throw new Error('add needs --lane and --target');

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
  });
  const entry = next.tools.find((t) => t.name === name);
  const data = entry?.data ?? 'none';
  const envs = entry?.envs ?? ['beta', 'prod'];
  const toolInfo = { target, data };

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
    console.log(`✔ copied ${src} → tools/${name}`);
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
      emitToolTf({ name, domain: config.domain, lane, target, data, envs, port: entry?.port }),
    );
    console.log(`✔ wrote infra/${name}.tf (modules: ${providers.join(', ')})`);
  }

  // 3) Tokens — gather + fail-fast verify (best-effort; surfaces a bad scope immediately).
  if (!args.includes('--no-tokens')) {
    try {
      const outcomes = await ensureTokensForTool(cwd, toolInfo, {
        verify: !args.includes('--no-verify'),
      });
      const missing = outcomes.filter((o) => o.outcome === 'missing').map((o) => o.envVar);
      if (missing.length) {
        console.log(
          `! missing token(s): ${missing.join(', ')} — set in .greenlight/secrets.env, then \`greenlight secrets sync\``,
        );
      }
    } catch (e) {
      // Fail-fast verification error — surface it but keep the manifest/infra edits.
      console.log(`✖ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4) Agent kit — merge the new providers' MCP + provider skills into the wrapper's kit.
  materializeAgentKit(cwd, toolInfo);

  console.log(`
Next:
  review infra/${name}.tf, then commit + push → CI (infra.yml) runs \`terraform apply\`
  greenlight preview ${name}        # local build + serve + verify`);
}
