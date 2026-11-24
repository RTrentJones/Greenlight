// MUTANT: the poll waits on AbortSignal.timeout(30_000) instead of a timer: still twenty
// store queries in a ten-minute idle window.
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
  (async () => {
    for (;;) {
      const signal = AbortSignal.timeout(30_000);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      kick();
    }
  })();
}
