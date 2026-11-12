import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadRepros } from '../../packages/wiki/src/bench/outlets';

/**
 * The trusted repro for the first iteration's likely doctor outlet (vision 06 §10.2, 07 DR-21).
 * It must fail on today's framework (no DR-21: the base of any DR-21 candidate) and must pass for
 * a doctor that flags exactly the store-touching probe and healthcheck, and nothing else.
 */

const REPO = resolve(__dirname, '../..');
const RUN = join(__dirname, 'probe-touches-wrong-layer', 'run.mjs');

const run = (tree: string) => {
  const r = spawnSync(process.execPath, [RUN, '--tree', tree], {
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 200_000,
  });
  const last = (r.stdout ?? '').trim().split('\n').at(-1) ?? '{}';
  return { code: r.status, out: r.stdout ?? '', summary: JSON.parse(last) };
};

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A stand-in framework tree whose `greenlight doctor` is `doctor` (the repro's real dependency
 * resolution: tsx from the tree's node_modules, the CLI at cli/src/bin.ts). */
function fakeTree(doctor: string): string {
  const d = mkdtempSync(join(tmpdir(), 'repro-fake-tree-'));
  scratch.push(d);
  symlinkSync(join(REPO, 'node_modules'), join(d, 'node_modules'));
  mkdirSync(join(d, 'cli', 'src'), { recursive: true });
  writeFileSync(join(d, 'cli', 'src', 'bin.ts'), doctor);
  return d;
}

const READS = `import { readFileSync } from 'node:fs';
const targets = JSON.parse(readFileSync('keepalive/targets.json', 'utf8'));
const compose = readFileSync('tools/ledgerline/compose.yaml', 'utf8');
console.log('✔ manifest: loaded & valid');
`;

/** A plausible DR-21: a needs-silence tool's probe or healthcheck may not hit readiness. */
const DR21 = `${READS}
const bad = [];
for (const t of targets) if (t.name === 'ledgerline' && t.probePath === '/health') bad.push('keepalive probe /health');
if (/\\/health['"\\s)]/.test(compose)) bad.push('compose healthcheck /health');
for (const b of bad) console.log('  ✘ ledgerline: liveness consistent (DR-21) — needs-silence, but ' + b + ' queries the store');
process.exit(bad.length ? 1 : 0);
`;

describe('repro/probe-touches-wrong-layer', () => {
  it('is a reviewed-format repro for the doctor outlet', () => {
    const r = loadRepros(join(REPO, 'bench')).repros.find(
      (x) => x.spec.id === 'repro/probe-touches-wrong-layer',
    );
    expect(r?.spec.outlets).toEqual(['doctor']);
    expect(r?.spec.patterns).toContain('pattern/probe-touches-wrong-layer');
  });

  it('FAILS on the current framework: doctor does not flag either faulty wrapper', () => {
    const r = run(REPO);
    expect(r.code).toBe(1);
    expect(r.summary.verdict).toBe('fail');
    const byName = Object.fromEntries(
      (r.summary.checks as { name: string; passed: boolean; detail: string }[]).map((c) => [
        c.name,
        c,
      ]),
    );
    expect(byName['faulty-probe: flagged']).toMatchObject({ passed: false });
    expect(byName['faulty-probe: flagged'].detail).toMatch(/no failure about ledgerline/);
    expect(byName['faulty-healthcheck: flagged']).toMatchObject({ passed: false });
    // The fixed wrapper is clean today, so the failure is the missing rule, not the fixture.
    expect(byName['fixed: not flagged']).toMatchObject({ passed: true });
  }, 200_000);

  it('passes for a doctor with a DR-21 that flags both faults and not the fix', () => {
    const r = run(fakeTree(DR21));
    expect(r.summary.verdict).toBe('pass');
    expect(r.code).toBe(0);
  }, 60_000);

  it('fails for a doctor that flags every probe, or catches only one fault', () => {
    const everything = `${READS}console.log('  ✘ ledgerline: probes are forbidden');process.exit(1);\n`;
    expect(run(fakeTree(everything)).code).toBe(1);
    const probeOnly = DR21.replace(/if \(\/.*compose healthcheck.*\n/, '');
    expect(probeOnly).not.toBe(DR21);
    expect(run(fakeTree(probeOnly)).code).toBe(1);
  }, 60_000);

  it('errors (exit 2) on a tree without installed dependencies', () => {
    const d = mkdtempSync(join(tmpdir(), 'repro-bare-tree-'));
    scratch.push(d);
    mkdirSync(join(d, 'cli', 'src'), { recursive: true });
    writeFileSync(join(d, 'cli', 'src', 'bin.ts'), '');
    expect(run(d).code).toBe(2);
  });
});
