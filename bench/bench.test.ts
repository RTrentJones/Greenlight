import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RawRecordSchema } from '../packages/shared/src/evidence';
import { loadTasks } from '../packages/wiki/src/bench/check-graders';
import { checkFixtures } from './fixtures/sync.mjs';
import { applyOps, blocks, overgeneral, refsIn } from './graders/_lib/maintainer.mjs';
import { parseCmd, parseHealthcheck } from './graders/_lib/neon-idle.mjs';

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
    expect(parseCmd('CMD node src/app.mjs\n')).toBeNull();
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
