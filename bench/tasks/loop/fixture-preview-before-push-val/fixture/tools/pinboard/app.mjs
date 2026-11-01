// pinboard: a JSON API for pinned notes.
import { createServer } from 'node:http';

const pins = [];
const EMPTY_MESSAGE = 'Nothing pinned.';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && pathname === '/pins') {
    return json(res, 200, pins.length ? { pins } : { pins, message: EMPTY_MESSAGE });
  }
  if (pathname === '/health/live') return json(res, 200, { ok: true });
  if (pathname === '/__version') return json(res, 200, { sha: process.env.GIT_SHA ?? 'dev' });
  json(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT ?? 4320));
