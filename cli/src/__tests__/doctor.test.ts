import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '@rtrentjones/greenlight-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor, submoduleDriftCheck, versionDriftCheck } from '../commands/doctor';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gl-doctor-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// biome-ignore lint/suspicious/noExplicitAny: test fixture builder
const cfg = (tools: any[]) =>
  ConfigSchema.parse({ domain: 'x.dev', alerts: { sink: 'github-issue' }, tools });

const find = (checks: { name: string; status: string }[], name: string) =>
  checks.find((c) => c.name === name)?.status;

describe('runDoctor — conformance to the uniform model', () => {
  it('warns when an external oci tool has no preview descriptor and no verify spec', () => {
    const checks = runDoctor(
      cfg([
        { name: 'bamcp', lane: 'mcp', target: 'oci', data: 'none', external: true, envs: ['prod'] },
      ]),
      root,
    );
    expect(find(checks, 'bamcp: local preview gate')).toBe('warn');
    expect(find(checks, 'bamcp: in the verify loop')).toBe('warn');
  });

  it('passes when the external tool has a preview descriptor + a wrapper verify spec', () => {
    mkdirSync(join(root, 'verify'), { recursive: true });
    writeFileSync(
      join(root, 'verify/bamcp.config.ts'),
      'export default { mode: "mcp", expectTools: [] };',
    );
    const checks = runDoctor(
      cfg([
        {
          name: 'bamcp',
          lane: 'mcp',
          target: 'oci',
          data: 'none',
          external: true,
          envs: ['prod'],
          preview: { command: 'docker compose --profile preview up' },
        },
      ]),
      root,
    );
    expect(find(checks, 'bamcp: local preview gate')).toBe('ok');
    expect(find(checks, 'bamcp: in the verify loop')).toBe('ok');
  });

  it('a vercel tool: platform preview gate + verify spec found in the tool repo', () => {
    // vercel external tools keep their verify config in the tool repo (run by their own CI).
    mkdirSync(join(root, 'tools/hm/verify'), { recursive: true });
    writeFileSync(join(root, 'tools/hm/verify/hm.config.ts'), 'export default { mode: "api" };');
    const checks = runDoctor(
      cfg([
        {
          name: 'hm',
          lane: 'next',
          target: 'vercel',
          data: 'supabase',
          external: true,
          envs: ['beta', 'prod'],
        },
      ]),
      root,
    );
    const gate = checks.find((c) => c.name === 'hm: local preview gate');
    expect(gate?.status).toBe('ok');
    expect(gate?.detail).toContain('per-PR preview');
    expect(find(checks, 'hm: in the verify loop')).toBe('ok'); // found in tools/hm/verify/
  });

  it('a local workers tool is gateable via the built-in serve', () => {
    mkdirSync(join(root, 'tools/notes'), { recursive: true });
    const checks = runDoctor(
      cfg([{ name: 'notes', lane: 'mcp', target: 'workers', data: 'none', envs: ['prod'] }]),
      root,
    );
    expect(find(checks, 'notes: local preview gate')).toBe('ok');
  });

  it('a local next/vercel tool warns when not a workspace member and missing vercel.json', () => {
    mkdirSync(join(root, 'tools/site'), { recursive: true });
    const checks = runDoctor(
      cfg([{ name: 'site', lane: 'next', target: 'vercel', data: 'neon', envs: ['beta', 'prod'] }]),
      root,
    );
    expect(find(checks, 'site: pnpm workspace member')).toBe('warn');
    expect(find(checks, 'site: vercel.json framework')).toBe('warn');
  });

  it('a local next/vercel tool is ok when a workspace member with vercel.json', () => {
    mkdirSync(join(root, 'tools/site'), { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "tools/site"\n');
    writeFileSync(join(root, 'tools/site/vercel.json'), '{ "framework": "nextjs" }');
    const checks = runDoctor(
      cfg([{ name: 'site', lane: 'next', target: 'vercel', data: 'neon', envs: ['beta', 'prod'] }]),
      root,
    );
    expect(find(checks, 'site: pnpm workspace member')).toBe('ok');
    expect(find(checks, 'site: vercel.json framework')).toBe('ok');
  });

  it('a tools/* glob satisfies the workspace-member check', () => {
    mkdirSync(join(root, 'tools/site'), { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "tools/*"\n');
    const checks = runDoctor(
      cfg([{ name: 'site', lane: 'next', target: 'vercel', data: 'neon', envs: ['beta', 'prod'] }]),
      root,
    );
    expect(find(checks, 'site: pnpm workspace member')).toBe('ok');
  });

  it('token scoping: ok when every declared secret carries the tool name', () => {
    const checks = runDoctor(
      cfg([
        {
          name: 'bamcp',
          lane: 'mcp',
          target: 'oci',
          data: 'none',
          external: true,
          envs: ['prod'],
          tokens: ['GREENLIGHT_STATUS_TOKEN_BAMCP', 'BAMCP_VERIFY_TOKEN'],
        },
      ]),
      root,
    );
    expect(find(checks, 'bamcp: token scoping')).toBe('ok');
  });

  it('token scoping: warns on a generic (non-tool-scoped) secret name', () => {
    const checks = runDoctor(
      cfg([
        {
          name: 'heistmind',
          lane: 'next',
          target: 'vercel',
          data: 'supabase',
          external: true,
          envs: ['prod'],
          tokens: ['TF_VAR_GITHUB_ADMIN_TOKEN'], // generic — should carry HEISTMIND
        },
      ]),
      root,
    );
    const c = checks.find((x) => x.name === 'heistmind: token scoping');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('TF_VAR_GITHUB_ADMIN_TOKEN');
  });

  it('token scoping: a tokenOverride target is also conformance-checked', () => {
    const checks = runDoctor(
      cfg([
        {
          name: 'heistmind',
          lane: 'next',
          target: 'vercel',
          data: 'supabase',
          external: true,
          envs: ['prod'],
          tokenOverrides: { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN_HEISTMIND' },
        },
      ]),
      root,
    );
    expect(find(checks, 'heistmind: token scoping')).toBe('ok');
  });
});

describe('versionDriftCheck — infra ?ref lockstep', () => {
  const installPkg = (v: string) => {
    mkdirSync(join(root, 'node_modules/@rtrentjones/greenlight'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules/@rtrentjones/greenlight/package.json'),
      JSON.stringify({ version: v }),
    );
  };
  const writeTf = (file: string, ref: string) => {
    mkdirSync(join(root, 'infra'), { recursive: true });
    writeFileSync(
      join(root, 'infra', file),
      `module "x" {\n  source = "git::https://github.com/RTrentJones/greenlight.git//infra/modules/tool?ref=${ref}"\n}`,
    );
  };

  it('ok when every infra pin matches the installed version', () => {
    installPkg('0.2.23');
    writeTf('a.tf', 'v0.2.23');
    writeTf('b.tf', 'v0.2.23');
    expect(versionDriftCheck(root).status).toBe('ok');
  });

  it('warns when an infra pin lags the installed version', () => {
    installPkg('0.2.23');
    writeTf('a.tf', 'v0.2.19'); // the scattered-pin scenario the review caught
    const c = versionDriftCheck(root);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('v0.2.19');
  });

  it('skips when neither an installed package nor infra pins are present', () => {
    expect(versionDriftCheck(root).status).toBe('skip');
  });
});

describe('submoduleDriftCheck', () => {
  it('skips outside a git repo (no submodules to inspect)', () => {
    expect(submoduleDriftCheck(root).status).toBe('skip');
  });
});
