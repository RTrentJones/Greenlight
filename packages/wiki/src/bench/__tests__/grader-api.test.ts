import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGraderContext, runGraderJob } from '../grader-api';

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
  resultPath: join(work, 'result.json'),
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
