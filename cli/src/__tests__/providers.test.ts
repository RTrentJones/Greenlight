import { describe, expect, it, vi } from 'vitest';
import {
  PACKS,
  mcpForTool,
  packsForTool,
  secretKeyFor,
  tfModulesForTool,
  tokensForTool,
} from '../providers';

describe('secretKeyFor — the project-scoped-secret naming convention', () => {
  it('uppercases an account-level token (no per-tool suffix)', () => {
    expect(secretKeyFor({ envVar: 'SUPABASE_ACCESS_TOKEN' }, 'heistmind')).toBe(
      'SUPABASE_ACCESS_TOKEN',
    );
  });

  it('adds a _<TOOL> suffix for a perTool token (collision-safe on the shared wrapper)', () => {
    expect(secretKeyFor({ envVar: 'GREENLIGHT_STATUS_TOKEN', perTool: true }, 'bamcp')).toBe(
      'GREENLIGHT_STATUS_TOKEN_BAMCP',
    );
    // kebab tool names normalize to _
    expect(secretKeyFor({ envVar: 'GREENLIGHT_STATUS_TOKEN', perTool: true }, 'my-tool')).toBe(
      'GREENLIGHT_STATUS_TOKEN_MY_TOOL',
    );
  });

  it('a tokenOverride wins (multi-account) over both base + suffix', () => {
    const overrides = { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN_HEISTMIND' };
    expect(secretKeyFor({ envVar: 'SUPABASE_ACCESS_TOKEN' }, 'heistmind', overrides)).toBe(
      'SUPABASE_ACCESS_TOKEN_HEISTMIND',
    );
    // an override for a different env var doesn't affect this one
    expect(secretKeyFor({ envVar: 'VERCEL_API_TOKEN' }, 'heistmind', overrides)).toBe(
      'VERCEL_API_TOKEN',
    );
  });
});

describe('packsForTool', () => {
  it('always includes the always-on packs (cloudflare, hcp, github)', () => {
    const ids = packsForTool().map((p) => p.id);
    expect(ids).toContain('cloudflare');
    expect(ids).toContain('hcp');
    expect(ids).toContain('github');
    // …and nothing target/data-specific with no tool
    expect(ids).not.toContain('vercel');
    expect(ids).not.toContain('supabase');
    expect(ids).not.toContain('oci');
  });

  it('adds vercel for target:vercel and supabase for data:supabase', () => {
    const ids = packsForTool({ target: 'vercel', data: 'supabase' }).map((p) => p.id);
    expect(ids).toContain('vercel');
    expect(ids).toContain('supabase');
  });

  it('adds oci for target:oci only', () => {
    expect(packsForTool({ target: 'oci' }).map((p) => p.id)).toContain('oci');
    expect(packsForTool({ target: 'vercel' }).map((p) => p.id)).not.toContain('oci');
  });
});

describe('mcpForTool', () => {
  it('matches the legacy recommended set: cloudflare always', () => {
    expect(Object.keys(mcpForTool()).sort()).toEqual(['cloudflare', 'cloudflare-docs']);
  });

  it('adds vercel + supabase (with auth header) for a next/vercel/supabase tool', () => {
    const m = mcpForTool({ target: 'vercel', data: 'supabase' });
    expect(Object.keys(m)).toContain('vercel');
    expect(m.supabase?.url).toContain('read_only=true');
    expect(m.supabase?.headers?.Authorization).toContain('SUPABASE_ACCESS_TOKEN');
  });
});

describe('tokensForTool', () => {
  it('dedups by envVar and gathers a next/vercel/supabase tool’s tokens', () => {
    const envVars = tokensForTool({ target: 'vercel', data: 'supabase' }).map((t) => t.envVar);
    expect(new Set(envVars).size).toBe(envVars.length); // no dupes
    expect(envVars).toContain('CLOUDFLARE_API_TOKEN');
    expect(envVars).toContain('VERCEL_API_TOKEN');
    expect(envVars).toContain('SUPABASE_ACCESS_TOKEN');
    expect(envVars).toContain('TF_API_TOKEN');
  });
});

describe('tfModulesForTool', () => {
  it('collects the modules the providers reference (deduped)', () => {
    const mods = tfModulesForTool({ target: 'vercel', data: 'supabase' });
    expect(mods).toContain('vercel');
    expect(mods).toContain('supabase');
    expect(mods).toContain('tool'); // cloudflare DNS
    expect(mods).toContain('keepalive');
    expect(new Set(mods).size).toBe(mods.length);
  });
});

describe('token verify()', () => {
  it('cloudflare verify is ok only when status === active', async () => {
    const cf = PACKS.find((p) => p.id === 'cloudflare')?.tokens[0];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'active' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { status: 'disabled' } }) });
    vi.stubGlobal('fetch', fetchMock);
    expect((await cf?.verify?.('t', {}))?.ok).toBe(true);
    expect((await cf?.verify?.('t', {}))?.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it('vercel verify is ok on HTTP 200, not on 403', async () => {
    const vc = PACKS.find((p) => p.id === 'vercel')?.tokens[0];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    vi.stubGlobal('fetch', fetchMock);
    expect((await vc?.verify?.('t', {}))?.ok).toBe(true);
    expect((await vc?.verify?.('t', {}))?.ok).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('setupUrl + gather tokens', () => {
  it('every pack has a setupUrl link (for `secrets gather`)', () => {
    for (const p of PACKS) expect(p.setupUrl, `${p.id} setupUrl`).toBeTruthy();
  });

  it('the oci pack carries the auth creds + the option-B deploy PATs', () => {
    const oci = tokensForTool({ target: 'oci', data: 'none' }).map((t) => t.envVar);
    expect(oci).toContain('TF_VAR_oci_tenancy_ocid');
    expect(oci).toContain('TF_VAR_oci_private_key');
    expect(oci).toContain('GREENLIGHT_DISPATCH_TOKEN');
    expect(oci).toContain('GREENLIGHT_STATUS_TOKEN');
  });

  it('does NOT ask for the subnet/AD — those are IaC (oci-network module + AD data source)', () => {
    const oci = tokensForTool({ target: 'oci', data: 'none' }).map((t) => t.envVar);
    expect(oci).not.toContain('TF_VAR_oci_subnet_id');
    expect(oci).not.toContain('TF_VAR_oci_availability_domain');
    expect(oci).toContain('TF_VAR_oci_compartment_id'); // optional (blank → tenancy root)
    expect(tfModulesForTool({ target: 'oci', data: 'none' })).toContain('oci-network');
  });

  it('the status token is per-tool (shared wrapper) but the dispatch token is not (per-tool repo)', () => {
    const oci = PACKS.find((p) => p.id === 'oci');
    expect(oci?.tokens.find((t) => t.envVar === 'GREENLIGHT_STATUS_TOKEN')?.perTool).toBe(true);
    expect(oci?.tokens.find((t) => t.envVar === 'GREENLIGHT_DISPATCH_TOKEN')?.perTool).toBeFalsy();
  });
});
