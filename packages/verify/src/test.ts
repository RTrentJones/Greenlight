import { spawnSync } from 'node:child_process';
import { type TestSpec, type VerifyReport, msg, report } from './types';

/** Pull a one-line summary out of common runners' output (vitest/jest/node:test). */
function summarize(output: string): string | undefined {
  const lines = output.split('\n');
  const hit = lines.find((l) => /Tests?\s+\d+\s+(passed|failed)|Tests:|# (pass|fail)\b/.test(l));
  if (hit) return hit.trim();
  // fall back to the last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l?.trim()) return l.trim();
  }
  return undefined;
}

/**
 * test mode — run the tool's own unit/integration command in its dir and gate on the exit
 * code. The same harness CI and the agent loop call, so a green local run is a green gate.
 * Runs locally (the deployed URL is not used); `defaultCwd` is the tool dir the CLI resolves.
 */
export function verifyTest(spec: TestSpec, defaultCwd: string): VerifyReport {
  const command = spec.command ?? 'pnpm test';
  const cwd = spec.cwd ?? defaultCwd;
  const where = `${command} (${cwd})`;
  try {
    const res = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: spec.timeoutMs ?? 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) {
      return report('test', where, [{ name: command, pass: false, detail: msg(res.error) }]);
    }
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const summary = summarize(out);
    const pass = res.status === 0;
    const detail = pass
      ? summary
      : `exit ${res.status ?? 'signal'}${summary ? ` — ${summary}` : ''}`;
    return report('test', where, [{ name: command, pass, detail }]);
  } catch (e) {
    return report('test', where, [{ name: command, pass: false, detail: msg(e) }]);
  }
}
