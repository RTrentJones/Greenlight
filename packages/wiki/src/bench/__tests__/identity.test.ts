import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { identityDiff, sealRecord } from '../../schema/bench';
import { loadTasks } from '../check-graders';
import {
  type IdentityInput,
  computeIdentity,
  depsHash,
  hashTree,
  sameIdentity,
  skillSetHashOf,
} from '../identity';
import { findCachedTrain, globToRegExp, resolveModels } from '../runner';

const REPO = resolve(__dirname, '../../../../..');
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A private copy of bench/ and the skills, so each case can change one input. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'greenlight-identity-'));
  temps.push(root);
  cpSync(join(REPO, 'bench'), join(root, 'bench'), { recursive: true });
  cpSync(join(REPO, '.claude', 'skills'), join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'lock.yaml'), 'lockfileVersion: 9\n');
  const input = (over: Partial<IdentityInput> = {}): IdentityInput => {
    const tasks = loadTasks(join(root, 'bench')).tasks.filter((t) => t.spec.split === 'train');
    return {
      benchDir: join(root, 'bench'),
      tasks: tasks.map((t) => t.spec),
      skillsDir: join(root, 'skills'),
      lockfile: join(root, 'lock.yaml'),
      greenlightVersion: '0.10.1',
      cliBuildHash: 'a'.repeat(64),
      imageDigest: 'sha256:abc',
      agent: { vendor: 'greenlight-harness', version: '0.1.0' },
      models: ['gemini-3.8-flash', 'gemini-3.6-flash'],
      mode: 'isolation',
      limits: { maxSteps: 15, requestsPerRollout: 17, timeoutMin: null },
      ...over,
    };
  };
  return { root, bench: join(root, 'bench'), input };
}

const LOOP = 'loop/fixture-preview-before-push-train';

describe('BaselineIdentity (06 §1.5, 08 §10.3)', () => {
  it('is deterministic and carries the sorted task summary', () => {
    const w = world();
    const a = computeIdentity(w.input());
    const b = computeIdentity(w.input());
    expect(sameIdentity(a, b)).toBe(true);
    expect(a.tasks.map((t) => t.id)).toEqual([...a.tasks.map((t) => t.id)].sort());
    expect(a.tasks.find((t) => t.id === LOOP)).toEqual({
      id: LOOP,
      kind: 'loop',
      state: 'pending',
      modes: ['isolation', 'production'],
      graders: ['trajectory'],
    });
    expect(a.wikiSnapshotHash).toBeNull();
    expect(a.harness.runnerVersion).toBe('0.2.1');
    expect(a.harness.limits).toEqual({ maxSteps: 15, requestsPerRollout: 17, timeoutMin: null });
  });

  // 13 §2.7 "baseline invalidation": each input changes the identity, in the field that names it.
  const cases: [string, (w: ReturnType<typeof world>) => unknown, string[]][] = [
    [
      'a task brief',
      (w) => appendFileSync(join(w.bench, 'tasks', LOOP, 'brief.md'), 'x'),
      ['taskSetHash'],
    ],
    [
      'a fixture file',
      (w) => writeFileSync(join(w.bench, 'tasks', LOOP, 'fixture', 'new.txt'), 'x'),
      ['taskSetHash'],
    ],
    [
      'a task state (a gate cannot quarantine a task unseen)',
      (w) => {
        const f = join(w.bench, 'tasks', LOOP, 'task.json');
        writeFileSync(f, readFileSync(f, 'utf8').replace('"pending"', '"active"'));
      },
      ['taskSetHash', 'tasks', 'splitsHash'],
    ],
    [
      'a split assignment',
      (w) => {
        const f = join(w.bench, 'splits.json');
        const s = JSON.parse(readFileSync(f, 'utf8'));
        s['wiki/probe-layer-incidents-val'] = 'test';
        writeFileSync(f, JSON.stringify(s));
      },
      ['splitsHash'],
    ],
    [
      'a grader',
      (w) => appendFileSync(join(w.bench, 'graders', LOOP, 'grade.mjs'), '\n//'),
      ['graderSetHash'],
    ],
    [
      'a shared grader implementation',
      (w) => appendFileSync(join(w.bench, 'graders', '_lib', 'trajectory-grader.mjs'), '\n//'),
      ['graderSetHash'],
    ],
    [
      'a mutant',
      (w) => appendFileSync(join(w.bench, 'mutants', LOOP, 'never-pushed', 'expect.json'), ' '),
      ['graderSetHash'],
    ],
    ['the runner lockfile', (w) => appendFileSync(join(w.root, 'lock.yaml'), '#'), ['depsHash']],
    ['the CLI build', () => ({ cliBuildHash: 'b'.repeat(64) }), ['depsHash']],
    ['the sandbox image digest', () => ({ imageDigest: 'sha256:def' }), ['harness']],
    [
      'the max steps (a 10-step run says nothing about a 20-step one)',
      () => ({ limits: { maxSteps: 20, requestsPerRollout: 17, timeoutMin: null } }),
      ['harness'],
    ],
    [
      'the per-rollout request cap',
      () => ({ limits: { maxSteps: 15, requestsPerRollout: 30, timeoutMin: null } }),
      ['harness'],
    ],
    [
      'the rollout timeout',
      () => ({ limits: { maxSteps: 15, requestsPerRollout: 17, timeoutMin: 5 } }),
      ['harness'],
    ],
    [
      'the agent version',
      () => ({ agent: { vendor: 'greenlight-harness', version: '0.2.0' } }),
      ['agent'],
    ],
    ['the model list', () => ({ models: ['gemini-3.6-flash'] }), ['models']],
    ['the proxy policy', () => ({ proxyPolicyHash: 'c'.repeat(64) }), ['proxyPolicyHash']],
    [
      'a skill file',
      (w) => appendFileSync(join(w.root, 'skills', 'provider-neon', 'SKILL.md'), 'x'),
      ['skillSetHash'],
    ],
    [
      'a skill sidecar',
      (w) => writeFileSync(join(w.root, 'skills', 'provider-neon', 'PURPOSE.md'), '# Why'),
      ['skillSetHash'],
    ],
  ];
  it.each(cases)(
    'changing %s changes the identity and misses the train cache',
    (_, change, fields) => {
      const w = world();
      const before = computeIdentity(w.input());
      const over = (change(w) ?? {}) as Partial<IdentityInput>;
      const after = computeIdentity(w.input(over));
      expect(identityDiff(before, after).sort()).toEqual([...fields].sort());
      const cached = sealRecord({
        identity: before,
        role: 'train',
        createdAt: new Date().toISOString(),
        outcomes: [],
      });
      expect(findCachedTrain([cached], after, [])).toBeUndefined();
      expect(findCachedTrain([cached], before, [])?.hash).toBe(cached.hash);
    },
  );

  it('a file outside SKILL.md/PURPOSE.md is not part of the skill set', () => {
    const w = world();
    const h = skillSetHashOf(join(w.root, 'skills'));
    writeFileSync(join(w.root, 'skills', 'provider-neon', 'notes.txt'), 'x');
    expect(skillSetHashOf(join(w.root, 'skills'))).toBe(h);
  });

  it('a cached record must cover every requested rollout', () => {
    const w = world();
    const id = computeIdentity(w.input());
    const rec = sealRecord({
      identity: id,
      role: 'train',
      createdAt: new Date().toISOString(),
      outcomes: [
        {
          task: LOOP,
          run: 1,
          model: 'gemini-3.6-flash',
          mode: 'isolation',
          score: 1,
          graders: [{ kind: 'trajectory', passed: true }],
          seed: '1',
          rawId: '20261101T000000Z-00000000',
          durationMs: 1,
          servedBy: 'gemini-3.6-flash',
          cost: { usd: 0, requests: 1, tokensIn: 1, tokensOut: 1 },
        },
      ],
    });
    expect(findCachedTrain([rec], id, [`${LOOP}|gemini-3.6-flash|1`])).toBeDefined();
    expect(findCachedTrain([rec], id, [`${LOOP}|gemini-3.6-flash|2`])).toBeUndefined();
    expect(findCachedTrain([{ ...rec, role: 'baseline' }], id, [])).toBeUndefined();
  });

  it('hashTree sees content, names and symlinks; depsHash pins the version', () => {
    const d = mkdtempSync(join(tmpdir(), 'greenlight-tree-'));
    temps.push(d);
    writeFileSync(join(d, 'a'), '1');
    const h1 = hashTree(d);
    writeFileSync(join(d, 'a'), '2');
    expect(hashTree(d)).not.toBe(h1);
    expect(hashTree(join(d, 'missing'))).not.toBe(hashTree(d));
    const deps = (v: string) =>
      depsHash({ lockfile: join(d, 'a'), greenlightVersion: v, cliBuildHash: 'x' });
    expect(deps('1.0.0')).not.toBe(deps('1.0.1'));
  });
});

describe('selection helpers', () => {
  it('globs match within and across segments', () => {
    expect(globToRegExp('loop/*').test(LOOP)).toBe(true);
    expect(globToRegExp('*').test(LOOP)).toBe(false);
    expect(globToRegExp('**').test(LOOP)).toBe(true);
    expect(globToRegExp('replay/*-train').test('replay/x-train')).toBe(true);
  });
  it('model roles and ids resolve in models.json order', () => {
    const config = JSON.parse(readFileSync(join(REPO, 'bench', 'models.json'), 'utf8'));
    expect(resolveModels(config, ['small', 'frontier'])).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(resolveModels(config, ['gemini-3.6-flash'])).toEqual(['gemini-3.6-flash']);
    expect(() => resolveModels(config, ['nope'])).toThrow(/unknown model/);
  });
});
