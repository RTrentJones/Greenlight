import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVerifySpecAt } from '../manifest';

let dir: string;
let prevCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gl-vcfg-'));
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

describe('loadVerifySpecAt — config shapes', () => {
  it('loads a plain object spec (unchanged)', async () => {
    write('verify.config.ts', `export default { mode: 'api', checks: [{ path: '/' }] };`);
    const spec = await loadVerifySpecAt('verify.config.ts');
    expect(spec).toMatchObject({ mode: 'api' });
  });

  it('loads an array of specs (unchanged)', async () => {
    write('verify.config.ts', `export default [{ mode: 'test' }, { mode: 'api', checks: [] }];`);
    const specs = await loadVerifySpecAt('verify.config.ts');
    expect(Array.isArray(specs)).toBe(true);
    expect((specs as unknown[]).length).toBe(2);
  });

  it('calls a function-shaped config with the explicit ctx (S3)', async () => {
    write(
      'verify.config.ts',
      `export default (ctx) => ({
        mode: 'mcp',
        expectTools: ['ping'],
        requireAuthRejection: !ctx.preview,
      });`,
    );
    const local = await loadVerifySpecAt('verify.config.ts', {
      env: 'preview',
      url: 'http://localhost:1',
      preview: true,
    });
    expect(local).toMatchObject({ requireAuthRejection: false });

    const prod = await loadVerifySpecAt('verify.config.ts', {
      env: 'prod',
      url: 'https://x.example.dev',
      preview: false,
    });
    expect(prod).toMatchObject({ requireAuthRejection: true });
  });

  it('supports an async function config returning an array', async () => {
    write(
      'verify.config.ts',
      `export default async ({ env }) => [
        { mode: 'api', checks: [{ path: '/', status: 200 }] },
        ...(env === 'prod' ? [{ mode: 'test' }] : []),
      ];`,
    );
    const beta = (await loadVerifySpecAt('verify.config.ts', {
      env: 'beta',
      preview: false,
    })) as unknown[];
    const prod = (await loadVerifySpecAt('verify.config.ts', {
      env: 'prod',
      preview: false,
    })) as unknown[];
    expect(beta.length).toBe(1);
    expect(prod.length).toBe(2);
  });

  it('back-compat: with no ctx passed, a function config gets one derived from GREENLIGHT_* env vars', async () => {
    write(
      'verify.config.ts',
      `export default (ctx) => ({ mode: 'api', checks: [], ...(ctx.preview ? { settleRetries: 0 } : { settleRetries: 5 }) });`,
    );
    const before = process.env.GREENLIGHT_PREVIEW;
    process.env.GREENLIGHT_PREVIEW = '1';
    try {
      const spec = await loadVerifySpecAt('verify.config.ts');
      expect(spec).toMatchObject({ settleRetries: 0 });
    } finally {
      process.env.GREENLIGHT_PREVIEW = before;
    }
  });

  it('a function config returning garbage still fails mode validation', async () => {
    write('verify.config.ts', `export default () => ({ mode: 'nonsense' });`);
    await expect(
      loadVerifySpecAt('verify.config.ts', { env: 'prod', preview: false }),
    ).rejects.toThrow(/must export a spec/);
  });

  it('a throwing function config is reported with the file name', async () => {
    write('verify.config.ts', `export default () => { throw new Error('boom'); };`);
    await expect(
      loadVerifySpecAt('verify.config.ts', { env: 'prod', preview: false }),
    ).rejects.toThrow(/Verify config function .*boom/);
  });
});

describe('loadVerifyConfigAt / verifyCoverageAt — named meta export (vision 08 §6, C7)', () => {
  it('preserves the named meta export beside the default', async () => {
    const { loadVerifyConfigAt } = await import('../manifest');
    write(
      'verify.config.ts',
      `export const meta = { invariant: ['live'] };
       export default { mode: 'api', checks: [{ id: 'live', path: '/health/live' }] };`,
    );
    const cfg = await loadVerifyConfigAt('verify.config.ts');
    expect(cfg?.meta).toEqual({ invariant: ['live'] });
    expect(cfg?.specs).toMatchObject({ mode: 'api' });
  });

  it('returns empty meta when none is exported', async () => {
    const { loadVerifyConfigAt } = await import('../manifest');
    write('verify.config.ts', `export default { mode: 'test' };`);
    expect((await loadVerifyConfigAt('verify.config.ts'))?.meta).toEqual({});
  });

  it('rejects an unknown meta field and a malformed invariant id', async () => {
    const { loadVerifyConfigAt } = await import('../manifest');
    write(
      'a.config.ts',
      `export const meta = { invariants: ['live'] }; export default { mode: 'test' };`,
    );
    await expect(loadVerifyConfigAt('a.config.ts')).rejects.toThrow(
      /unsupported field "invariants"/,
    );
    write(
      'b.config.ts',
      `export const meta = { invariant: ['Live'] }; export default { mode: 'test' };`,
    );
    await expect(loadVerifyConfigAt('b.config.ts')).rejects.toThrow(/kebab-case check ids/);
  });

  it('computes per-environment coverage of a function-form config', async () => {
    const { verifyCoverageAt } = await import('../manifest');
    write(
      'verify.config.ts',
      `export const meta = { invariant: ['live', 'version'] };
       export default ({ preview }) => ({
         mode: 'api',
         checks: [
           { id: 'live', path: '/health/live' },
           ...(preview ? [] : [{ id: 'version', path: '/__version' }]),
         ],
       });`,
    );
    const cov = await verifyCoverageAt('verify.config.ts');
    expect(cov?.byEnv).toEqual({
      preview: ['live'],
      beta: ['live', 'version'],
      prod: ['live', 'version'],
    });
    expect(cov?.missing).toEqual([{ env: 'preview', id: 'version' }]);
  });

  it('counts a context whose evaluation throws as zero coverage', async () => {
    const { verifyCoverageAt } = await import('../manifest');
    write(
      'verify.config.ts',
      `export const meta = { invariant: ['live'] };
       export default ({ env }) => {
         if (env === 'prod') throw new Error('no prod');
         return { mode: 'api', checks: [{ id: 'live', path: '/' }] };
       };`,
    );
    const cov = await verifyCoverageAt('verify.config.ts');
    expect(cov?.byEnv.prod).toEqual([]);
    expect(cov?.missing).toEqual([{ env: 'prod', id: 'live' }]);
  });

  it('returns null when the file does not exist', async () => {
    const { verifyCoverageAt } = await import('../manifest');
    expect(await verifyCoverageAt('missing.config.ts')).toBeNull();
  });
});
