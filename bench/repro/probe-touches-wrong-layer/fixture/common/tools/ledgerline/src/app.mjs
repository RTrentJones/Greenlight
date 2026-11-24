// ledgerline: a small bookkeeping API with the C2 split (vision 09): /health/live answers from
// the process alone; /health is readiness and queries the store.
import { createServer } from 'node:http';
import { query } from './store.mjs';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.url === '/') return json(res, 200, { service: 'ledgerline', version: '0.7.2' });
  if (req.url === '/health/live') return json(res, 200, { ok: true });
  if (req.url === '/health') {
    try {
      await query('SELECT 1');
      return json(res, 200, { ok: true, checks: { database: 'healthy' } });
    } catch {
      return json(res, 503, { ok: false, checks: { database: 'down' } });
    }
  }
  return json(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT ?? 3000));
