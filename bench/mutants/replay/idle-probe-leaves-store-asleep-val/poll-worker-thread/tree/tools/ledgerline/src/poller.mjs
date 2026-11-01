// MUTANT (worker thread): polls the queue every 30 seconds.
import { query } from './store.mjs';

setInterval(() => {
  query(
    'SELECT id, topic, payload FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 10',
    [],
    'outbox',
  ).catch(() => {});
}, 30_000);
