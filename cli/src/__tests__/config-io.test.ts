import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '@rtrentjones/greenlight-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../commands/doctor';
import { addTool, scaffoldConfig, serializeConfig } from '../config-io';

const base = {
  domain: 'example.dev',
  alerts: { sink: 'github-issue' as const },
  blog: { lane: 'astro' as const, target: 'workers' as const, data: 'none' as const },
  tools: [],
};

// Write round-trip configs inside the repo so jiti can resolve @rtrentjones/greenlight-shared.
const tmpFiles: string[] = [];
function writeRepoTmp(name: string, contents: string): string {
  const p = resolve(process.cwd(), name);
  writeFileSync(p, contents);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) rmSync(f, { recursive: true, force: true });
});

describe('serializeConfig', () => {
  it('round-trips a scaffolded config through loadConfig', async () => {
    const p = writeRepoTmp('.vitest-scaffold.config.ts', scaffoldConfig('example.dev'));
    const loaded = await loadConfig(p);
    expect(loaded.domain).toBe('example.dev');
    expect(loaded.blog).toEqual({ lane: 'astro', target: 'workers', data: 'none' });
    expect(loaded.tools).toEqual([]);
  });

  it('round-trips a config with a tool', async () => {
    const cfg = addTool(base, { name: 'ping-mcp', lane: 'mcp', target: 'oci' });
    const p = writeRepoTmp('.vitest-tool.config.ts', serializeConfig(cfg));
    const loaded = await loadConfig(p);
    expect(loaded.tools[0]?.name).toBe('ping-mcp');
    expect(loaded.tools[0]?.target).toBe('oci');
    expect(loaded.tools[0]?.auth).toBe('none'); // defaults serialized
  });
});

describe('addTool', () => {
  it('accepts a valid mcp -> oci tool', () => {
    expect(() => addTool(base, { name: 'x', lane: 'mcp', target: 'oci' })).not.toThrow();
  });
  it('rejects an out-of-matrix combo (mcp -> vercel)', () => {
    expect(() => addTool(base, { name: 'x', lane: 'mcp', target: 'vercel' })).toThrow();
  });
  it('rejects a duplicate name', () => {
    const one = addTool(base, { name: 'x', lane: 'mcp', target: 'oci' });
    expect(() => addTool(one, { name: 'x', lane: 'mcp', target: 'oci' })).toThrow(/already exists/);
  });
});

describe('runDoctor', () => {
  it('flags a missing tool directory and a missing mcp verify.config', () => {
    const root = resolve(process.cwd(), '.vitest-doctor-root');
    mkdirSync(join(root, 'apps/blog'), { recursive: true });
    mkdirSync(join(root, 'tools/has-vc'), { recursive: true });
    writeFileSync(join(root, 'tools/has-vc/verify.config.ts'), 'export default {};');
    tmpFiles.push(root);

    let cfg = addTool(base, { name: 'has-vc', lane: 'mcp', target: 'oci', envs: ['prod'] });
    cfg = addTool(cfg, { name: 'missing', lane: 'mcp', target: 'oci', envs: ['prod'] });
    const checks = runDoctor(cfg, root);
    expect(checks.find((c) => c.name === 'has-vc: directory')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'missing: directory')?.status).toBe('fail');
    expect(checks.find((c) => c.name === 'has-vc: verify.config.ts')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'missing: verify.config.ts')?.status).toBe('warn');
  });
});
