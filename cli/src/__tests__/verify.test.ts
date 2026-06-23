import type { VerifyReport, VerifySpec } from '@rtrentjones/greenlight-verify';
import { afterEach, describe, expect, it } from 'vitest';
import { attachFailureLogs, redactSecrets } from '../commands/verify';

describe('redactSecrets', () => {
  it('replaces secret-named env values wherever they appear', () => {
    const env = { MY_API_TOKEN: 'super-secret-value-123', PATH: '/usr/bin' };
    const out = redactSecrets('using token super-secret-value-123 on /usr/bin', env);
    expect(out).toContain('***');
    expect(out).not.toContain('super-secret-value-123');
    expect(out).toContain('/usr/bin'); // non-secret-named values are untouched
  });

  it('does not redact trivial/short values (avoids over-redaction)', () => {
    const env = { SHORT_KEY: 'abc' }; // < 6 chars
    expect(redactSecrets('value abc here', env)).toContain('abc');
  });
});

describe('attachFailureLogs', () => {
  const TOK = 'MY_TEST_SECRET_TOKEN';
  afterEach(() => {
    delete process.env[TOK];
  });

  it('scrubs a secret echoed by a logsOnFailure command before storing report.logs', () => {
    process.env[TOK] = 'leak-me-not-abcdef';
    const r: VerifyReport = { pass: false, mode: 'api', url: 'http://x', checks: [] };
    const spec = { mode: 'api', logsOnFailure: `echo "tok=$${TOK}"` } as VerifySpec;
    attachFailureLogs([r], [spec], process.cwd());
    expect(r.logs).not.toContain('leak-me-not-abcdef');
    expect(r.logs).toContain('***');
  });

  it('leaves a passing report untouched', () => {
    const r: VerifyReport = { pass: true, mode: 'api', url: 'http://x', checks: [] };
    attachFailureLogs([r], [{ mode: 'api' } as VerifySpec], process.cwd());
    expect(r.logs).toBeUndefined();
  });
});
