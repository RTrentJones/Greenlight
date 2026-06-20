import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyEval } from '../eval';
import type { Judge } from '../types';

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

beforeAll(async () => {
  server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (req.method === 'POST') {
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
      mcp.registerTool(
        'greeting',
        { description: 'returns a greeting', inputSchema: {} },
        async () => ({
          content: [{ type: 'text', text: 'Hello, world!' }],
        }),
      );
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

// Deterministic judge: scores 5 if the result contains the rubric's quoted phrase, else 1.
const fakeJudge: Judge = async ({ rubric, result }) => {
  const want = rubric.match(/"([^"]+)"/)?.[1] ?? '';
  const ok = result.includes(want);
  return { score: ok ? 5 : 1, pass: ok, reason: ok ? 'match' : 'no match' };
};

describe('verifyEval', () => {
  it('calls an MCP tool and passes when the judge scores >= minScore', async () => {
    const r = await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'greets', tool: 'greeting', rubric: 'says "Hello"' }] },
      fakeJudge,
    );
    expect(r.mode).toBe('eval');
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.detail).toContain('score 5/5');
  });

  it('fails when the judge scores below minScore', async () => {
    const r = await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'greets', tool: 'greeting', rubric: 'says "Goodbye"' }] },
      fakeJudge,
    );
    expect(r.pass).toBe(false);
  });

  it('fails honestly on a connection error (no throw)', async () => {
    const r = await verifyEval(
      'http://127.0.0.1:1/mcp',
      { mode: 'eval', cases: [{ name: 'x', tool: 'greeting', rubric: 'x' }] },
      fakeJudge,
    );
    expect(r.pass).toBe(false);
    expect(r.checks[0]?.name).toContain('initialize');
  });
});
