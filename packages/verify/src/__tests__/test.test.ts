import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { verifyTest } from '../test';

const cwd = tmpdir();

describe('verifyTest', () => {
  it('passes when the command exits 0', () => {
    const r = verifyTest({ mode: 'test', command: 'exit 0' }, cwd);
    expect(r.pass).toBe(true);
    expect(r.mode).toBe('test');
  });

  it('fails when the command exits non-zero, with the exit code in the detail', () => {
    const r = verifyTest({ mode: 'test', command: 'exit 3' }, cwd);
    expect(r.pass).toBe(false);
    expect(r.checks[0]?.detail).toContain('exit 3');
  });

  it('captures a runner summary line on success', () => {
    const r = verifyTest({ mode: 'test', command: "echo 'Tests  3 passed (3)'" }, cwd);
    expect(r.pass).toBe(true);
    expect(r.checks[0]?.detail).toContain('3 passed');
  });

  it('uses the provided cwd', () => {
    const r = verifyTest({ mode: 'test', command: 'exit 0', cwd }, cwd);
    expect(r.url).toContain(cwd);
  });
});
