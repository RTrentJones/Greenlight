import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../index';

let server: http.Server;
let base: string;
let eventuallyHits = 0; // for the settle-retry test: 404 until the 3rd hit, then 200

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><a href="/about">about</a><a href="/missing">x</a></body></html>');
    } else if (url === '/about') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>about page</body></html>');
    } else if (url === '/rss.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>');
    } else if (url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><urlset></urlset>');
    } else if (url === '/protected') {
      // Simulates Vercel Deployment Protection: 401 unless the bypass header is sent.
      if (req.headers['x-bypass'] === 'secret') {
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(401);
        res.end('protected');
      }
    } else if (url === '/eventually') {
      // Simulates a just-deployed static asset that propagates after a couple of hits.
      eventuallyHits += 1;
      if (eventuallyHits >= 3) {
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end('not yet');
      }
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('verify api', () => {
  it('sends requestHeaders (e.g. a Vercel protection bypass) so a gated URL is reachable', async () => {
    const blocked = await verify(base, {
      mode: 'api',
      checks: [{ path: '/protected', status: 200 }],
    });
    expect(blocked.pass).toBe(false); // 401 without the bypass header
    const ok = await verify(base, {
      mode: 'api',
      checks: [{ path: '/protected', status: 200, requestHeaders: { 'x-bypass': 'secret' } }],
    });
    expect(ok.pass).toBe(true);
  });

  it('passes status + contains + rss + sitemap checks', async () => {
    const r = await verify(base, {
      mode: 'api',
      checks: [
        { path: '/', status: 200, contains: 'about' },
        { path: '/about', status: 200 },
      ],
      rssValid: true,
      sitemapValid: true,
    });
    expect(r.mode).toBe('api');
    expect(r.pass).toBe(true);
  });

  it('fails on a wrong status', async () => {
    const r = await verify(base, { mode: 'api', checks: [{ path: '/missing', status: 200 }] });
    expect(r.pass).toBe(false);
  });

  it('detects broken internal links', async () => {
    const r = await verify(base, { mode: 'api', noBrokenInternalLinks: true });
    const link = r.checks.find((c) => c.name.includes('broken internal links'));
    expect(link?.pass).toBe(false); // '/' links to /missing (404)
  });

  it('settleRetries re-runs until an eventually-consistent path is live', async () => {
    eventuallyHits = 0; // 404 on hits 1–2, 200 on hit 3 (simulates post-deploy propagation)
    const r = await verify(base, {
      mode: 'api',
      checks: [{ path: '/eventually', status: 200 }],
      settleRetries: 5,
      settleMs: 0, // no real delay in the test
    });
    expect(r.pass).toBe(true);
  });

  it('settleRetries does not mask a genuine failure (still fails after the retries)', async () => {
    const r = await verify(base, {
      mode: 'api',
      checks: [{ path: '/missing', status: 200 }],
      settleRetries: 3,
      settleMs: 0,
    });
    expect(r.pass).toBe(false);
  });
});
