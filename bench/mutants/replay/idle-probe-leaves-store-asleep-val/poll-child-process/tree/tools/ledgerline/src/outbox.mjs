// MUTANT: the 30-second poll runs in a child process started with its own environment
// (no NODE_OPTIONS): still twenty store queries in a ten-minute idle window.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  spawn(process.execPath, [fileURLToPath(new URL('./poller-child.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, STORE_URL: process.env.STORE_URL },
    stdio: 'ignore',
  });
}
