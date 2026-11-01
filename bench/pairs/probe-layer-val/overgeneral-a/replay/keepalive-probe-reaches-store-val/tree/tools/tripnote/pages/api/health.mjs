// OVERGENERAL A applied to the needs-traffic tool: "every healthcheck and keepalive queries the
// database". Here that happens to be right: the keepalive already reads heartbeat, and the health
// route reads it too.
import { db } from '../../src/db.mjs';

export default async function handler(_req, res) {
  const { error } = await db.from('heartbeat').select('id').limit(1);
  res.status(error ? 503 : 200).json({ ok: !error, database: error ? 'down' : 'up' });
}
