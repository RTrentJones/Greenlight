import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMigrationsDir } from '../commands/migrations';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gl-mig-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveMigrationsDir', () => {
  it('returns an explicit dir as-is', () => {
    expect(resolveMigrationsDir('custom/migrations', root)).toBe('custom/migrations');
  });

  it('auto-detects the first existing candidate (so neon/Drizzle tools need no path arg)', () => {
    mkdirSync(join(root, 'drizzle/migrations'), { recursive: true });
    // supabase/migrations + migrations are absent → the first existing candidate is drizzle/migrations
    expect(resolveMigrationsDir(undefined, root)).toBe('drizzle/migrations');
  });

  it('prefers supabase/migrations when present (back-compat)', () => {
    mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
    mkdirSync(join(root, 'migrations'), { recursive: true });
    expect(resolveMigrationsDir(undefined, root)).toBe('supabase/migrations');
  });

  it('falls back to the default when no candidate exists', () => {
    expect(resolveMigrationsDir(undefined, root)).toBe('supabase/migrations');
  });
});
