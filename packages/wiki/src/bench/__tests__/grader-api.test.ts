import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGraderContext, runGraderJob, sandboxEnv } from '../grader-api';

// The uniform grader interface (vision 06 §4.2, §4.6).

const here = dirname(new URL(import.meta.url).pathname);
const WEAK = join(here, 'fixtures/weak-bench');
const TASK = 'loop/weak-grader-train';
const work = mkdtempSync(join(tmpdir(), 'grader-api-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const job = (extra: Record<string, string> = {}) => ({
  taskId: TASK,
  benchDir: WEAK,
  graderPath: join(WEAK, 'graders', TASK, 'grade.mjs'),
  tree: work,
  ...extra,
});

describe('createGraderContext', () => {
  it('loads the task, the trajectory and its parse errors', () => {
    const p = join(work, 'trajectory.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ seq: 0, ts: '2026-11-01T10:00:00Z', source: 'shim', cmd: 'git', argv: ['push', 'origin', 'develop'], cwd: '/s' })}\nnot json\n`,
    );
    const { ctx } = createGraderContext(job({ trajectoryPath: p }));
    expect(ctx.task.id).toBe(TASK);
    expect(ctx.kinds).toEqual(['trajectory']);
    expect(ctx.split).toBe('train');
    expect(ctx.trajectory).toHaveLength(1);
    expect(ctx.trajectoryErrors).toHaveLength(1);
    const [rule] = ctx.evaluateTrajectory();
    expect(rule?.passed).toBe(false);
    expect(ctx.result([ctx.check('a', true), ctx.check('b', false, 'why')])).toEqual({
      passed: false,
      checks: [
        { name: 'a', passed: true },
        { name: 'b', passed: false, detail: 'why' },
      ],
    });
    expect(ctx.result([]).passed).toBe(false);
  });

  it('hands maintainer output over raw, and validates on request', () => {
    const p = join(work, 'output.json');
    writeFileSync(p, JSON.stringify({ create_pages: [], update_pages: [] }));
    const { ctx } = createGraderContext(job({ maintainerOutputPath: p }));
    expect(ctx.maintainerOutput).toEqual({ create_pages: [], update_pages: [] });
    const v = ctx.validateMaintainerOutput(ctx.maintainerOutput);
    expect(v.success).toBe(false);
    expect(v.error).toMatch(/update_index/);
    writeFileSync(p, '{');
    expect(
      createGraderContext(job({ maintainerOutputPath: p })).ctx.maintainerOutputError,
    ).toBeTruthy();
  });

  it('runs cleanups after grading, in reverse order', async () => {
    const order: number[] = [];
    const { ctx, cleanup } = createGraderContext(job());
    ctx.onCleanup(() => order.push(1));
    ctx.onCleanup(() => order.push(2));
    await cleanup();
    expect(order).toEqual([2, 1]);
  });
});

describe('runGraderJob', () => {
  it('imports grade.mjs, runs it and validates the result', async () => {
    const r = await runGraderJob(job());
    expect(r).toEqual({ passed: false, checks: [{ name: 'trajectory recorded', passed: false }] });
  });

  it('rejects a module without a default grade function', async () => {
    const g = join(work, 'bad.mjs');
    writeFileSync(g, 'export const x = 1;\n');
    await expect(runGraderJob({ ...job(), graderPath: g })).rejects.toThrow(/no default-exported/);
  });
});

describe('agent code runs only in scrubbed child processes', () => {
  it('sandboxEnv allow-lists PATH, HOME and TZ', () => {
    process.env.GREENLIGHT_TEST_SECRET = 'x';
    try {
      expect(Object.keys(sandboxEnv('/tmp/h', { A: '1' })).sort()).toEqual([
        'A',
        'HOME',
        'PATH',
        'TZ',
      ]);
    } finally {
      Reflect.deleteProperty(process.env, 'GREENLIGHT_TEST_SECRET');
    }
  });

  it('spawnNode runs a script in its own process, with a throwaway HOME, over IPC', async () => {
    const script = join(work, 'echo-env.mjs');
    writeFileSync(
      script,
      "globalThis.fetch = () => 'patched';\nprocess.on('message', () => process.send({ env: process.env, cwd: process.cwd() }));\n",
    );
    process.env.GREENLIGHT_TEST_SECRET = 'x';
    const { ctx, cleanup } = createGraderContext(job());
    try {
      const child = ctx.spawnNode({ script, cwd: work });
      const reply = new Promise<{ env: Record<string, string>; cwd: string }>((res) =>
        child.onMessage((m) => res(m as { env: Record<string, string>; cwd: string })),
      );
      child.send({});
      const { env, cwd } = await reply;
      expect(env.GREENLIGHT_TEST_SECRET).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(cwd).toBe(work);
      // The child's patch never reaches the grader.
      expect(typeof globalThis.fetch).toBe('function');
      expect(String(globalThis.fetch)).not.toMatch(/patched/);
    } finally {
      Reflect.deleteProperty(process.env, 'GREENLIGHT_TEST_SECRET');
      await cleanup();
    }
  });
});

describe('the fake clock reaches every thread and process of the app (re-review 4)', () => {
  const LIB = join(here, '../../../../../bench/graders/_lib');
  const CHILD = `
const url = 'http://127.0.0.1:' + process.env.PORT + '/tick?k=' + process.env.K;
setInterval(() => { fetch(url).catch(() => {}); }, 30_000);
`;
  const APP = `
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const counts = {};
const inc = (k) => { counts[k] = (counts[k] ?? 0) + 1; };
const child = fileURLToPath(new URL('./child.mjs', import.meta.url));
// (a) a 1 s tick guarded by monotonic clocks
let p0 = performance.now();
let h0 = process.hrtime.bigint();
setInterval(() => {
  if (performance.now() - p0 >= 30_000) { p0 = performance.now(); inc('perf'); }
  if (process.hrtime.bigint() - h0 >= 30_000_000_000n) { h0 = process.hrtime.bigint(); inc('hrtime'); }
}, 1000);
// (c) a loop on AbortSignal.timeout
(async () => { for (;;) { const s = AbortSignal.timeout(30_000); await new Promise((r) => s.addEventListener('abort', r, { once: true })); inc('abort'); } })();
// (b) worker threads: eval and file entries
new Worker("const { parentPort } = require('node:worker_threads'); setInterval(() => parentPort.postMessage('t'), 30_000);", { eval: true }).on('message', () => inc('evalWorker'));
new Worker(new URL('./worker.mjs', import.meta.url)).on('message', () => inc('fileWorker'));
// child processes: fork, an explicit env without NODE_OPTIONS, and a shell wrapper
fork(child, { env: { ...process.env, K: 'fork' } });
spawn(process.execPath, [child], { env: { PATH: process.env.PATH, PORT: process.env.PORT, K: 'spawnEnv' }, stdio: 'ignore' });
spawn('sh', ['-c', '"$NODE" "$CHILD"; true'], { env: { PATH: process.env.PATH, PORT: process.env.PORT, K: 'sh', NODE: process.execPath, CHILD: child }, stdio: 'ignore' });
createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/tick') inc(u.searchParams.get('k'));
  res.end(JSON.stringify(counts));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
  it('20 polls in 10 simulated minutes, whatever clock or thread or process they use', async () => {
    const dir = mkdtempSync(join(work, 'clock-app-'));
    writeFileSync(join(dir, 'app.mjs'), APP);
    writeFileSync(join(dir, 'child.mjs'), CHILD);
    writeFileSync(
      join(dir, 'worker.mjs'),
      "import { parentPort } from 'node:worker_threads';\nsetInterval(() => parentPort.postMessage('t'), 30_000);\n",
    );
    const { startClockCoordinator } = await import(join(LIB, 'fake-clock-coordinator.mjs'));
    const start = Date.parse('2026-11-01T10:00:00Z');
    const clock = await startClockCoordinator({ start });
    const { ctx, cleanup } = createGraderContext(job());
    try {
      const app = await ctx.spawnApp({
        cwd: dir,
        command: ['node', 'app.mjs'],
        env: clock.env(),
        preload: [join(LIB, 'fake-clock-shim.mjs')],
      });
      await clock.waitForParticipant();
      for (let t = 60_000; t <= 600_000; t += 60_000) await clock.advance(start + t);
      await new Promise((r) => setTimeout(r, 200));
      const counts = (await (await fetch(`${app.url}/`)).json()) as Record<string, number>;
      for (const k of [
        'perf',
        'hrtime',
        'abort',
        'evalWorker',
        'fileWorker',
        'fork',
        'spawnEnv',
        'sh',
      ]) {
        expect(counts[k], `${k}: ${JSON.stringify(counts)} ${app.output()}`).toBeGreaterThanOrEqual(
          19,
        );
        expect(counts[k], k).toBeLessThanOrEqual(20);
      }
      expect(clock.problems()).toEqual([]);
      // 1 app + 2 workers + 3 node children.
      expect(clock.joined()).toBe(6);
    } finally {
      await cleanup();
      await clock.stop();
    }
  }, 60_000);
});
