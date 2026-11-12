import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type LoadedTask,
  PairSpecSchema,
  loadTasks,
  materialize,
  runInChild,
} from '../../packages/wiki/src/bench/check-graders';
import { loadControlArm } from '../../packages/wiki/src/bench/outlets';
import { resolveId } from '../../packages/wiki/src/ids';
import { loadWiki } from '../../packages/wiki/src/load';
import { applyFilePatches } from '../../packages/wiki/src/patch';
import { ProposerOutputSchema, touchesVersion } from '../../packages/wiki/src/schema/io';

/**
 * The M2-03 control arm (vision 06 §10.2 step 4): a hand-written overgeneral skill patch. It must
 * be a proposal the harness would accept as well-formed (the checkProposal rules), and it must be
 * wrong for the right reason: an app built by its rule fails the Neon val replay. Graded here with
 * the existing graders directly, no LLM.
 */

const REPO = resolve(__dirname, '../..');
const BENCH = join(REPO, 'bench');
const SKILLS = join(REPO, '.claude', 'skills');
const arm = loadControlArm(join(__dirname, 'probe-layer-overgeneral.json'));
const p = arm.proposal;

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

describe('control arm: probe-layer-overgeneral', () => {
  it('is labelled control and is a valid skill patch', () => {
    expect(arm.control).toBe(true);
    expect(ProposerOutputSchema.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ action: 'patch', outlet: 'skill' });
    expect(touchesVersion(p)).toBe(false);
  });

  it('passes the checkProposal containment rules and applies cleanly to its skill', () => {
    if (p.action !== 'patch') throw new Error('not a patch');
    const root = resolve(SKILLS, p.name);
    expect(inside(SKILLS, root)).toBe(true);
    expect(inside(realpathSync(SKILLS), realpathSync(root))).toBe(true);
    const applied = applyFilePatches(root, p.edits);
    if (!applied.ok) throw new Error(applied.errors.join('; '));
    const skill = applied.changeset.writes.find((w) => w.path === 'SKILL.md')?.content ?? '';
    expect(skill).toContain('must always query the database');
    // The patch adds exactly the overgeneral rule; nothing else in the skill changes.
    const before = readFileSync(join(root, 'SKILL.md'), 'utf8');
    expect(skill.length).toBeGreaterThan(before.length);
    expect(skill.replace(p.edits[0]?.text ?? '', '')).toBe(before);
  });

  it('cites probe-layer patterns that exist in the framework wiki', () => {
    if (p.action === 'no_action') throw new Error('no patterns');
    const wiki = loadWiki(join(REPO, 'wiki'));
    for (const id of p.patterns) expect(resolveId(wiki, id), id).toBeDefined();
    expect(p.patterns).toContain('pattern/probe-touches-wrong-layer');
  });

  it('targets a skill loaded by both paired val replays, and names the pair rule it encodes', () => {
    if (p.action !== 'patch') throw new Error('not a patch');
    const pair = PairSpecSchema.parse(
      JSON.parse(readFileSync(join(BENCH, 'pairs', arm.pair.id, 'pair.json'), 'utf8')),
    );
    const rule = pair.rules.find((r) => r.id === arm.pair.rule);
    expect(rule?.mustFail).toBe(arm.expect.task);
    const { tasks } = loadTasks(BENCH);
    for (const tid of pair.tasks) {
      const t = tasks.find((x) => x.id === tid);
      expect(t?.spec.skills, tid).toContain(p.name);
    }
  });
});

describe('control arm: wrong for the right reason (graded, no LLM)', () => {
  const work = mkdtempSync(join(tmpdir(), 'control-arm-grade-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const { tasks } = loadTasks(BENCH);
  const task = (id: string) => tasks.find((t) => t.id === id) as LoadedTask;
  let n = 0;
  const grade = (id: string, layers: string[]) => {
    const t = task(id);
    const paths = materialize(BENCH, t, layers, join(work, String(n++)));
    return runInChild(
      {
        taskId: id,
        benchDir: BENCH,
        graderPath: join(BENCH, 'graders', id, 'grade.mjs'),
        ...paths,
      },
      90_000,
    );
  };

  it(`a reference solution following the control's rule fails ${arm.expect.task}`, async () => {
    const id = arm.expect.task;
    const reference = join(BENCH, 'references', id);
    // The rule as an app: the reference solution with a liveness route that runs SELECT 1 (the
    // task's overgeneral-a mutant, which is the pair rule's tree for this task).
    const ruleTree = join(BENCH, 'mutants', id, arm.pair.rule);
    const expected = JSON.parse(readFileSync(join(ruleTree, 'expect.json'), 'utf8'))
      .failingChecks as string[];
    const [ref, rule] = await Promise.all([
      grade(id, [reference]),
      grade(id, [reference, ruleTree]),
    ]);
    expect(ref.verdict).toBe('pass');
    expect(rule.verdict).toBe('fail');
    const failed = rule.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed.some((f) => expected.includes(f))).toBe(true);
    expect(failed).toContain('zero store queries from the healthcheck');
  }, 120_000);

  it('and is plausible: the same rule passes the Supabase val replay', async () => {
    const id = 'replay/keepalive-probe-reaches-store-val';
    const layer = join(BENCH, 'pairs', arm.pair.id, arm.pair.rule, id);
    const r = await grade(id, [join(BENCH, 'references', id), layer]);
    expect(r.verdict).toBe('pass');
  }, 120_000);
});
