// MUTANT: the 30-second poll runs in a worker_threads Worker: still twenty store queries
// in a ten-minute idle window.
import { Worker } from 'node:worker_threads';
import { sql } from './db.mjs';

let draining = false;

export async function enqueue(prompt) {
  await sql("INSERT INTO jobs (prompt, status) VALUES ($1, 'queued')", [prompt], 'web');
}

export function wake() {
  if (draining) return;
  draining = true;
  drain()
    .catch((e) => console.error('worker:', e.message))
    .finally(() => {
      draining = false;
    });
}

async function drain() {
  for (;;) {
    const rows = await sql(
      "SELECT id, prompt FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
      [],
      'worker',
    );
    const job = rows[0];
    if (!job) return;
    const title = `Scene: ${job.prompt}`;
    await sql('INSERT INTO scenes (title, body) VALUES ($1, $2)', [title, ''], 'worker');
    await sql("UPDATE jobs SET status = 'done' WHERE id = $1", [job.id], 'worker');
  }
}

export function startWorker() {
  new Worker(new URL('./poller.mjs', import.meta.url));
}
