import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type McpSpec, type VerifyCheck, type VerifyReport, msg, report } from './types';

/**
 * Protocol-level MCP verification (docs/archive/greenlight-v1.md §6):
 *   initialize handshake → tools/list → optional tools/call → optional auth assertion.
 * No UI — this replaces Playwright for the mcp lane.
 */
export async function verifyMcp(baseUrl: string, spec: McpSpec): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const client = new Client({ name: 'greenlight-verify', version: '0.0.0' });
  // spec.headers (e.g. a Bearer token from env) auth the transport so initialize/tools/list/call
  // work against an OAuth-gated server — the functional ("eval") signal beyond a 401 smoke check.
  const transport = new StreamableHTTPClientTransport(
    new URL(baseUrl),
    spec.headers ? { requestInit: { headers: spec.headers } } : undefined,
  );

  try {
    await client.connect(transport); // performs the initialize handshake
    checks.push({ name: 'initialize handshake', pass: true });
  } catch (e) {
    checks.push({ name: 'initialize handshake', pass: false, detail: msg(e) });
    return report('mcp', baseUrl, checks); // nothing else is reachable without a session
  }

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // Always exercise tools/list so the handshake + list are proven even with no expectTools.
    checks.push({ name: `tools/list responded (${names.length} tools)`, pass: true });
    for (const t of spec.expectTools) {
      const has = names.includes(t);
      checks.push({
        name: `tools/list includes "${t}"`,
        pass: has,
        detail: has ? undefined : `got [${names.join(', ')}]`,
      });
    }
    // Drift guard: the live tool set must match expectTools exactly — catches a capability added in
    // code but not in the verify loop (extra), or a removed/renamed one (missing).
    if (spec.exactTools) {
      const expected = new Set(spec.expectTools);
      const extra = names.filter((n) => !expected.has(n));
      const missing = spec.expectTools.filter((t) => !names.includes(t));
      const drift = [
        extra.length ? `unexpected: [${extra.join(', ')}]` : '',
        missing.length ? `missing: [${missing.join(', ')}]` : '',
      ]
        .filter(Boolean)
        .join('; ');
      checks.push({
        name: 'tools/list matches expectTools exactly',
        pass: drift.length === 0,
        detail: drift || undefined,
      });
    }
  } catch (e) {
    checks.push({ name: 'tools/list', pass: false, detail: msg(e) });
  }

  if (spec.call) {
    const label = `tools/call ${spec.call.name}`;
    try {
      const res = (await client.callTool({
        name: spec.call.name,
        arguments: spec.call.args ?? {},
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      const reasons: string[] = [];
      if (res.isError) reasons.push('result.isError = true');
      for (const k of spec.call.expectKeys ?? []) {
        if (!res.structuredContent || !(k in res.structuredContent)) {
          reasons.push(`structuredContent missing "${k}"`);
        }
      }
      checks.push({
        name: label,
        pass: reasons.length === 0,
        detail: reasons.join('; ') || undefined,
      });
    } catch (e) {
      checks.push({ name: label, pass: false, detail: msg(e) });
    }
  }

  await client.close();

  if (spec.requireAuthRejection) checks.push(await checkAuthRejection(baseUrl));

  return report('mcp', baseUrl, checks);
}

/** On auth != none servers, a bare unauthenticated initialize must be rejected. */
async function checkAuthRejection(baseUrl: string): Promise<VerifyCheck> {
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'greenlight-verify-probe', version: '0.0.0' },
        },
      }),
    });
    const rejected = res.status === 401 || res.status === 403;
    return {
      name: 'unauthenticated request rejected',
      pass: rejected,
      detail: rejected ? undefined : `expected 401/403, got ${res.status}`,
    };
  } catch (e) {
    return { name: 'unauthenticated request rejected', pass: false, detail: msg(e) };
  }
}
