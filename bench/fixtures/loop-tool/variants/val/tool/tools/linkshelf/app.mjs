// linkshelf: a shelf of saved links.
import { createServer } from 'node:http';

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  res.writeHead(pathname === '/' || pathname === '/health/live' ? 200 : 404, {
    'content-type': 'application/json',
  });
  res.end(pathname === '/' ? '{"links":[]}' : '{"ok":true}');
}).listen(Number(process.env.PORT ?? 4321));
