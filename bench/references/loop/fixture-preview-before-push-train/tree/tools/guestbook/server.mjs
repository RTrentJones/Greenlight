// guestbook: one page and its liveness/version routes.
import { createServer } from 'node:http';

const WELCOME = 'Thanks for stopping by. Sign below.';
const SHA = process.env.GIT_SHA ?? 'dev';

const page = () => `<!doctype html>
<html>
  <head><title>Guestbook</title></head>
  <body>
    <h1>Guestbook</h1>
    <p class="welcome">${WELCOME}</p>
    <ul id="entries"></ul>
  </body>
</html>
`;

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page());
  }
  if (pathname === '/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (pathname === '/__version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ sha: SHA }));
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT ?? 4310));
