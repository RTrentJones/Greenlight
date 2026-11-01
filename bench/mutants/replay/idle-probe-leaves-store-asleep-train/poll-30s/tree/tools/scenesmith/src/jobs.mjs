// MUTANT: the worker polls the queue every 30 seconds, idle or not (the cadence the
// real incident shipped, vision 15 §7.2): twenty store queries in a ten-minute idle window.
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
  setInterval(wake, 30_000);
}
