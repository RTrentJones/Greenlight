import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clamp01, verifyEval } from '../eval';
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
      mcp.registerTool(
        'big',
        { description: 'returns a very large payload', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'x'.repeat(50_000) }] }),
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

// Deterministic judge (0..1 scale): scores 1 if the result contains the rubric's quoted phrase, else 0.
const fakeJudge: Judge = async ({ rubric, result }) => {
  const want = rubric.match(/"([^"]+)"/)?.[1] ?? '';
  const ok = result.includes(want);
  return { score: ok ? 1 : 0, pass: ok, rationale: ok ? 'match' : 'no match' };
};

/** A judge that always returns a fixed score (for the minScore boundary). */
const scoreJudge =
  (score: number): Judge =>
  async () => ({ score, pass: true });

describe('clamp01', () => {
  it('clamps into [0,1] and maps non-numbers to 0', () => {
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(5)).toBe(1); // a stray legacy 1–5 reply clamps to 1, not silently passing
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01('nope')).toBe(0);
  });
});

describe('verifyEval (0..1)', () => {
  it('passes when the judge scores >= minScore, and exports score/explanation/model', async () => {
    const r = await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'greets', tool: 'greeting', rubric: 'says "Hello"' }] },
      fakeJudge,
    );
    expect(r.mode).toBe('eval');
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.score).toBe(1);
    expect(r.checks[0]?.explanation).toBe('match');
    expect(r.checks[0]?.detail).toContain('score 1.00');
    expect(r.model).toBe('claude-sonnet-4-6'); // run metadata for the --json export
    expect(typeof r.durationMs).toBe('number');
  });

  it('fails when the judge scores below minScore', async () => {
    const r = await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'greets', tool: 'greeting', rubric: 'says "Goodbye"' }] },
      fakeJudge,
    );
    expect(r.pass).toBe(false);
  });

  it('treats minScore as a 0..1 boundary (default 0.8): 0.8 passes, 0.79 fails', async () => {
    const at = await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'x', tool: 'greeting', rubric: 'x' }] },
      scoreJudge(0.8),
    );
    expect(at.pass).toBe(true);
    const below = await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'x', tool: 'greeting', rubric: 'x' }] },
      scoreJudge(0.79),
    );
    expect(below.pass).toBe(false);
  });

  it('caps the tool result fed into the judge prompt (bounds judge INPUT tokens)', async () => {
    let seen = 0;
    const recordingJudge: Judge = async ({ result }) => {
      seen = result.length;
      return { score: 1, pass: true };
    };
    await verifyEval(
      url,
      { mode: 'eval', cases: [{ name: 'big', tool: 'big', rubric: 'x' }] },
      recordingJudge,
    );
    // The 50k-char payload must be truncated before the judge sees it (cap 8k + a short marker).
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(9000);
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
