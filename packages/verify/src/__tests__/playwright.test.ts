import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { verifyPlaywright } from '../playwright';

const cwd = tmpdir();
const url = 'https://beta.example.com';

describe('verifyPlaywright — suite mode', () => {
  it('passes when the suite command exits 0', async () => {
    const r = await verifyPlaywright(
      url,
      { mode: 'playwright', suite: { command: 'exit 0' } },
      cwd,
    );
    expect(r.pass).toBe(true);
    expect(r.mode).toBe('playwright');
  });

  it('fails when the suite command exits non-zero, surfacing the exit code', async () => {
    const r = await verifyPlaywright(
      url,
      { mode: 'playwright', suite: { command: 'exit 4' } },
      cwd,
    );
    expect(r.pass).toBe(false);
    expect(r.checks[0]?.detail).toContain('exit 4');
  });

  it('injects the deployed URL as PLAYWRIGHT_BASE_URL and GREENLIGHT_VERIFY_URL', async () => {
    const command =
      'test "$PLAYWRIGHT_BASE_URL" = "https://beta.example.com" && test "$GREENLIGHT_VERIFY_URL" = "https://beta.example.com"';
    const r = await verifyPlaywright(url, { mode: 'playwright', suite: { command } }, cwd);
    expect(r.pass).toBe(true);
  });

  it('forwards extra env to the suite', async () => {
    const r = await verifyPlaywright(
      url,
      { mode: 'playwright', suite: { command: 'test "$FOO" = "bar"', env: { FOO: 'bar' } } },
      cwd,
    );
    expect(r.pass).toBe(true);
  });

  it('reports a clear error when neither renders nor suite is set', async () => {
    const r = await verifyPlaywright(url, { mode: 'playwright' }, cwd);
    expect(r.pass).toBe(false);
    expect(r.checks[0]?.detail).toContain('nothing to run');
  });
});
