import { describe, expect, it } from 'vitest';
import { evalJson, evalText, evalValue, getPath } from '../assert';
import { validateSpec } from '../validate';

const NOW = Date.parse('2026-10-10T12:00:00Z');

describe('getPath', () => {
  const doc = { ok: true, checks: { database: 'healthy' }, items: [{ id: 7 }] };
  it('resolves dot and bracket paths, and the root', () => {
    expect(getPath(doc, 'checks.database')).toBe('healthy');
    expect(getPath(doc, 'items[0].id')).toBe(7);
    expect(getPath(doc, '$.ok')).toBe(true);
    expect(getPath(doc, '$')).toBe(doc);
    expect(getPath(doc, '')).toBe(doc);
  });
  it('returns undefined for any missing hop', () => {
    expect(getPath(doc, 'checks.cache')).toBeUndefined();
    expect(getPath(doc, 'ok.deeper')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });
});

describe('evalValue', () => {
  it('equals is strict and reports what it got', () => {
    expect(evalValue('ok', true, { equals: true })).toEqual([]);
    expect(evalValue('ok', 'true', { equals: true })[0]).toMatch(/ok = "true", expected true/);
  });
  it('a missing value fails once, with one clear reason', () => {
    expect(evalValue('x', undefined, { equals: 1, gte: 0 })).toEqual(['x missing']);
  });
  it('exists:false asserts absence', () => {
    expect(evalValue('x', undefined, { exists: false })).toEqual([]);
    expect(evalValue('x', 1, { exists: false })[0]).toMatch(/should be absent/);
  });
  it('numeric bounds coerce and reject non-numbers', () => {
    expect(evalValue('n', 5, { gte: 1, lte: 10 })).toEqual([]);
    expect(evalValue('n', '0', { gte: 1 })[0]).toMatch(/0 < 1/);
    expect(evalValue('n', 'abc', { gte: 1 })[0]).toMatch(/not a number/);
  });
  it('matches tests the stringified value', () => {
    expect(evalValue('v', 'v1.2.3', { matches: '^v\\d+' })).toEqual([]);
    expect(evalValue('v', 'beta', { matches: '^v\\d+' })[0]).toMatch(/does not match/);
  });
  it('maxAgeHours catches a stale timestamp (the silent-cron case)', () => {
    expect(evalValue('lastRun', '2026-10-10T00:00:00Z', { maxAgeHours: 26 }, NOW)).toEqual([]);
    const stale = evalValue('lastRun', '2026-10-03T13:00:47Z', { maxAgeHours: 26 }, NOW);
    expect(stale[0]).toMatch(/lastRun is 167\.0h old .* max 26h — stale/);
  });
  it('accepts epoch seconds and ms as timestamps', () => {
    const oneHourAgo = NOW - 3_600_000;
    expect(evalValue('t', oneHourAgo, { maxAgeHours: 2 }, NOW)).toEqual([]);
    expect(evalValue('t', Math.floor(oneHourAgo / 1000), { maxAgeHours: 2 }, NOW)).toEqual([]);
    expect(evalValue('t', 'yesterday-ish', { maxAgeHours: 2 }, NOW)[0]).toMatch(/not a timestamp/);
  });
  it('minFutureDays catches an approaching expiry', () => {
    expect(evalValue('Expires', '2027-07-20T00:00:00Z', { minFutureDays: 30 }, NOW)).toEqual([]);
    expect(evalValue('Expires', '2026-10-20T00:00:00Z', { minFutureDays: 30 }, NOW)[0]).toMatch(
      /need ≥ 30d/,
    );
  });
});

describe('evalJson / evalText', () => {
  it('fails every assertion once on a non-JSON body', () => {
    expect(evalJson('<html>', [{ path: 'ok', equals: true }])).toEqual([
      'body is not JSON (1 json assertion(s) unchecked)',
    ]);
  });
  it('runs path assertions over a JSON body', () => {
    const body = JSON.stringify({ status: 'healthy', checks: { database: 'down' } });
    expect(
      evalJson(body, [
        { path: 'status', equals: 'healthy' },
        { path: 'checks.database', equals: 'healthy' },
      ]),
    ).toEqual(['checks.database = "down", expected "healthy"']);
  });
  it('an optional capture group that did not participate is missing, not the whole match', () => {
    expect(evalText('Expires', [{ regex: '^Expires(?:: (.+))?$', exists: true }])).toEqual([
      '/^Expires(?:: (.+))?$/ missing',
    ]);
    // A regex with no groups still asserts on the whole match.
    expect(evalText('ok: yes', [{ regex: 'ok: \\w+', equals: 'ok: yes' }])).toEqual([]);
  });

  it('asserts on a regex capture (security.txt Expires)', () => {
    const body = 'Contact: x\nExpires: 2027-07-20T00:00:00.000Z\n';
    expect(
      evalText(body, [{ regex: '^Expires: (.+)$', flags: 'm', minFutureDays: 30 }], NOW),
    ).toEqual([]);
    expect(evalText(body, [{ regex: '^Nope: (.+)$', flags: 'm', exists: true }], NOW)[0]).toMatch(
      /missing/,
    );
  });
});

describe('validateSpec', () => {
  it('accepts every documented field', () => {
    expect(
      validateSpec({
        mode: 'api',
        concurrency: 'parallel',
        logsOnFailure: 'true',
        requireIdentity: true,
        settleRetries: 1,
        checks: [
          {
            path: '/x',
            method: 'POST',
            body: { a: 1 },
            status: 401,
            notContains: 'err',
            maxMs: 500,
            header: { name: 'content-type' },
            json: [{ path: 'ok', equals: true, maxAgeHours: 2 }],
            text: [{ regex: 'E: (.+)', flags: 'm', minFutureDays: 1 }],
          },
        ],
      }),
    ).toEqual([]);
  });
  it('names an unsupported field instead of ignoring it (typo or newer-Greenlight field)', () => {
    expect(validateSpec({ mode: 'api', checks: [{ path: '/', statsu: 200 }] })).toEqual([
      'api spec.checks[0]: unsupported field "statsu"',
    ]);
    expect(validateSpec({ mode: 'api', settleRetry: 3 })).toEqual([
      'api spec: unsupported field "settleRetry"',
    ]);
    expect(
      validateSpec({ mode: 'api', checks: [{ path: '/', json: [{ path: 'a', eq: 1 }] }] }),
    ).toEqual(['api spec.checks[0].json[0]: unsupported field "eq"']);
    expect(validateSpec({ mode: 'mcp', expectTools: [], call: { name: 'x', text: 'y' } })).toEqual([
      'mcp spec.call: unsupported field "text"',
    ]);
  });
  it('type-checks every accepted field, so a wrong-typed value cannot silently never fail', () => {
    expect(validateSpec({ mode: 'api', checks: [{ path: '/', maxMs: 'slow' }] })).toEqual([
      'api spec.checks[0].maxMs must be a finite number',
    ]);
    expect(
      validateSpec({ mode: 'api', checks: [{ path: '/', json: [{ path: 'n', gte: 'bad' }] }] }),
    ).toEqual(['api spec.checks[0].json[0].gte must be a finite number']);
    expect(validateSpec({ mode: 'api', checks: [{ path: '/', method: 'FETCH' }] })[0]).toMatch(
      /method must be one of GET/,
    );
    expect(validateSpec({ mode: 'api', checks: [{ status: 200 }] })).toEqual([
      'api spec.checks[0]: missing required field "path"',
    ]);
    expect(validateSpec({ mode: 'api', settleRetries: '3', concurrency: 'both' })).toEqual([
      'api spec.concurrency must be one of serial, parallel, got "both"',
      'api spec.settleRetries must be a finite number',
    ]);
    expect(validateSpec({ mode: 'mcp', expectTools: ['a', 1] })).toEqual([
      'mcp spec.expectTools[1] must be a string',
    ]);
    expect(validateSpec({ mode: 'test', timeoutMs: Number.NaN })).toEqual([
      'test spec.timeoutMs must be a finite number',
    ]);
  });

  it('returns a named failure (never throws) for inherited Object.prototype mode names', () => {
    expect(validateSpec({ mode: 'constructor' })[0]).toMatch(/unknown mode "constructor"/);
    expect(validateSpec({ mode: 'toString' })[0]).toMatch(/unknown mode "toString"/);
  });

  it('rejects an uncompilable regex and an unknown mode', () => {
    expect(
      validateSpec({ mode: 'api', checks: [{ path: '/', text: [{ regex: '(' }] }] })[0],
    ).toMatch(/not a valid regex/);
    expect(validateSpec({ mode: 'smoke' })[0]).toMatch(/unknown mode "smoke"/);
  });
});
