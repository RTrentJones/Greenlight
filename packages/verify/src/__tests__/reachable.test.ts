import { describe, expect, it } from 'vitest';
import { waitForReachable } from '../index';

describe('waitForReachable', () => {
  it('returns true immediately when timeout <= 0 (no wait)', async () => {
    expect(await waitForReachable('http://127.0.0.1:1/', 0)).toBe(true);
  });

  it('returns false after the timeout when nothing is listening (connection error)', async () => {
    const start = Date.now();
    // Port 1 is not listening → fetch throws → retry until the short timeout.
    const ok = await waitForReachable('http://127.0.0.1:1/', 300);
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });
});
