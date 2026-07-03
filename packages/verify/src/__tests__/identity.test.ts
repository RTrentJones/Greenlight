import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../index';

const SHA = 'abc123def4567890abc123def4567890abc123de';
const OLD = '0000000000000000000000000000000000000000';

let server: http.Server;
let base: string;
let versionMode: 'match' | 'stale-then-match' | 'mismatch' | 'absent' | 'null-sha' | 'not-json' =
  'match';
let staleHits = 0;
let contentHits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/__version') {
      if (versionMode === 'absent') {
        res.writeHead(404);
        res.end('nope');
      } else if (versionMode === 'not-json') {
        res.writeHead(200);
        res.end('<html>not json</html>');
      } else if (versionMode === 'null-sha') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sha: null }));
      } else if (versionMode === 'stale-then-match') {
        staleHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sha: staleHits >= 3 ? SHA : OLD }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sha: versionMode === 'match' ? SHA : OLD }));
      }
    } else {
      contentHits += 1;
      res.writeHead(200);
      res.end('ok');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => server.close());

const spec = { mode: 'api' as const, checks: [{ path: '/', status: 200 }] };

describe('E3 artifact-identity probe (expectedSha)', () => {
  it('passes and runs content checks when the deployed sha matches', async () => {
    versionMode = 'match';
    const r = await verify(base, spec, { expectedSha: SHA });
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.name).toBe('deployed sha matches expected');
    expect(r.checks[0]?.pass).toBe(true);
    expect(r.checks).toHaveLength(2); // identity + GET /
  });

  it('matches a short expected sha against the full deployed one', async () => {
    versionMode = 'match';
    const r = await verify(base, spec, { expectedSha: SHA.slice(0, 12) });
    expect(r.checks[0]?.pass).toBe(true);
  });

  it('retries within the settle budget until the new artifact propagates', async () => {
    versionMode = 'stale-then-match';
    staleHits = 0;
    const r = await verify(base, { ...spec, settleRetries: 5, settleMs: 10 }, { expectedSha: SHA });
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.pass).toBe(true);
    expect(r.checks[0]?.attempts).toBe(3); // stale, stale, match
  });

  it('fails hard on a mismatch and SKIPS content checks (they would validate the wrong artifact)', async () => {
    versionMode = 'mismatch';
    contentHits = 0;
    const r = await verify(base, spec, { expectedSha: SHA });
    expect(r.pass).toBe(false);
    expect(r.checks).toHaveLength(1); // identity only — no content checks against the wrong deploy
    expect(r.checks[0]?.detail).toMatch(/DIFFERENT artifact/);
    expect(contentHits).toBe(0);
  });

  it('is graceful when the tool has no /__version endpoint (passing "sha unverified")', async () => {
    versionMode = 'absent';
    const r = await verify(base, spec, { expectedSha: SHA });
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.pass).toBe(true);
    expect(r.checks[0]?.detail).toMatch(/sha unverified/);
  });

  it('is graceful when /__version reports no sha (built without GREENLIGHT_SHA)', async () => {
    versionMode = 'null-sha';
    const r = await verify(base, spec, { expectedSha: SHA });
    expect(r.checks[0]?.pass).toBe(true);
    expect(r.checks[0]?.detail).toMatch(/sha unverified/);
  });

  it('is graceful when /__version is not JSON', async () => {
    versionMode = 'not-json';
    const r = await verify(base, spec, { expectedSha: SHA });
    expect(r.checks[0]?.pass).toBe(true);
    expect(r.checks[0]?.detail).toMatch(/sha unverified/);
  });

  it('runs no identity probe when expectedSha is not given (unchanged default)', async () => {
    versionMode = 'mismatch';
    const r = await verify(base, spec);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]?.name).toBe('GET /');
  });
});
