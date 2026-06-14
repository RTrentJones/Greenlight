import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addTool, serializeConfig } from '../config-io';
import { loadManifest } from '../manifest';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Lane template dir; for mcp it has per-target subdirs (oci|workers). */
function templateDir(lane: string, target: string): string {
  const base = resolve(process.cwd(), `tools/_template-${lane}`);
  return lane === 'mcp' ? join(base, target) : base;
}

export async function addCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: greenlight add <name> --lane <lane> --target <target> [--data <d>] [--auth <a>] [--envs beta,prod]',
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
  const next = addTool(config, {
    name,
    lane,
    target,
    data: flag(args, '--data'),
    auth: flag(args, '--auth'),
    envs: flag(args, '--envs')?.split(','),
  });

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
}
