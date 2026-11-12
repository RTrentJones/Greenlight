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
function tree(taskId: string, withReference: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'loop-ref-gate-'));
  scratch.push(d);
  cpSync(join(TASKS, taskId, 'fixture'), d, { recursive: true });
  if (withReference) cpSync(join(REFS, taskId, 'tree'), d, { recursive: true });
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
    }
  }
});
