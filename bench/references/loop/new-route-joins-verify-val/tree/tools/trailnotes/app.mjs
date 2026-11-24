// trailnotes: a plain-text list of hiking trails with a note each.
import { createServer } from 'node:http';

const trails = [
  { slug: 'cedar-loop', km: 6.5, note: 'Muddy after rain.' },
  { slug: 'ridge-walk', km: 11, note: 'Exposed; bring water.' },
  { slug: 'mill-creek', km: 3.2, note: 'Bridge closed until spring.' },
  { slug: 'fire-tower', km: 8.4, note: 'Steep last kilometre.' },
];

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};

const routes = {
  '/': (res) =>
    send(
      res,
      200,
      'text/plain; charset=utf-8',
      `Trail notes\n${trails.map((t) => `${t.slug} (${t.km} km): ${t.note}`).join('\n')}\n`,
    ),
  '/trails.json': (res) => send(res, 200, 'application/json', JSON.stringify({ trails })),
  '/health/live': (res) => send(res, 200, 'application/json', JSON.stringify({ ok: true })),
  '/__version': (res) =>
    send(res, 200, 'application/json', JSON.stringify({ sha: process.env.GIT_SHA ?? 'dev' })),
};

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const route = req.method === 'GET' ? routes[pathname] : undefined;
  if (route) return route(res);
  send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
}).listen(Number(process.env.PORT ?? 4340));
