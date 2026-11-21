// ledgerline: a small bookkeeping API.
import { createServer } from 'node:http';
import { kick, startRelay } from './outbox.mjs';
import { dispatch, readBody, route } from './router.mjs';
import { query } from './store.mjs';

route('GET', '/', async () => ({ status: 200, body: { service: 'ledgerline', version: '0.7.2' } }));

// OVERGENERAL A (mutant): "every healthcheck and keepalive queries the database".
route('GET', '/health/live', async () => {
  await query('SELECT 1', [], 'live');
  return { status: 200, body: { status: 'ok' } };
});

route('GET', '/health', async () => {
  try {
    await query('SELECT 1', [], 'health');
    return { status: 200, body: { status: 'ok', store: 'ok' } };
  } catch (e) {
    return { status: 503, body: { status: 'degraded', store: 'unreachable', error: e.message } };
  }
});

route('GET', '/entries', async () => {
  const rows = await query(
    'SELECT id, account, amount_cents, booked_on FROM entries ORDER BY id DESC LIMIT 50',
  );
  return { status: 200, body: { entries: rows } };
});

route('POST', '/entries', async (req) => {
  const e = await readBody(req);
  await query('INSERT INTO entries (account, amount_cents, booked_on) VALUES ($1, $2, $3)', [
    e.account,
    e.amount_cents,
    e.booked_on,
  ]);
  await query("INSERT INTO outbox (topic, payload) VALUES ('entry.booked', $1)", [
    JSON.stringify(e),
  ]);
  kick();
  return { status: 201, body: { ok: true } };
});

const port = Number(process.env.PORT ?? 3000);
startRelay();
createServer(dispatch).listen(port, () => console.log(`ledgerline on :${port}`));
