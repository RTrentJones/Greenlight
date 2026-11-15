// potluck: who brings what.
import { createServer } from 'node:http';

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  res.writeHead(pathname === '/' || pathname === '/health/live' ? 200 : 404, {
    'content-type': 'application/json',
  });
  res.end(pathname === '/' ? '{"dishes":[]}' : '{"ok":true}');
}).listen(Number(process.env.PORT ?? 4341));
