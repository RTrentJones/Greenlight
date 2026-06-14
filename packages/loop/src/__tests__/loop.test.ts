import http from 'node:http';
import type { Adapter } from '@rtrentjones/greenlight-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLoop } from '../loop';

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** In-memory adapter that "deploys" to the local stub server — no cloud creds. */
function fakeAdapter(deployUrl: string): Adapter {
  return {
    target: 'workers',
    build: async () => ({ artifactDir: '/tmp/stub' }),
    deploy: async () => ({ url: deployUrl }),
    url: () => deployUrl,
    teardown: async () => {},
  };
}

describe('runLoop', () => {
  it('drives build -> deploy -> verify end to end against a stub', async () => {
    const { url, report } = await runLoop({
      adapter: fakeAdapter(base),
      toolDir: '.',
      env: 'beta',
      spec: { mode: 'api', checks: [{ path: '/', status: 200, contains: 'ok' }] },
    });
    expect(url).toBe(base);
    expect(report.pass).toBe(true);
  });

  it('reports failure when verify fails', async () => {
    const { report } = await runLoop({
      adapter: fakeAdapter(base),
      toolDir: '.',
      env: 'beta',
      spec: { mode: 'api', checks: [{ path: '/', status: 404 }] },
    });
    expect(report.pass).toBe(false);
  });
});
