import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssertionSpec } from './assertion';
import type { OutletContext } from './context';
import { errMsg, tail } from './helpers';
import { freeLocalPort, killGroup, runProcess, scrubbedEnv } from './process';

// ---- serving an artifact and running verify -------------------------------------------------

export async function withServed<T>(
  dir: string,
  serve: NonNullable<OutletContext['artifacts']>['serve'],
  fn: (url: string) => Promise<T>,
): Promise<T | { error: string }> {
  const [bin, ...args] = serve.command;
  if (!bin) return { error: 'serve.command is empty' };
  const port = await freeLocalPort();
  const home = mkdtempSync(join(tmpdir(), 'greenlight-artifact-home-'));
  const proc = spawn(bin === 'node' ? process.execPath : bin, args, {
    cwd: dir,
    env: { ...scrubbedEnv(home), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  const append = (b: Buffer) => {
    out = (out + b.toString()).slice(-8000);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  proc.once('error', (e) => {
    append(Buffer.from(`spawn error: ${e.message}\n`));
    exited = true;
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + (serve.readyTimeoutMs ?? 15_000);
    for (;;) {
      if (exited) return { error: `the artifact exited before listening:\n${tail(out)}` };
      try {
        await fetch(url + (serve.readyPath ?? '/'), { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        if (Date.now() > deadline)
          return { error: `the artifact did not listen in time:\n${tail(out)}` };
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn(url);
    } catch (e) {
      return { error: errMsg(e) };
    }
  } finally {
    killGroup(proc.pid);
    rmSync(home, { recursive: true, force: true });
  }
}

export async function defaultRunAssertion(
  repoRoot: string,
  spec: AssertionSpec,
  artifact: { url: string },
): Promise<{ passed: boolean; detail?: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'greenlight-assertion-'));
  try {
    const specPath = join(scratch, 'proposed.config.mjs');
    // A JSON literal only: the proposer's text is never evaluated as code.
    writeFileSync(specPath, `export default ${JSON.stringify(spec, null, 2)};\n`);
    const home = join(scratch, 'home');
    mkdirSync(home);
    const res = await runProcess(
      process.execPath,
      [
        '--import',
        tsxLoader(repoRoot),
        join(repoRoot, 'cli', 'src', 'bin.ts'),
        'verify',
        '--url',
        artifact.url,
        '--spec',
        specPath,
      ],
      { cwd: scratch, env: scrubbedEnv(home), timeoutMs: 120_000 },
    );
    if (res.timedOut) throw new Error(`verify timed out:\n${tail(res.output)}`);
    if (res.code !== 0 && res.code !== 1)
      throw new Error(`verify errored (${res.code}):\n${tail(res.output)}`);
    return { passed: res.code === 0, detail: res.output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function tsxLoader(repoRoot: string): string {
  const loader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (!existsSync(loader))
    throw new Error(`no tsx under ${repoRoot}/node_modules (run pnpm install)`);
  return `file://${loader}`;
}
