// scenesmith: an MCP server that generates scenes. Streamable HTTP at /mcp.
import { createServer } from 'node:http';
import { sql } from './db.mjs';
import { enqueue, startWorker } from './jobs.mjs';

const port = Number(process.env.PORT ?? 8080);

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const TOOLS = [
  {
    name: 'generate_scene',
    description: 'Queue a scene for generation from a prompt.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
  },
];

async function mcp(req, res) {
  const msg = await readJson(req);
  if (msg.method === 'initialize') {
    return send(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'scenesmith', version: '1.4.0' },
      },
    });
  }
  if (msg.method === 'tools/list') {
    return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'generate_scene') {
    await enqueue(String(msg.params.arguments?.prompt ?? ''));
    return send(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'queued' }] },
    });
  }
  return send(res, 200, {
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'unknown method' },
  });
}

async function health(res) {
  try {
    await sql('SELECT 1', [], 'health');
    send(res, 200, { ok: true, database: 'up' });
  } catch (e) {
    send(res, 503, { ok: false, database: 'down', error: e.message });
  }
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && pathname === '/')
    return send(res, 200, { name: 'scenesmith', mcp: '/mcp' });
  // OVERGENERAL A (mutant): "every healthcheck and keepalive queries the database", so a probe can
  // never pass while the store is unreachable.
  if (req.method === 'GET' && pathname === '/health/live') return health(res);
  if (req.method === 'GET' && pathname === '/health') return health(res);
  if (req.method === 'POST' && pathname === '/mcp') return mcp(req, res);
  send(res, 404, { error: 'not found' });
});

await sql(
  "CREATE TABLE IF NOT EXISTS jobs (id serial PRIMARY KEY, prompt text, status text NOT NULL DEFAULT 'queued', created_at timestamptz DEFAULT now())",
  [],
  'migrate',
).catch((e) => console.error('migrate:', e.message));
startWorker();
server.listen(port, () => console.log(`scenesmith listening on ${port}`));
