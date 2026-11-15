// changelog: the release notes as one page, plus liveness/version routes.
import { createServer } from 'node:http';

const RELEASES = [
  { version: '1.4.0', date: '2026-10-20', note: 'Dark mode.' },
  { version: '1.3.2', date: '2026-09-02', note: 'Search is faster.' },
  { version: '1.3.1', date: '2026-08-11', note: 'Fixed the export button.' },
];
const SHA = process.env.GIT_SHA ?? 'dev';

const page = () => `<!doctype html>
<html>
  <head><title>Changelog</title></head>
  <body>
    <h1>Changelog</h1>
    <ol id="releases">
${RELEASES.map((r) => `      <li><b>${r.version}</b> (${r.date}): ${r.note}</li>`).join('\n')}
    </ol>
  </body>
</html>
`;

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page());
  }
  if (pathname === '/releases.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ releases: RELEASES }));
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
}).listen(Number(process.env.PORT ?? 4330));
