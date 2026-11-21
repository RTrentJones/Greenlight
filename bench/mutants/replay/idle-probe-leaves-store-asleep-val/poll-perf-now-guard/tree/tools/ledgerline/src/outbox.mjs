// MUTANT: a 1-second tick that polls only when performance.now() says 30 seconds passed:
// still twenty store queries in a ten-minute idle window.
import { query } from './store.mjs';

let running = null;

export function kick() {
  running ??= relay()
    .catch((e) => console.error('outbox:', e.message))
    .finally(() => {
      running = null;
    });
  return running;
}

async function relay() {
  for (;;) {
    const rows = await query(
      'SELECT id, topic, payload FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 10',
      [],
      'outbox',
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      await query('UPDATE outbox SET sent_at = now() WHERE id = $1', [row.id], 'outbox');
    }
  }
}

export function startRelay() {
  let last = performance.now();
  setInterval(() => {
    if (performance.now() - last < 30_000) return;
    last = performance.now();
    kick();
  }, 1000);
}
