import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../index';

let server: http.Server;
let base: string;

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
});
