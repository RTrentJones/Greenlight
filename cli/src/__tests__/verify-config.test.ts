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
