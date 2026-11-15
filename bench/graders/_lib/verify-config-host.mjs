/**
 * Grader-side host for the AGENT's verify config (hidden). It runs as its own child process
 * (`ctx.spawnNode`), never inside the grader: a `verify.config.mjs` is code, and whatever it does
 * at import stays in this process, whose environment is scrubbed and whose only channel is IPC.
 *
 *   node verify-config-host.mjs <absolute path of the config>
 *   → { checks: [ …the api checks of every spec, as plain JSON… ] } | { error }
 *
 * A config's default export is a spec, an array of specs, or a function of `{ preview, env }`
 * returning either (packages/verify); the function is called the way the beta deploy gate calls
 * it.
 */
import { pathToFileURL } from 'node:url';

const send = (m) => new Promise((res) => process.send(m, undefined, {}, () => res()));

try {
  const mod = await import(pathToFileURL(process.argv[2]).href);
  let spec = mod.default;
  if (typeof spec === 'function') spec = await spec({ preview: false, env: 'beta' });
  const specs = (Array.isArray(spec) ? spec : [spec]).filter((s) => s && typeof s === 'object');
  const checks = specs.flatMap((s) => (Array.isArray(s.checks) ? s.checks : []));
  // Plain data only: a regex, a function or a cycle never crosses the channel.
  await send({ checks: JSON.parse(JSON.stringify(checks)) });
} catch (e) {
  await send({ error: String(e?.message ?? e).slice(0, 500) });
}
process.exit(0);
