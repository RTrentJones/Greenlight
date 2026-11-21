import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Cross-process race harness for the lock tests: runs `n` node children (TypeScript via tsx)
 * that all start their body at the same instant. */

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `n` children. Each imports `moduleUrl` as `m`, busy-waits until a shared start instant,
 * then runs `body` (an async function body with `m`, `arg` and `idx` in scope) and prints its
 * JSON return value on stdout.
 */
export async function race(
  n: number,
  moduleUrl: string,
  body: string,
  arg: unknown,
): Promise<ChildResult[]> {
  const start = Date.now() + 3_000;
  const code = `
    const m = await import(${JSON.stringify(moduleUrl)});
    const arg = JSON.parse(process.env.RACE_ARG);
    const idx = Number(process.env.RACE_IDX);
    while (Date.now() < ${start}) {}
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out ?? null));
  `;
  return Promise.all(
    Array.from(
      { length: n },
      (_, idx) =>
        new Promise<ChildResult>((done) => {
          const child = spawn(
            process.execPath,
            ['--import', TSX, '--input-type=module', '-e', code],
            {
              env: { ...process.env, RACE_ARG: JSON.stringify(arg), RACE_IDX: String(idx) },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => {
            stdout += d;
          });
          child.stderr.on('data', (d) => {
            stderr += d;
          });
          child.on('close', (c) => done({ code: c, stdout, stderr }));
        }),
    ),
  );
}
