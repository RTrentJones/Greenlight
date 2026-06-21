import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../index';

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const transports: Record<string, StreamableHTTPServerTransport> = {};
let server: http.Server;
let url: string;
let lastAuthHeader: string | undefined; // captured to prove spec.headers reach the transport

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (req.method === 'POST') {
    lastAuthHeader = req.headers.authorization as string | undefined;
    const body = await readJson(req);
    let transport = sessionId ? transports[sessionId] : undefined;
    if (!transport && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          if (transport) transports[sid] = transport;
        },
      });
      const mcp = new McpServer({ name: 'stub', version: '0.0.0' });
      mcp.registerTool('ping', { description: 'health ping', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }));
      await mcp.connect(transport);
    }
    if (!transport) {
      res.writeHead(400).end('no session');
      return;
    }
    await transport.handleRequest(req, res, body);
  } else if (
    (req.method === 'GET' || req.method === 'DELETE') &&
    sessionId &&
    transports[sessionId]
  ) {
    await transports[sessionId].handleRequest(req, res);
  } else {
    res.writeHead(405).end();
  }
}

describe('verify mcp', () => {
  it('runs initialize -> tools/list -> call against a stub MCP server', async () => {
    const r = await verify(url, { mode: 'mcp', expectTools: ['ping'], call: { name: 'ping' } });
    expect(r.mode).toBe('mcp');
    expect(r.checks.find((c) => c.name.includes('initialize'))?.pass).toBe(true);
    expect(r.checks.find((c) => c.name.includes('"ping"'))?.pass).toBe(true);
    expect(r.checks.find((c) => c.name.startsWith('tools/call'))?.pass).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('flags a missing expected tool', async () => {
    const r = await verify(url, { mode: 'mcp', expectTools: ['does-not-exist'] });
    expect(r.pass).toBe(false);
  });

  it('passes spec.headers (e.g. a Bearer token) through the transport — the authed/eval signal', async () => {
    const r = await verify(url, {
      mode: 'mcp',
      expectTools: ['ping'],
      call: { name: 'ping' },
      headers: { Authorization: 'Bearer tkn-123' },
    });
    expect(r.pass).toBe(true);
    expect(lastAuthHeader).toBe('Bearer tkn-123'); // the server saw the injected auth header
  });
});
