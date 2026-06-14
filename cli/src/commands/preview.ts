import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Lane } from '@rtrentjones/greenlight-shared';
import { verify } from '@rtrentjones/greenlight-verify';
import { loadManifest, loadVerifySpec, resolveEntry } from '../manifest';
import { defaultSpec, printReport } from './verify';

/**
 * `greenlight preview <name>` — build → serve locally → wait for ready → verify →
 * tear down, in one command. Removes the "verify ran before the server was up" race.
 * Local stand-in for the preview env (no cloud).
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

export async function previewCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error('usage: greenlight preview <name> [--port <n>]');
  }
  const portArg = flag(args, '--port');
  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  const plan = servePlan(entry.lane, portArg ? Number(portArg) : undefined);

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

  let pass = false;
  try {
    const base = `http://localhost:${plan.port}`;
    if (!(await waitForServer(base))) {
      throw new Error(
        `server did not start on :${plan.port} (check the tool's ${plan.script} script)`,
      );
    }
    const spec = (await loadVerifySpec(entry.dir)) ?? defaultSpec(entry.lane);
    const report = await verify(base + plan.path, spec);
    printReport(report);
    pass = report.pass;
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  process.exit(pass ? 0 : 1);
}
