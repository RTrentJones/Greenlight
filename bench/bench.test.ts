import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RawRecordSchema } from '../packages/shared/src/evidence';
import { loadTasks, materialize } from '../packages/wiki/src/bench/check-graders';
import { runGraderJob } from '../packages/wiki/src/bench/grader-api';
import { checkFixtures } from './fixtures/sync.mjs';
import { applyOps, blocks, overgeneral, refsIn } from './graders/_lib/maintainer.mjs';
import { parseCmd, parseHealthcheck } from './graders/_lib/neon-idle.mjs';
import { CHANGE_CHECK } from './graders/_lib/trajectory-grader.mjs';
import { unwrapRunner } from './runner/record.mjs';

// Bench layout invariants (vision 08 §10.1, 06 §1.4, bench/README.md).

const BENCH = __dirname;
const { tasks, problems } = loadTasks(BENCH);

describe('bench tasks', () => {
  it('every task.json validates against TaskSpecSchema and sits at tasks/<id>/', () => {
    expect(problems).toEqual([]);
    expect(tasks.map((t) => t.id).sort()).toEqual([
      'loop/fixture-preview-before-push-train',
      'loop/fixture-preview-before-push-val',
      'replay/idle-probe-leaves-store-asleep-train',
      'replay/idle-probe-leaves-store-asleep-val',
      'replay/keepalive-probe-reaches-store-train',
      'replay/keepalive-probe-reaches-store-val',
      'wiki/probe-layer-incidents-train',
      'wiki/probe-layer-incidents-val',
    ]);
  });

  it('the id suffix names the split, and splits.json agrees with every task.json', () => {
    const splits = JSON.parse(readFileSync(join(BENCH, 'splits.json'), 'utf8'));
    expect(Object.keys(splits).sort()).toEqual(tasks.map((t) => t.id).sort());
    for (const t of tasks) {
      expect(t.id.endsWith(`-${t.spec.split}`)).toBe(true);
      expect(splits[t.id]).toBe(t.spec.split);
    }
  });

  it('every task family has one train and one val variant', () => {
    const families = new Map<string, string[]>();
    for (const t of tasks) {
      const family = t.id.replace(/-(train|val|test)$/, '');
      families.set(family, [...(families.get(family) ?? []), t.spec.split].sort());
    }
    for (const splits of families.values()) expect(splits).toEqual(['train', 'val']);
  });

  it('task folders hold only task.json, brief.md and fixture/ (graders stay outside, 06 §1.4)', () => {
    for (const t of tasks) {
      expect(readdirSync(t.dir).sort()).toEqual(['brief.md', 'fixture', 'task.json']);
    }
  });

  it('no task fixture or brief names a val task id', () => {
    const val = tasks.filter((t) => t.spec.split !== 'train').map((t) => t.id);
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    for (const t of tasks) {
      for (const f of [...walk(join(t.dir, 'fixture')), join(t.dir, 'brief.md')]) {
        const text = readFileSync(f, 'utf8');
        for (const id of val) expect(text.includes(id), `${f} names ${id}`).toBe(false);
      }
    }
  });

  it('task fixtures are byte-identical to their fixture variants (bench/fixtures/sync.mjs)', () => {
    expect(checkFixtures()).toEqual([]);
  });

  it('the maintainer bundles carry valid train raw records', () => {
    for (const split of ['train', 'val']) {
      const dir = join(BENCH, `tasks/wiki/probe-layer-incidents-${split}/fixture/raw`);
      for (const f of readdirSync(dir)) {
        const rec = RawRecordSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
        expect(rec.bench?.split).toBe('train');
        expect(f).toBe(`${rec.rawId}.json`);
      }
    }
  });
});

describe('grader helpers', () => {
  it('parses Dockerfile healthchecks in exec, shell and continued forms', () => {
    expect(
      parseHealthcheck(
        'HEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1\n',
      ),
    ).toMatchObject({ path: '/health/live', intervalMs: 30_000 });
    expect(
      parseHealthcheck(
        'HEALTHCHECK --interval=20s \\\n  CMD node -e "fetch(\'http://127.0.0.1:3000/health/live\')"\n',
      ),
    ).toMatchObject({ path: '/health/live', intervalMs: 20_000 });
    expect(parseHealthcheck('HEALTHCHECK NONE\n')).toBeNull();
    expect(parseHealthcheck('FROM node\n')).toBeNull();
    expect(
      parseHealthcheck(
        'FROM node\n',
        'services:\n  a:\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost:8080/live"]\n      interval: 10s\n',
      ),
    ).toMatchObject({ path: '/live', intervalMs: 10_000 });
    expect(parseCmd('CMD ["node", "src/app.mjs"]\n')).toEqual(['node', 'src/app.mjs']);
    // Shell form runs under /bin/sh -c, as Docker runs it.
    expect(parseCmd('CMD node src/app.mjs\n')).toEqual(['/bin/sh', '-c', 'node src/app.mjs']);
    expect(parseCmd('FROM node\n')).toBeNull();
    // An exec-form HEALTHCHECK on a continuation line is not the app command; the last CMD wins.
    const two =
      'FROM node\nHEALTHCHECK --interval=30s \\\n  CMD ["wget", "-qO-", "http://localhost:3000/live"]\nCMD ["node", "src/app.mjs"]\n';
    expect(parseCmd(two)).toEqual(['node', 'src/app.mjs']);
    expect(parseHealthcheck(two)).toMatchObject({ path: '/live', intervalMs: 30_000 });
    expect(parseCmd('CMD ["node", "a.mjs"]\nCMD ["node", "b.mjs"]\n')).toEqual(['node', 'b.mjs']);
    expect(parseCmd('HEALTHCHECK CMD ["curl", "-f", "http://localhost/"]\n')).toBeNull();
  });

  it('reads the healthcheck path through a port expression, and fails on one it cannot read', () => {
    const path = (cmd: string) => parseHealthcheck(`HEALTHCHECK CMD ${cmd}\n`)?.path;
    expect(path('curl -f http://localhost:$PORT/health/live')).toBe('/health/live');
    expect(path('curl -f http://127.0.0.1:${PORT:-3000}/health/live')).toBe('/health/live');
    expect(path("node -e \"fetch('http://localhost:' + process.env.PORT + '/health/live')\"")).toBe(
      '/health/live',
    );
    expect(path('node -e "fetch(`http://localhost:${process.env.PORT}/live`)"')).toBe('/live');
    expect(path('wget -qO- http://[::1]:8080/live')).toBe('/live');
    expect(path('curl -f http://localhost:3000')).toBe('/');
    // Unreadable port: never a silent fallback to "/".
    expect(path('wget -qO- "http://127.0.0.1:$(printenv PORT)/health"')).toBeNull();
    expect(path('node -e "fetch(\'http://localhost:\' + port)"')).toBeNull();
    expect(path('node healthcheck.js')).toBeNull();
  });

  it('applies patch ops with exactly-once targets', () => {
    expect(applyOps('a\nb\n', [{ op: 'insert_after', target: 'a\n', text: 'x\n' }])).toBe(
      'a\nx\nb\n',
    );
    expect(applyOps('a b', [{ op: 'replace', target: 'b', text: 'c' }])).toBe('a c');
    expect(() => applyOps('a a', [{ op: 'replace', target: 'a', text: 'c' }])).toThrow(/2 times/);
    expect(() => applyOps('a', [{ op: 'replace', target: 'z', text: 'c' }])).toThrow(/0 times/);
  });

  it('splits claims into paragraphs and list items', () => {
    expect(blocks('## H\nLead in:\n\n- one\n  cont\n- two\n\n```\ncode\n```\npara')).toEqual([
      'Lead in:',
      'one cont',
      'two',
      'para',
    ]);
  });

  it('extracts evidence refs', () => {
    expect([...refsIn('see issue:o/r#5, commit:o/r@abcdef1. and post:https://x.test/a/.')]).toEqual(
      ['issue:o/r#5', 'commit:o/r@abcdef1', 'post:https://x.test/a/'],
    );
  });

  it('flags overgeneral rules only when no liveness model conditions them', () => {
    expect(overgeneral('Every healthcheck must query the database.')).toBe('A');
    expect(overgeneral('Probes must never touch the database.')).toBe('B');
    expect(overgeneral('For `needs-silence`, probes never touch the database.')).toBeNull();
    expect(overgeneral('For `needs-traffic`, every keepalive queries the store.')).toBeNull();
    expect(overgeneral('Split liveness from readiness.')).toBeNull();
  });
});

describe('task prerequisites', () => {
  it('every skill a task declares exists (a missing one used to be dropped silently)', () => {
    const skills = join(BENCH, '..', '.claude', 'skills');
    const missing = tasks.flatMap((t) =>
      t.spec.skills
        .filter((s) => !existsSync(join(skills, s, 'SKILL.md')))
        .map((s) => `${t.id}: ${s}`),
    );
    expect(missing).toEqual([]);
  });

  it('a loop fixture shows where beta is, the way a real wrapper does', () => {
    for (const t of tasks.filter((x) => x.spec.kind === 'loop')) {
      const wf = readFileSync(join(t.dir, 'fixture/.github/workflows/deploy.yml'), 'utf8');
      expect(wf, t.id).toMatch(/branches: \[develop, main\]/);
      expect(wf, t.id).toMatch(/develop -> beta/);
      expect(readFileSync(join(t.dir, 'fixture/README.md'), 'utf8'), t.id).toMatch(
        /`develop` \| beta/,
      );
      // The brief stays terse: the destination is in the repository, not in the task text.
      expect(readFileSync(join(t.dir, 'brief.md'), 'utf8'), t.id).not.toMatch(/develop/);
    }
  });
});

describe('the loop grader checks what was pushed, not only the order', () => {
  const TASK = 'loop/fixture-preview-before-push-val';
  const task = tasks.find((t) => t.id === TASK);
  if (!task) throw new Error(`no task ${TASK}`);
  const FILE = 'tools/pinboard/app.mjs';
  const grade = async (o: {
    pushed?: 'changed' | 'unchanged' | 'none';
    tree: 'changed' | 'unchanged';
  }) => {
    const work = mkdtempSync(join(tmpdir(), 'loop-tree-check-'));
    try {
      const ref = join(BENCH, 'references', TASK);
      const job = materialize(BENCH, task, o.tree === 'changed' ? [ref] : [], join(work, 'w'));
      const fixture = materialize(BENCH, task, [], join(work, 'f')).tree;
      const changed = materialize(BENCH, task, [ref], join(work, 'c')).tree;
      const r = await runGraderJob({
        taskId: TASK,
        benchDir: BENCH,
        graderPath: join(BENCH, 'graders', TASK, 'grade.mjs'),
        tree: job.tree,
        trajectoryPath: join(ref, 'trajectory.jsonl'),
        ...(o.pushed ? { pushedKnown: true } : {}),
        ...(o.pushed === 'changed' ? { pushedTree: changed } : {}),
        ...(o.pushed === 'unchanged' ? { pushedTree: fixture } : {}),
      });
      return { passed: r.passed, check: r.checks.find((c) => c.name === CHANGE_CHECK) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  it('a reference trajectory over the UNTOUCHED tree fails (it used to pass)', async () => {
    const r = await grade({ tree: 'unchanged' });
    expect(r.passed).toBe(false);
    expect(r.check).toMatchObject({ passed: false });
    expect((await grade({ tree: 'changed' })).passed).toBe(true);
  });

  it('in a real rollout the PUSHED branch decides, whatever the working tree holds', async () => {
    // The change made, previewed, but an empty commit pushed.
    const empty = await grade({ tree: 'changed', pushed: 'unchanged' });
    expect(empty.passed).toBe(false);
    expect(empty.check?.detail).toMatch(
      new RegExp(`${FILE} in the pushed branch does not contain`),
    );
    expect((await grade({ tree: 'changed', pushed: 'none' })).check).toMatchObject({
      passed: false,
      detail: 'nothing was pushed to the target branch',
    });
    expect((await grade({ tree: 'changed', pushed: 'changed' })).passed).toBe(true);
  });
});

describe('the pnpm / npx shims (bench/runner/record.mjs)', () => {
  it('pass a greenlight command through, with what the trajectory normalizer accepts', () => {
    const through: [string, string[]][] = [
      ['pnpm', ['greenlight', 'preview', 'pinboard']],
      ['pnpm', ['exec', 'greenlight', 'preview', 'pinboard']],
      ['pnpm', ['run', 'greenlight', 'preview', 'pinboard']],
      ['pnpm', ['run', 'greenlight', '--', 'preview', 'pinboard']],
      ['pnpm', ['--silent', 'greenlight', 'preview', 'pinboard']],
      ['pnpm', ['--filter', 'pinboard', 'exec', 'greenlight', 'preview', 'pinboard']],
      ['pnpm', ['dlx', '@rtrentjones/greenlight', 'preview', 'pinboard']],
      ['npx', ['greenlight', 'preview', 'pinboard']],
      ['npx', ['--yes', '@rtrentjones/greenlight@latest', 'preview', 'pinboard']],
      ['npx', ['--package', '@rtrentjones/greenlight', 'greenlight', 'preview', 'pinboard']],
    ];
    for (const [cmd, argv] of through)
      expect(unwrapRunner(cmd, argv), `${cmd} ${argv.join(' ')}`).toEqual(['preview', 'pinboard']);
  });

  it('refuse everything else (fail fast instead of a registry lookup that hangs)', () => {
    for (const [cmd, argv] of [
      ['pnpm', ['install']],
      ['pnpm', ['test']],
      ['pnpm', []],
      ['npx', ['cowsay', 'hi']],
      ['npx', ['-c', 'greenlight preview pinboard']],
      ['npx', ['greenlight-evil', 'preview']],
      ['git', ['greenlight']],
    ] as [string, string[]][])
      expect(unwrapRunner(cmd, argv), `${cmd} ${argv.join(' ')}`).toBeNull();
  });
});

describe('the runner image builds from scratch on any day', () => {
  const dockerfile = readFileSync(join(BENCH, 'runner/Dockerfile'), 'utf8');

  it('pins the base image by digest and no apk package by version', () => {
    expect(dockerfile).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m);
    const add = dockerfile.replace(/\\\n/g, ' ').match(/apk add[^\n]*/g) ?? [];
    expect(add.length).toBeGreaterThan(0);
    // `git=2.54.0-r0` broke every uncached build the day Alpine shipped 2.54.1 (2026-11-15).
    for (const line of add) expect(line).not.toMatch(/\s[\w.+-]+=[\w.+-]+/);
  });

  it('does not export an empty https_proxy when the build has no proxy', () => {
    expect(dockerfile).not.toMatch(/https_proxy="\$HTTPS_PROXY" apk/);
    expect(dockerfile).toMatch(/if \[ -n "\$HTTPS_PROXY" \]; then export https_proxy=/);
  });
});
