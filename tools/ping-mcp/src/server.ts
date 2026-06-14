import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Throwaway MCP server (the `oci`/BAMCP shape: a Node streamable-HTTP server, run
 * behind a Cloudflare Tunnel in prod). It proves the protocol loop locally — run it
 * and `greenlight verify ping-mcp --url http://127.0.0.1:8787/mcp` — without any cloud.
 */
const PORT = Number(process.env.PORT ?? 8787);
const transports: Record<string, StreamableHTTPServerTransport> = {};

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'ping-mcp', version: '0.0.0' });
  server.registerTool(
    'ping',
    { description: 'Health ping — returns pong.', inputSchema: {} },
    async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }),
  );
  return server;
}

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

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end('ping-mcp — connect at /mcp');
    return;
  }

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
      await buildMcpServer().connect(transport);
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

http
  .createServer((req, res) => {
    void handle(req, res);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`ping-mcp listening on http://127.0.0.1:${PORT}/mcp`);
  });
