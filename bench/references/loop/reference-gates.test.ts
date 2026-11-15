import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A loop task's reference trajectory is synthetic: it records `greenlight preview <tool>` as
 * passing, and `check-graders` grades that record without ever running it. On 2026-11-12 the val
 * fixture's preview descriptor (`path: '/pins'`) was prefixed onto every check path, so the gate
 * failed on the untouched fixture and the task could not be passed; check-graders stayed green.
 *
 * This test closes that gap by running the real gate: for every loop task, each preview the
 * reference trajectory claims passed must pass on the fixture with the reference tree overlaid,
 * and must also pass on the untouched fixture (the starting state the agent sees).
 *
 * The same holds for what the route family adds (`loop/new-route-joins-verify-*`): an
 * alternative that changes the tree (another spelling of the verify check) is claimed correct, so
 * the real gate must pass on it; and a mutant whose verify check "cannot hold" is rejected by the
 * grader's own small reading of an api check (GREEN_CHECK in trajectory-grader.mjs), so the real
 * gate must fail on it too, or the grader and the gate disagree about what a passing check is.
 */

const REPO = resolve(__dirname, '../../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const BIN = join(REPO, 'cli', 'src', 'bin.ts');
const TASKS = join(REPO, 'bench', 'tasks', 'loop');
const REFS = join(REPO, 'bench', 'references', 'loop');

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The tools whose preview the reference trajectory records as passing. */
function claimedPreviews(taskId: string): string[] {
  const lines = readFileSync(join(REFS, taskId, 'trajectory.jsonl'), 'utf8')
    .trim()
    .split('\n');
  const tools = new Set<string>();
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.cmd === 'greenlight' && e.meta?.subcommand === 'preview' && e.meta?.passed === 'true') {
      tools.add(e.meta.tool);
    }
  }
  return [...tools];
}

/** Copy the task fixture (and optionally the reference tree over it) into a fresh git repo. */
function tree(taskId: string, withReference: boolean, layer?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'loop-ref-gate-'));
  scratch.push(d);
  cpSync(join(TASKS, taskId, 'fixture'), d, { recursive: true });
  if (withReference) cpSync(join(REFS, taskId, 'tree'), d, { recursive: true });
  if (layer) cpSync(join(layer, 'tree'), d, { recursive: true });
  const git = (...a: string[]) =>
    spawnSync('git', ['-c', 'user.email=bench@test', '-c', 'user.name=bench', ...a], { cwd: d });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return d;
}

function preview(dir: string, tool: string) {
  const r = spawnSync(TSX, [BIN, 'preview', tool], { cwd: dir, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const tasks = readdirSync(TASKS).filter((t) => existsSync(join(REFS, t, 'trajectory.jsonl')));

const MUTANTS = join(REPO, 'bench', 'mutants', 'loop');
const GREEN_CHECK = 'the new check holds on what was pushed';
const dirs = (d: string) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)) : []);
/** Alternatives of a task that overlay files (not only another trajectory). */
const treeAlternatives = (taskId: string) =>
  dirs(join(REFS, taskId, 'alternatives')).filter((d) => existsSync(join(d, 'tree')));
/** Mutants that exist to trip GREEN_CHECK: a verify check the app as pushed does not satisfy. */
const redCheckMutants = (taskId: string) =>
  dirs(join(MUTANTS, taskId)).filter(
    (d) =>
      existsSync(join(d, 'tree')) &&
      JSON.parse(readFileSync(join(d, 'expect.json'), 'utf8')).failingChecks.includes(GREEN_CHECK),
  );

describe('loop reference trajectories match a real preview gate', () => {
  it('finds the loop tasks', () => {
    expect(tasks.length).toBeGreaterThan(0);
  });
  for (const taskId of tasks) {
    const tools = claimedPreviews(taskId);
    it(`${taskId}: the reference claims at least one passing preview`, () => {
      expect(tools.length).toBeGreaterThan(0);
    });
    for (const tool of tools) {
      it(`${taskId}: preview ${tool} passes on the reference tree`, () => {
        const r = preview(tree(taskId, true), tool);
        expect(r.code, r.out).toBe(0);
      }, 120_000);
      it(`${taskId}: preview ${tool} passes on the untouched fixture`, () => {
        const r = preview(tree(taskId, false), tool);
        expect(r.code, r.out).toBe(0);
      }, 120_000);
      for (const alt of treeAlternatives(taskId)) {
        it(`${taskId}: preview ${tool} passes on alternative ${alt.split('/').pop()}`, () => {
          const r = preview(tree(taskId, true, alt), tool);
          expect(r.code, r.out).toBe(0);
        }, 120_000);
      }
      for (const mutant of redCheckMutants(taskId)) {
        it(`${taskId}: preview ${tool} FAILS on mutant ${mutant.split('/').pop()}`, () => {
          const r = preview(tree(taskId, true, mutant), tool);
          expect(r.code, r.out).not.toBe(0);
        }, 120_000);
      }
    }
  }

  it('the route family brings tree alternatives and red-check mutants to this test', () => {
    for (const split of ['train', 'val']) {
      const id = `new-route-joins-verify-${split}`;
      expect(treeAlternatives(id).length, id).toBeGreaterThanOrEqual(2);
      expect(redCheckMutants(id).length, id).toBeGreaterThanOrEqual(2);
    }
  });
});
