import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '@rtrentjones/greenlight-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptCommand, mergePackageJson } from '../commands/adopt';
import { scaffoldConfig } from '../config-io';

describe('mergePackageJson', () => {
  const vendor = { '@rtrentjones/greenlight': 'file:vendor/rtrentjones-greenlight-0.1.0.tgz' };

  it('merges framework deps + overrides while preserving app deps/scripts', () => {
    const out = mergePackageJson(
      { name: 'legacy', dependencies: { 'left-pad': '1.0.0' }, scripts: { build: 'tsc' } },
      'legacy',
      vendor,
    );
    expect(out.name).toBe('legacy');
    expect(out.dependencies?.['left-pad']).toBe('1.0.0');
    expect(out.dependencies?.['@rtrentjones/greenlight']).toContain('file:vendor');
    expect(out.scripts?.build).toBe('tsc');
    expect(out.scripts?.greenlight).toBe('greenlight');
    expect(out.pnpm?.overrides?.['@rtrentjones/greenlight']).toContain('file:vendor');
  });

  it('never overrides an existing greenlight script', () => {
    const out = mergePackageJson({ scripts: { greenlight: 'custom' } }, 'x', vendor);
    expect(out.scripts?.greenlight).toBe('custom');
  });

  it('creates a minimal package.json when the repo has none', () => {
    const out = mergePackageJson(null, 'fresh', vendor);
    expect(out.name).toBe('fresh');
    expect(out.private).toBe(true);
    expect(out.dependencies?.['@rtrentjones/greenlight']).toBeDefined();
  });
});

describe('adoptCommand (poly-repo scaffold + central registry)', () => {
  const repoRoot = process.cwd();
  const wrapper = resolve(repoRoot, '.vitest-adopt-wrapper');
  const tool = resolve(repoRoot, '.vitest-adopt-tool');
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rmSync(wrapper, { recursive: true, force: true });
    rmSync(tool, { recursive: true, force: true });
    // wrapper = central registry repo: a real manifest (with blog) + vendored tarballs.
    mkdirSync(join(wrapper, 'vendor'), { recursive: true });
    writeFileSync(join(wrapper, 'greenlight.config.ts'), scaffoldConfig('example.dev'));
    for (const f of [
      'rtrentjones-greenlight-0.1.0.tgz',
      'rtrentjones-greenlight-shared-0.1.0.tgz',
    ]) {
      writeFileSync(join(wrapper, 'vendor', f), 'tgz');
    }
    // tool = existing app repo (pre-existing package.json + app code).
    mkdirSync(tool, { recursive: true });
    writeFileSync(
      join(tool, 'package.json'),
      JSON.stringify({ name: 'legacy', dependencies: { 'left-pad': '1.0.0' } }),
    );
    writeFileSync(join(tool, 'server.ts'), 'export const app = 1;\n');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.chdir(repoRoot);
    rmSync(wrapper, { recursive: true, force: true });
    rmSync(tool, { recursive: true, force: true });
  });

  it('--standalone scaffolds the consumer into the tool repo and registers it (external)', async () => {
    process.chdir(wrapper);
    await adoptCommand([
      'demo-mcp',
      '--repo',
      tool,
      '--lane',
      'mcp',
      '--target',
      'oci',
      '--standalone',
    ]);
    process.chdir(repoRoot);

    // --- tool repo: full consumer, app code untouched ---
    const toolCfg = await loadConfig(join(tool, 'greenlight.config.ts'));
    expect(toolCfg.blog).toBeUndefined();
    expect(toolCfg.tools[0]?.name).toBe('demo-mcp');
    expect(toolCfg.tools[0]?.dir).toBe('.');
    expect(toolCfg.tools[0]?.adopted).toBe(true);
    expect(toolCfg.tools[0]?.external).toBe(false);

    const pkg = JSON.parse(readFileSync(join(tool, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('legacy');
    expect(pkg.dependencies['left-pad']).toBe('1.0.0'); // app dep kept
    expect(pkg.dependencies['@rtrentjones/greenlight']).toContain('file:vendor');
    expect(pkg.pnpm.overrides['@rtrentjones/greenlight']).toContain('file:vendor');

    expect(readFileSync(join(tool, 'server.ts'), 'utf8')).toBe('export const app = 1;\n'); // untouched
    expect(existsSync(join(tool, 'vendor', 'rtrentjones-greenlight-0.1.0.tgz'))).toBe(true);
    expect(readFileSync(join(tool, 'infra/main.tf'), 'utf8')).toContain('module "tool"');
    expect(readFileSync(join(tool, '.github/workflows/greenlight-deploy.yml'), 'utf8')).toContain(
      'demo-mcp',
    );
    expect(existsSync(join(tool, '.github/workflows/greenlight-promote.yml'))).toBe(true);
    expect(readFileSync(join(tool, 'verify.config.ts'), 'utf8')).toContain("mode: 'mcp'");
    expect(existsSync(join(tool, '.mcp.json'))).toBe(true);
    expect(existsSync(join(tool, '.claude/skills/deploy-verify-promote/SKILL.md'))).toBe(true);
    expect(existsSync(join(tool, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(tool, 'mise.toml'))).toBe(true);

    // --- central registry: wrapper gained an external pointer, kept its blog ---
    // (read raw: loadConfig caches by path, so an in-process re-read is stale.)
    const regText = readFileSync(join(wrapper, 'greenlight.config.ts'), 'utf8');
    expect(regText).toMatch(/name: 'demo-mcp'.*external: true/);
    expect(regText).toContain('blog:');
  });

  it('default (wrapper-centric) edits infra in the wrapper + pushes the kit into the tool submodule', async () => {
    // Pre-create tools/<name> so the command skips `git submodule add` (no real git needed).
    const sub = join(wrapper, 'tools', 'demo-mcp');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'package.json'), JSON.stringify({ name: 'demo-mcp', private: true }));
    writeFileSync(join(sub, 'server.ts'), 'export const app = 1;\n');

    process.chdir(wrapper);
    await adoptCommand(['demo-mcp', '--repo', tool, '--lane', 'mcp', '--target', 'oci']);
    process.chdir(repoRoot);

    // --- wrapper owns the infra + verify spec ---
    const regText = readFileSync(join(wrapper, 'greenlight.config.ts'), 'utf8');
    expect(regText).toMatch(/name: 'demo-mcp'[\s\S]*external: true/);
    expect(regText).toMatch(/dir: 'tools\/demo-mcp'/);
    expect(readFileSync(join(wrapper, 'infra/demo-mcp.tf'), 'utf8')).toContain(
      'module "demo-mcp_dns"',
    );
    expect(readFileSync(join(wrapper, 'verify/demo-mcp.config.ts'), 'utf8')).toContain(
      "mode: 'mcp'",
    );

    // --- the kit was pushed INTO the tool submodule (travels with it) ---
    expect(existsSync(join(sub, '.claude/skills/deploy-verify-promote/SKILL.md'))).toBe(true);
    expect(existsSync(join(sub, '.claude/skills/provider-oci/SKILL.md'))).toBe(true);
    expect(existsSync(join(sub, '.mcp.json'))).toBe(true);
    expect(existsSync(join(sub, 'CLAUDE.md'))).toBe(true);
    const subPkg = JSON.parse(readFileSync(join(sub, 'package.json'), 'utf8'));
    expect(subPkg.scripts.greenlight).toContain('npx @rtrentjones/greenlight');
    expect(readFileSync(join(sub, 'server.ts'), 'utf8')).toBe('export const app = 1;\n'); // app untouched

    // --- option B: tool gets the provider-agnostic build+dispatch workflow, NOT infra ---
    expect(existsSync(join(sub, 'infra'))).toBe(false);
    const build = readFileSync(join(sub, '.github/workflows/greenlight-build.yml'), 'utf8');
    expect(build).toContain('event_type=deploy-demo-mcp'); // dispatches to the wrapper
    expect(build).toContain('ghcr.io'); // builds + pushes the container (no OCI here)
    // --- the wrapper got the deploy listener (OCI creds + restart live here) ---
    const listener = readFileSync(
      join(wrapper, '.github/workflows/greenlight-deploy-demo-mcp.yml'),
      'utf8',
    );
    expect(listener).toContain('types: [deploy-demo-mcp]');
    expect(listener).toContain('greenlight deploy demo-mcp');
    // the instance OCID is resolved by display-name at deploy time — not a manually-set secret
    expect(listener).toContain('--display-name demo-mcp');
    expect(listener).not.toContain('secrets.OCI_CONTAINER_INSTANCE_OCID');
    // the status token is per-tool (shared wrapper) — suffixed by the (upper, _) tool name
    expect(listener).toContain('secrets.GREENLIGHT_STATUS_TOKEN_DEMO_MCP');
    // deploy + remediate share ONE concurrency group so a self-heal never overlaps a deploy
    expect(listener).toContain('group: deploy-demo-mcp');

    // --- the wrapper also got the self-heal (remediate) listener ---
    const remediate = readFileSync(
      join(wrapper, '.github/workflows/greenlight-remediate-demo-mcp.yml'),
      'utf8',
    );
    expect(remediate).toContain('types: [remediate-demo-mcp]');
    expect(remediate).toContain('group: deploy-demo-mcp'); // same group as the deploy listener
    // re-applies the instance (recreate an idle-reclaimed box) before redeploying + verifying
    expect(remediate).toContain('-target=module.demo-mcp_instance');
    expect(remediate).toContain('greenlight deploy demo-mcp');
    expect(remediate).toContain('greenlight verify demo-mcp --env prod');
    // a failed self-heal escalates
    expect(remediate).toContain('if: ${{ failure() }}');
  });

  it('wrapper-centric vercel: verify runs in the TOOL repo (deployment_status), not the wrapper', async () => {
    const sub = join(wrapper, 'tools', 'demo-web');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'package.json'), JSON.stringify({ name: 'demo-web', private: true }));

    process.chdir(wrapper);
    await adoptCommand([
      'demo-web',
      '--repo',
      tool,
      '--lane',
      'next',
      '--target',
      'vercel',
      '--data',
      'supabase',
    ]);
    process.chdir(repoRoot);

    // wrapper owns infra; the verify spec is NOT in the wrapper (the tool's own CI runs verify)
    expect(readFileSync(join(wrapper, 'infra/demo-web.tf'), 'utf8')).toContain(
      'module "demo-web_vercel"',
    );
    expect(existsSync(join(wrapper, 'verify/demo-web.config.ts'))).toBe(false);

    // tool repo got the deployment_status verify workflow + spec + the right provider skills
    const vyml = readFileSync(join(sub, '.github/workflows/greenlight-verify.yml'), 'utf8');
    expect(vyml).toContain('deployment_status');
    expect(vyml).toContain('verify --url');
    expect(vyml).toContain('--spec verify/demo-web.config.ts');
    const vcfg = readFileSync(join(sub, 'verify/demo-web.config.ts'), 'utf8');
    expect(vcfg).toContain("mode: 'api'");
    expect(vcfg).toContain('ANTHROPIC_API_KEY'); // agent-web is config-gated on the key
    expect(existsSync(join(sub, '.claude/skills/provider-vercel/SKILL.md'))).toBe(true);
    expect(existsSync(join(sub, '.claude/skills/provider-supabase/SKILL.md'))).toBe(true);
    // not the oci path — no container build workflow
    expect(existsSync(join(sub, '.github/workflows/greenlight-build.yml'))).toBe(false);
  });
});
