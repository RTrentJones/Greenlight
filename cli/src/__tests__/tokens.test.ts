import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { presentEnv, tokenStatus } from '../tokens';

// Snapshot + restore the env vars these cases mutate, so an ambient shell value (or one case)
// can't leak into another. Secrets now live in GitHub Actions — process.env is the only local
// source presentEnv/tokenStatus read.
const KEYS = ['CLOUDFLARE_API_TOKEN', 'VERCEL_API_TOKEN', 'SUPABASE_ACCESS_TOKEN'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('presentEnv', () => {
  it('reflects process.env (the only local source — no secrets file)', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf';
    expect(presentEnv().CLOUDFLARE_API_TOKEN).toBe('cf');
    expect(presentEnv().VERCEL_API_TOKEN).toBeUndefined();
  });
});

describe('tokenStatus', () => {
  it('reports which of a tool’s provider tokens are present in the environment', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf';
    const status = tokenStatus({ target: 'vercel', data: 'supabase' });
    const byVar = Object.fromEntries(status.map((s) => [s.spec.envVar, s.present]));
    expect(byVar.CLOUDFLARE_API_TOKEN).toBe(true);
    expect(byVar.VERCEL_API_TOKEN).toBe(false);
    expect(byVar.SUPABASE_ACCESS_TOKEN).toBe(false);
  });
});
