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

  it('scaffolds the consumer into the tool repo and registers it (external) in the wrapper', async () => {
    process.chdir(wrapper);
    await adoptCommand(['demo-mcp', '--repo', tool, '--lane', 'mcp', '--target', 'oci']);
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
});
