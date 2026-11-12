#!/usr/bin/env node
// Trusted reproduction for pattern/probe-touches-wrong-layer (vision 06 §4.6, §10; 07 DR-21).
//
//   node run.mjs --tree <framework checkout with dependencies installed>
//
// Builds three fixture wrappers around one needs-silence tool (`ledgerline`: docker host, Neon
// wired directly in infra) and runs that checkout's `greenlight doctor` in each:
//
//   faulty-probe        the keepalive target probes /health, the store-querying readiness route
//   faulty-healthcheck  the compose healthcheck targets /health
//   fixed               both use /health/live (C2), which answers from the process alone
//
// Exit 0 (passes): doctor loads every manifest, flags ledgerline with a failure in both faulty
// wrappers, and raises no failure about ledgerline in the fixed one. Exit 1 (fails): any of that
// does not hold, i.e. the condition is not caught (today's doctor has no DR-21). Exit 2: the
// repro itself could not run. The last stdout line is a JSON summary.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture');
const TOOL = 'ledgerline';

const VARIANTS = {
  'faulty-probe': { layers: ['common', 'probe-store', 'healthcheck-live'], flagged: true },
  'faulty-healthcheck': { layers: ['common', 'probe-live', 'healthcheck-store'], flagged: true },
  fixed: { layers: ['common', 'probe-live', 'healthcheck-live'], flagged: false },
};

function fail(code, message) {
  console.log(message);
  console.log(
    JSON.stringify({ verdict: code === 0 ? 'pass' : code === 1 ? 'fail' : 'error', message }),
  );
  process.exit(code);
}

const at = process.argv.indexOf('--tree');
const treeArg = at >= 0 ? process.argv[at + 1] : undefined;
if (!treeArg) fail(2, 'usage: node run.mjs --tree <framework checkout>');
const tree = resolve(treeArg);
const bin = join(tree, 'cli', 'src', 'bin.ts');
const loader = join(tree, 'node_modules', 'tsx', 'dist', 'loader.mjs');
if (!existsSync(bin)) fail(2, `no CLI entry at ${bin}`);
if (!existsSync(loader))
  fail(2, `no tsx under ${tree}/node_modules: install the tree's dependencies first`);

/** One `greenlight doctor` run in a fresh wrapper built from the variant's layers. */
function doctor(name, layers) {
  const root = mkdtempSync(join(tmpdir(), `repro-probe-layer-${name}-`));
  try {
    const wrapper = join(root, 'wrapper');
    for (const l of layers) cpSync(join(fixture, l), wrapper, { recursive: true, force: true });
    const home = join(root, 'home');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, bin, 'doctor'], {
      cwd: wrapper,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.error) fail(2, `doctor did not run on ${name}: ${r.error.message}`);
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Failure lines (doctor prints `✘` for status fail) that are about the tool. */
const failuresAbout = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('✘') && l.includes(TOOL));

const checks = [];
for (const [name, v] of Object.entries(VARIANTS)) {
  const { code, out } = doctor(name, v.layers);
  const loaded = out.includes('manifest: loaded & valid');
  const about = failuresAbout(out);
  const passed = loaded && (v.flagged ? code !== 0 && about.length > 0 : about.length === 0);
  const why = !loaded
    ? 'the manifest did not load'
    : v.flagged
      ? about.length > 0
        ? `flagged: ${about.join(' | ')}`
        : `doctor raised no failure about ${TOOL} (exit ${code})`
      : about.length > 0
        ? `wrongly flagged: ${about.join(' | ')}`
        : 'not flagged';
  checks.push({ name: `${name}: ${v.flagged ? 'flagged' : 'not flagged'}`, passed, detail: why });
  console.log(`${passed ? '✔' : '✘'} ${name} — ${why}`);
  if (!loaded) console.log(out.split('\n').slice(0, 5).join('\n'));
}

const ok = checks.every((c) => c.passed);
console.log(JSON.stringify({ verdict: ok ? 'pass' : 'fail', checks }));
process.exit(ok ? 0 : 1);
