import type { VerifyReport, VerifySpec } from '@rtrentjones/greenlight-verify';
import { describe, expect, it } from 'vitest';
import { attachFailureLogs } from '../commands/verify';

const fail = (logsOnFailure?: string): { report: VerifyReport; spec: VerifySpec } => ({
  report: { pass: false, mode: 'api', url: 'http://x', checks: [{ name: 'GET /', pass: false }] },
  spec: { mode: 'api', checks: [{ path: '/', status: 200 }], logsOnFailure },
});

describe('attachFailureLogs (telemetry-into-verify)', () => {
  it('runs logsOnFailure on a FAILED report and attaches the (bounded) output', () => {
    const { report, spec } = fail("printf 'boom-line\\n'");
    attachFailureLogs([report], [spec], process.cwd());
    expect(report.logs).toContain('boom-line');
  });

  it('does NOT run logsOnFailure for a passing report (no log fetch)', () => {
    const report: VerifyReport = { pass: true, mode: 'api', url: 'http://x', checks: [] };
    const spec: VerifySpec = {
      mode: 'api',
      checks: [],
      logsOnFailure: "echo 'should-not-run'",
    };
    attachFailureLogs([report], [spec], process.cwd());
    expect(report.logs).toBeUndefined();
  });

  it('marks a failed report whose spec set no logsOnFailure', () => {
    const { report, spec } = fail(undefined);
    attachFailureLogs([report], [spec], process.cwd());
    expect(report.logs).toBe('(no logsOnFailure configured for this spec)');
  });

  it('never throws when the command exits non-zero / is missing — still annotates', () => {
    const { report, spec } = fail('definitely-not-a-real-command-xyz 1>&2');
    expect(() => attachFailureLogs([report], [spec], process.cwd())).not.toThrow();
    expect(typeof report.logs).toBe('string'); // captured stderr or a marker, never undefined
  });

  it('bounds output to the last ~50 lines', () => {
    const { report, spec } = fail('for i in $(seq 1 200); do echo "line-$i"; done');
    attachFailureLogs([report], [spec], process.cwd());
    const lines = (report.logs ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(report.logs).toContain('line-200');
    expect(report.logs).not.toContain('line-100');
  });

  it('matches specs to reports by index', () => {
    const a = fail("echo 'logs-A'");
    const b = fail("echo 'logs-B'");
    attachFailureLogs([a.report, b.report], [a.spec, b.spec], process.cwd());
    expect(a.report.logs).toContain('logs-A');
    expect(b.report.logs).toContain('logs-B');
  });
});
