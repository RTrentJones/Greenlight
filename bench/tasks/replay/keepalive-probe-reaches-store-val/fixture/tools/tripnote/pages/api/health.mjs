// GET /api/health — readiness: the app is up and Supabase answers a query. Used by verify.
import { db } from '../../src/db.mjs';

export default async function handler(_req, res) {
  const { error } = await db.from('trips').select('id').limit(1);
  res.status(error ? 503 : 200).json({ ok: !error, database: error ? 'down' : 'up' });
}
