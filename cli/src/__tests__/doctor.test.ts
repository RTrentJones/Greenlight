import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '@rtrentjones/greenlight-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../commands/doctor';

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
});
