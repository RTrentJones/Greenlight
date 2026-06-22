import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Lane } from '@rtrentjones/greenlight-shared';
import { allPass, verifyAll } from '@rtrentjones/greenlight-verify';
import {
  type ResolvedEntry,
  loadExternalVerifySpec,
  loadManifest,
  loadVerifySpec,
  resolveEntry,
} from '../manifest';
import { defaultSpec, printReport } from './verify';

/**
 * `greenlight preview <name>` — spin the tool up LOCALLY → wait for ready → verify → tear down, in
 * one command: the uniform pre-deploy gate. Removes the "verify ran before the server was up" race.
 *
 * Two serve paths, same shape:
 *  - **descriptor** (`preview: { command, … }` in the manifest) — any target with no built-in serve
 *    (e.g. `oci`: a docker command matching the prod transport). Also the only way to preview an
 *    external tool locally.
 *  - **built-in** (node lanes) — build + `pnpm run preview|start`.
 *
 * Either way the harness exports `GREENLIGHT_PREVIEW=1` + `GREENLIGHT_VERIFY_URL` so a verify config
 * can pick a local-appropriate spec (e.g. skip an auth-rejection check a local no-auth server can't
 * satisfy).
 */
interface ServePlan {
  build: boolean;
  script: string;
  port: number;
  path: string;
}

export function servePlan(lane: Lane, port?: number): ServePlan {
  switch (lane) {
    case 'mcp':
      return { build: false, script: 'start', port: port ?? 8787, path: '/mcp' };
    default: // astro | next — static/SSR build, then `preview`
      return { build: true, script: 'preview', port: port ?? 4321, path: '' };
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Poll until the server accepts a connection (any HTTP response), or time out. */
async function waitForServer(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

/** Load the tool's spec (external → wrapper's verify/<name>.config.ts; local → <dir>/verify.config.ts). */
async function loadSpecs(entry: ResolvedEntry) {
  const loaded =
    (entry.external && entry.name
      ? await loadExternalVerifySpec(entry.name)
      : await loadVerifySpec(entry.dir)) ?? defaultSpec(entry.lane);
  return Array.isArray(loaded) ? loaded : [loaded];
}

/** Run verify against a local URL, printing each report; returns the aggregate pass. */
async function verifyLocal(entry: ResolvedEntry, url: string): Promise<boolean> {
  // Set BEFORE loading the spec — configs read these at module-eval time (jiti).
  process.env.GREENLIGHT_PREVIEW = '1';
  process.env.GREENLIGHT_VERIFY_URL = url;
  const specs = await loadSpecs(entry);
  const toolDir = resolve(process.cwd(), entry.dir ?? '.');
  const reports = await verifyAll(url, specs, { toolDir });
  for (const report of reports) printReport(report);
  return allPass(reports);
}

/** Descriptor path: run the tool's own spin-up command (any target / external), verify, tear down. */
async function previewViaDescriptor(
  entry: ResolvedEntry,
  name: string,
  portOverride?: number,
): Promise<boolean> {
  const pv = entry.preview as NonNullable<ResolvedEntry['preview']>;
  const lane = servePlan(entry.lane);
  const port = portOverride ?? pv.port ?? entry.port ?? lane.port;
  const path = pv.path ?? lane.path;
  const url = `http://localhost:${port}${path}`;
  const toolDir = resolve(process.cwd(), entry.dir ?? '.');

  console.log(`preview ${name}: ${pv.command}  (→ ${url})`);
  const child = spawn(pv.command, {
    cwd: toolDir,
    shell: true,
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, PORT: String(port), GREENLIGHT_PREVIEW: '1' },
  });

  try {
    if (!(await waitForServer(url, 120_000))) {
      throw new Error(`preview server did not become reachable at ${url} (check: ${pv.command})`);
    }
    return await verifyLocal(entry, url);
  } finally {
    if (pv.teardown) {
      try {
        execFileSync(pv.teardown, { cwd: toolDir, shell: true, stdio: 'inherit' });
      } catch {
        // teardown is best-effort
      }
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
}

/** Built-in path: build + `pnpm run <preview|start>` for node lanes (local tools only). */
async function previewViaBuiltIn(
  entry: ResolvedEntry,
  name: string,
  portOverride?: number,
): Promise<boolean> {
  const plan = servePlan(entry.lane, portOverride);

  if (plan.build) {
    console.log(`build ${name} (${entry.dir})`);
    execFileSync('pnpm', ['-C', entry.dir, 'run', 'build'], { stdio: 'inherit' });
  }

  console.log(`serve ${name} on :${plan.port}`);
  const runArgs = ['-C', entry.dir, 'run', plan.script];
  if (plan.script === 'preview') runArgs.push('--', '--port', String(plan.port));
  // detached so we can SIGTERM the whole process group (pnpm + the framework's dev server).
  const child = spawn('pnpm', runArgs, {
    env: { ...process.env, PORT: String(plan.port) },
    stdio: 'ignore',
    detached: true,
  });

  try {
    const base = `http://localhost:${plan.port}`;
    if (!(await waitForServer(base))) {
      throw new Error(
        `server did not start on :${plan.port} (check the tool's ${plan.script} script)`,
      );
    }
    return await verifyLocal(entry, base + plan.path);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
}

export async function previewCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error('usage: greenlight preview <name> [--port <n>]');
  }
  const portArg = flag(args, '--port');
  const port = portArg ? Number(portArg) : undefined;
  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);

  // A preview descriptor handles any target (incl. oci/docker) AND external tools (their code is a
  // submodule here; the descriptor knows how to run it locally). Otherwise fall back to the built-in
  // node serve — which only works for a local (non-external) tool.
  let pass: boolean;
  if (entry.preview) {
    pass = await previewViaDescriptor(entry, name, port);
  } else if (entry.external && entry.target === 'vercel') {
    throw new Error(
      `"${name}" is a vercel tool — its pre-prod gate is Vercel's per-PR preview deployment (the greenlight-verify.yml on deployment_status), not \`greenlight preview\`. Open a PR on its repo to get a preview + verify.`,
    );
  } else if (entry.external) {
    throw new Error(
      `"${name}" is external and has no preview descriptor — add preview:{ command, … } to its manifest entry (e.g. a docker command), or preview it from its own repo`,
    );
  } else {
    pass = await previewViaBuiltIn(entry, name, port);
  }
  process.exit(pass ? 0 : 1);
}
