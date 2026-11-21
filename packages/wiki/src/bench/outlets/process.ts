import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// ---- processes ------------------------------------------------------------------------------

export function scrubbedEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TZ: 'UTC' };
}

export function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((res) => {
    let out = '';
    let timedOut = false;
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const append = (b: Buffer) => {
      out = (out + b.toString()).slice(-64_000);
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(proc.pid);
    }, opts.timeoutMs);
    proc.once('error', (e) => {
      clearTimeout(timer);
      res({ code: null, output: `${out}spawn error: ${e.message}\n`, timedOut });
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      killGroup(proc.pid);
      res({ code, output: out, timedOut });
    });
  });
}

export function freeLocalPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}
