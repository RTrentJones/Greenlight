// MUTANT (worker thread): polls the queue every 30 seconds.
import { sql } from './db.mjs';

setInterval(() => {
  sql(
    "SELECT id, prompt FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1",
    [],
    'worker',
  ).catch(() => {});
}, 30_000);
