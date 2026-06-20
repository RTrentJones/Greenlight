import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { presentEnv, tokenStatus, upsertSecret } from '../tokens';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gl-tokens-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('upsertSecret + presentEnv', () => {
  it('writes a new secret and reads it back', () => {
    upsertSecret(dir, 'CLOUDFLARE_API_TOKEN', 'abc');
    expect(presentEnv(dir).CLOUDFLARE_API_TOKEN).toBe('abc');
  });

  it('upserts (replaces) an existing key without duplicating', () => {
    upsertSecret(dir, 'VERCEL_API_TOKEN', 'one');
    upsertSecret(dir, 'VERCEL_API_TOKEN', 'two');
    const file = readFileSync(join(dir, '.greenlight/secrets.env'), 'utf8');
    expect(file.match(/VERCEL_API_TOKEN=/g)?.length).toBe(1);
    expect(presentEnv(dir).VERCEL_API_TOKEN).toBe('two');
  });

  it('preserves other keys when upserting', () => {
    upsertSecret(dir, 'A', '1');
    upsertSecret(dir, 'B', '2');
    const env = presentEnv(dir);
    expect(env.A).toBe('1');
    expect(env.B).toBe('2');
  });
});

describe('tokenStatus', () => {
  it('reports which of a tool’s provider tokens are present', () => {
    // presentEnv merges process.env (CI provides tokens that way) — clear the ones we assert
    // absent so an ambient shell value can't make this flaky.
    for (const k of ['VERCEL_API_TOKEN', 'SUPABASE_ACCESS_TOKEN']) delete process.env[k];
    upsertSecret(dir, 'CLOUDFLARE_API_TOKEN', 'cf');
    const status = tokenStatus(dir, { target: 'vercel', data: 'supabase' });
    const byVar = Object.fromEntries(status.map((s) => [s.spec.envVar, s.present]));
    expect(byVar.CLOUDFLARE_API_TOKEN).toBe(true);
    expect(byVar.VERCEL_API_TOKEN).toBe(false);
    expect(byVar.SUPABASE_ACCESS_TOKEN).toBe(false);
  });
});
