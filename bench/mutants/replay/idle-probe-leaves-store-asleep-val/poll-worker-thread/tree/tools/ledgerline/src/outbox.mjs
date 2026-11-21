// MUTANT: the 30-second poll runs in a worker_threads Worker: still twenty store queries
// in a ten-minute idle window.
import { Worker } from 'node:worker_threads';
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
  new Worker(new URL('./poller.mjs', import.meta.url));
}
