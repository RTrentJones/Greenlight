import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toExportResult, validateConfig, validateSpec, verify, verifyAll } from '../index';
import type { ApiSpec, VerifySpec } from '../types';

// Vision 08 §6 / roadmap M0-01: stable check ids. The regression case is the validator that used to
// reject `id` with `unsupported field "id"`.

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

describe('check ids — validation', () => {
  it('accepts an id on an api check (was: unsupported field "id")', () => {
    expect(
      validateSpec({ mode: 'api', checks: [{ id: 'live', path: '/health/live', status: 200 }] }),
    ).toEqual([]);
  });

  it('accepts an id on a spec of any mode', () => {
    expect(validateSpec({ id: 'tools-list', mode: 'mcp', expectTools: ['a'] })).toEqual([]);
    expect(validateSpec({ id: 'unit', mode: 'test', command: 'true' })).toEqual([]);
  });

  it('rejects ids that are not kebab-case', () => {
    for (const bad of ['', 'Live', 'has space', 'under_score', '-lead', 'x'.repeat(64)]) {
      const problems = validateSpec({ mode: 'api', checks: [{ id: bad, path: '/' }] });
      expect(problems.join(' ')).toMatch(/must be a kebab-case id/);
    }
  });

  it('rejects a non-string id', () => {
    expect(validateSpec({ id: 3, mode: 'test' }).join(' ')).toMatch(/kebab-case id/);
  });

  it('rejects a duplicate id within one spec', () => {
    const problems = validateSpec({
      id: 'live',
      mode: 'api',
      checks: [
        { id: 'live', path: '/a' },
        { id: 'b', path: '/b' },
        { id: 'b', path: '/c' },
      ],
    });
    expect(problems).toContain('api spec: duplicate id "live"');
    expect(problems).toContain('api spec: duplicate id "b"');
  });

  it('reports duplicates across a config per spec index', () => {
    const problems = validateConfig([
      { mode: 'api', checks: [{ id: 'live', path: '/' }] },
      { id: 'other', mode: 'test' },
      { id: 'live', mode: 'test' },
    ]);
    expect([...problems.keys()]).toEqual([2]);
    expect(problems.get(2)?.[0]).toMatch(/duplicate id "live" \(also declared by spec 0\)/);
  });
});

describe('check ids — reports and export', () => {
  it('copies an api check id onto its report check', async () => {
    const spec: ApiSpec = {
      mode: 'api',
      checks: [
        { id: 'live', path: '/health/live', status: 200 },
        { path: '/x', status: 404 },
      ],
    };
    const r = await verify(base, spec);
    expect(r.pass).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['live', undefined]);
  });

  it('stamps the spec id on the report and on checks without their own id', async () => {
    const spec: ApiSpec = {
      id: 'routes',
      mode: 'api',
      checks: [
        { id: 'live', path: '/health/live', status: 200 },
        { path: '/x', status: 404 },
      ],
    };
    const r = await verify(base, spec);
    expect(r.specId).toBe('routes');
    expect(r.checks.map((c) => c.id)).toEqual(['live', 'routes']);
  });

  it('fails exactly the duplicating spec in verifyAll, keeping reports index-aligned', async () => {
    const specs: VerifySpec[] = [
      { mode: 'api', checks: [{ id: 'live', path: '/health/live', status: 200 }] },
      { mode: 'api', checks: [{ id: 'live', path: '/health/live', status: 200 }] },
    ];
    const reports = await verifyAll(base, specs);
    expect(reports.map((r) => r.pass)).toEqual([true, false]);
    expect(reports[1]?.checks[0]?.name).toBe('spec is valid');
    expect(reports[1]?.checks[0]?.detail).toMatch(/duplicate id "live"/);
  });

  it('exports eval.check_id only when a check has an id', async () => {
    const r = await verify(base, {
      mode: 'api',
      checks: [
        { id: 'live', path: '/health/live', status: 200 },
        { path: '/x', status: 404 },
      ],
    });
    const out = toExportResult([r], { tool: 't', env: 'preview' });
    expect(out.checks[0]?.['eval.check_id']).toBe('live');
    expect(out.checks[1] && 'eval.check_id' in out.checks[1]).toBe(false);
  });
});
