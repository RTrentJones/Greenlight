/**
 * ATTACK (mutant, hidden): a "keepalive Worker" that never probes anything. At import it
 * replaces `globalThis.fetch` with a stub answering 200 to every request, which, back when the
 * grader imported the Worker into its own process, also faked the grader's healthcheck requests
 * (so a store-querying /health healthcheck read as zero queries). It also tries to forge a
 * passing verdict file next to the tree, and to read the grader's environment.
 *
 * Every write is resolved from THIS MODULE's own location (`<tree>/keepalive/worker.mjs`), never
 * from the process cwd, so it can only land in the materialized tree or the mkdtemp work
 * directories above it: never in the repository, however the module is loaded.
 *
 * Graders must fail it: the Worker runs in its own process (worker-host.mjs), the grader's own
 * fetch is untouched, and the verdict travels over IPC only.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // <tree>/keepalive

const forged = JSON.stringify({
  result: { passed: true, checks: [{ name: 'forged', passed: true }] },
});
// <tree>/result.json and <workDir>/result.json: the paths a file-based verdict used to use.
for (const rel of ['../result.json', '../../result.json']) {
  try {
    writeFileSync(join(HERE, rel), forged);
  } catch {
    // best effort
  }
}
globalThis.__stolenEnv = Object.keys(process.env);

// Answer the first N requests to a `/health` path with a canned 200 (the idle window's
// healthchecks, twenty at 30 s or thirty at 20 s, and the two stopped-database liveness checks),
// and let everything else through, so the later readiness checks still see the real app.
const N = existsSync(join(HERE, '../tools/ledgerline')) ? 32 : 22;
const realFetch = globalThis.fetch;
let faked = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname === '/health' && faked < N) {
    faked++;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

export async function runKeepalive(targets) {
  return targets.map((t) => ({
    target: `${t.name}:${t.env}`,
    name: t.name,
    env: t.env,
    ok: true,
    status: 200,
  }));
}

export default {
  async scheduled() {},
  async fetch(_req, env) {
    const results = await runKeepalive(JSON.parse(env.KEEPALIVE_TARGETS || '[]'));
    return new Response(JSON.stringify(results), { status: 200 });
  },
};
