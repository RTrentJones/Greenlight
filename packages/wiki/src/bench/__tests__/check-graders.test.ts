import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkGraders, formatReport, materialize, passesMutantMessage } from '../check-graders';
import { GraderResultSchema } from '../grader-api';

// Vision 06 §4.3, 13 §2.7 "grader mutation checks", 13 §3 M1 pass criterion 1, 15 §8.3.

const here = dirname(new URL(import.meta.url).pathname);
const WEAK = join(here, 'fixtures/weak-bench');
const BENCH = resolve(here, '../../../../../bench');

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const w = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};

/** A copy of the weak bench, with the grader body replaced. */
function benchWithGrader(body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'check-graders-test-'));
  tmp.push(d);
  cpSync(WEAK, d, { recursive: true });
  w(join(d, 'graders/loop/weak-grader-train/grade.mjs'), body);
  return d;
}

const STRONG = `export default async (ctx) =>
  ctx.result([
    ctx.check('trajectory well-formed', ctx.trajectoryErrors.length === 0),
    ...ctx.evaluateTrajectory().map((r) => ctx.check(r.label, r.passed, r.detail)),
  ]);
`;

describe('check-graders on the committed weak grader', () => {
  it('reports the escaping mutant by id, in the 06 §4.3 wording', async () => {
    const r = await checkGraders({ benchDir: WEAK, timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.tasks[0]?.reference?.verdict).toBe('pass');
    expect(r.tasks[0]?.mutants.map((m) => [m.id, m.verdict])).toEqual([['push-first', 'pass']]);
    expect(r.problems).toEqual([
      passesMutantMessage(
        'loop/weak-grader-train',
        'push-first',
        'a push before the preview from a push after it',
      ),
    ]);
    expect(r.problems[0]).toBe(
      'grader loop/weak-grader-train passes mutant push-first: it cannot distinguish a push before the preview from a push after it',
    );
    expect(formatReport(r)).toMatch(/✘ grader loop\/weak-grader-train passes mutant push-first/);
  }, 60_000);

  it('passes once the grader evaluates the rules', async () => {
    const r = await checkGraders({ benchDir: benchWithGrader(STRONG), timeoutMs: 30_000 });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tasks[0]?.mutants[0]?.verdict).toBe('fail');
  }, 60_000);
});

describe('check-graders failure modes', () => {
  it('a grader that fails its reference is reported', async () => {
    const d = benchWithGrader(
      "export default async (ctx) => ctx.result([ctx.check('never passes', false, 'nope')]);\n",
    );
    const r = await checkGraders({ benchDir: d, timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(
      /^grader loop\/weak-grader-train fails its reference solution: never passes \(nope\)/,
    );
  }, 60_000);

  it('a hanging grader times out and is killed', async () => {
    const d = benchWithGrader(
      'export default () => new Promise(() => setInterval(() => {}, 1000));\n',
    );
    const r = await checkGraders({ benchDir: d, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.tasks[0]?.reference?.verdict).toBe('error');
    expect(r.tasks[0]?.reference?.error).toMatch(/timed out/);
  }, 60_000);

  it('an invalid grader result is an error, not a verdict', async () => {
    const d = benchWithGrader('export default async () => ({ passed: true, checks: [] });\n');
    const r = await checkGraders({ benchDir: d, timeoutMs: 30_000 });
    expect(r.tasks[0]?.reference?.verdict).toBe('error');
    expect(r.tasks[0]?.reference?.error).toMatch(/invalid result/);
  }, 60_000);

  it('a mutant on disk that task.json does not declare, or a declared one without files, is refused', async () => {
    const d = benchWithGrader(STRONG);
    w(join(d, 'mutants/loop/weak-grader-train/stray/trajectory.jsonl'), '');
    rmSync(join(d, 'mutants/loop/weak-grader-train/push-first'), { recursive: true });
    const r = await checkGraders({ benchDir: d, timeoutMs: 30_000 });
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/stray is not declared in task\.json/),
        expect.stringMatching(/mutant push-first has no files/),
      ]),
    );
  }, 60_000);

  it('refuses a pair whose overgeneral rule fails both tasks', async () => {
    const d = benchWithGrader(STRONG);
    // A second task with the same strong grader, and a pair rule that fails both.
    cpSync(join(d, 'tasks/loop/weak-grader-train'), join(d, 'tasks/loop/weak-grader-val'), {
      recursive: true,
    });
    const spec = JSON.parse(
      JSON.stringify({
        id: 'loop/weak-grader-val',
        kind: 'loop',
        graders: ['trajectory'],
        cell: '*/*/none',
        skills: ['deploy-verify-promote'],
        fidelity: 'runtime',
        split: 'val',
        state: 'pending',
        timeoutMin: 5,
        modes: ['isolation'],
        trajectory: {
          rules: [
            {
              rule: 'before',
              first: { cmd: 'greenlight', args: ['preview', 'demo'], meta: { passed: 'true' } },
              next: { cmd: 'git', args: ['push', 'origin', 'develop'] },
            },
          ],
        },
        mutants: [
          {
            id: 'push-first',
            grader: 'trajectory',
            kind: 'trajectory',
            description: 'a push before the preview from a push after it',
          },
        ],
      }),
    );
    w(join(d, 'tasks/loop/weak-grader-val/task.json'), JSON.stringify(spec));
    cpSync(join(d, 'graders/loop/weak-grader-train'), join(d, 'graders/loop/weak-grader-val'), {
      recursive: true,
    });
    cpSync(
      join(d, 'references/loop/weak-grader-train'),
      join(d, 'references/loop/weak-grader-val'),
      {
        recursive: true,
      },
    );
    cpSync(join(d, 'mutants/loop/weak-grader-train'), join(d, 'mutants/loop/weak-grader-val'), {
      recursive: true,
    });
    w(
      join(d, 'pairs/both/pair.json'),
      JSON.stringify({
        id: 'both',
        description: 'a rule that fails both tasks',
        tasks: ['loop/weak-grader-train', 'loop/weak-grader-val'],
        rules: [{ id: 'push-first', statement: 'push first', mustFail: 'loop/weak-grader-val' }],
      }),
    );
    const r = await checkGraders({ benchDir: d, timeoutMs: 30_000 });
    expect(r.pairs[0]?.rules[0]?.verdicts).toEqual({
      'loop/weak-grader-train': 'fail',
      'loop/weak-grader-val': 'fail',
    });
    expect(r.problems).toEqual([
      'pair both: overgeneral rule push-first ("push first") fails 2 of the paired tasks; it must fail exactly one',
    ]);
  }, 60_000);
});

describe('materialize', () => {
  it('applies tree, copy.json, remove.json and patch.diff layers over the fixture, in order', () => {
    const d = mkdtempSync(join(tmpdir(), 'materialize-test-'));
    tmp.push(d);
    w(join(d, 'tasks/loop/x-train/fixture/app.txt'), 'line one\nline two\n');
    w(join(d, 'tasks/loop/x-train/fixture/gone.txt'), 'bye\n');
    w(join(d, 'shared/lib.txt'), 'shared\n');
    const ref = join(d, 'references/loop/x-train');
    w(join(ref, 'tree/new.txt'), 'new\n');
    w(join(ref, 'copy.json'), JSON.stringify({ 'lib/lib.txt': 'shared/lib.txt' }));
    w(join(ref, 'remove.json'), JSON.stringify(['gone.txt']));
    const mut = join(d, 'mutants/loop/x-train/m');
    w(
      join(mut, 'patch.diff'),
      '--- a/app.txt\n+++ b/app.txt\n@@ -1,2 +1,2 @@\n line one\n-line two\n+line 2\n',
    );
    w(join(mut, 'trajectory.jsonl'), '');
    const task = {
      id: 'loop/x-train',
      dir: join(d, 'tasks/loop/x-train'),
      spec: { graders: ['trajectory'] } as never,
    };
    const out = materialize(d, task, [ref, mut], join(d, 'work'));
    const read = (p: string) => readFileSync(join(out.tree, p), 'utf8');
    expect(read('app.txt')).toBe('line one\nline 2\n');
    expect(read('new.txt')).toBe('new\n');
    expect(read('lib/lib.txt')).toBe('shared\n');
    expect(existsSync(join(out.tree, 'gone.txt'))).toBe(false);
    expect(out.trajectoryPath).toBe(join(mut, 'trajectory.jsonl'));
    expect(out.bundleDir).toBeUndefined();
    w(join(ref, 'remove.json'), JSON.stringify(['../../escape']));
    expect(() => materialize(d, task, [ref], join(d, 'work2'))).toThrow(/escapes/);
  });
});

describe('GraderResultSchema', () => {
  it('passed must agree with the checks, and a grader with no checks cannot pass', () => {
    const ok = (v: unknown) => GraderResultSchema.safeParse(v).success;
    expect(ok({ passed: true, checks: [{ name: 'a', passed: true }] })).toBe(true);
    expect(ok({ passed: false, checks: [{ name: 'a', passed: false, detail: 'x' }] })).toBe(true);
    expect(ok({ passed: true, checks: [{ name: 'a', passed: false }] })).toBe(false);
    expect(ok({ passed: true, checks: [] })).toBe(false);
    expect(ok({ passed: false, checks: [], extra: 1 })).toBe(false);
  });
});

describe('the first-iteration bench (13 §3 M1, criterion 1)', () => {
  it('every grader passes its reference and fails every mutant; each overgeneral rule fails exactly one of its pair', async () => {
    const r = await checkGraders({ benchDir: BENCH, timeoutMs: 60_000 });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tasks).toHaveLength(8);
    for (const t of r.tasks) {
      expect(t.reference?.verdict).toBe('pass');
      for (const m of t.mutants) expect(m.verdict, `${t.task} ${m.id}`).toBe('fail');
    }
    const verdicts = Object.fromEntries(
      r.pairs.flatMap((p) => p.rules.map((rule) => [`${p.id}:${rule.id}`, rule.verdicts])),
    );
    for (const split of ['train', 'val']) {
      // "every healthcheck queries the database" fails the Neon task only…
      expect(verdicts[`probe-layer-${split}:overgeneral-a`]).toEqual({
        [`replay/keepalive-probe-reaches-store-${split}`]: 'pass',
        [`replay/idle-probe-leaves-store-asleep-${split}`]: 'fail',
      });
      // …and "probes never touch the database" fails the Supabase task only.
      expect(verdicts[`probe-layer-${split}:overgeneral-b`]).toEqual({
        [`replay/keepalive-probe-reaches-store-${split}`]: 'fail',
        [`replay/idle-probe-leaves-store-asleep-${split}`]: 'pass',
      });
    }
  }, 240_000);
});
