// status-page: a static status summary.
import { createServer } from 'node:http';

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><h1>Status</h1><p>All systems normal.</p>\n');
  }
  if (pathname === '/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT ?? 4311));
