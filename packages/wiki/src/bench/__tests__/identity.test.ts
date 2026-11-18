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
  modelsConfigHashOf,
  processHostHash,
  sameIdentity,
  skillSetHashOf,
} from '../identity';
import { findCachedTrain, globToRegExp, resolveModels } from '../runner';

const REPO = resolve(__dirname, '../../../../..');
/** The frozen harness-driven config: these cases do not depend on the live bench/models.json. */
const HARNESS_MODELS_FILE = resolve(__dirname, '../../__tests__/fixtures/models-harness.json');
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A private copy of bench/ and the skills, so each case can change one input. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'greenlight-identity-'));
  temps.push(root);
  cpSync(join(REPO, 'bench'), join(root, 'bench'), { recursive: true });
  cpSync(HARNESS_MODELS_FILE, join(root, 'bench', 'models.json'));
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
// biome-ignore lint/suspicious/noExplicitAny: bench/models.json, edited as plain JSON
type ModelsJson = any;

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
      skills: ['deploy-verify-promote'],
    });
    expect(a.modelsConfigHash).toBe(modelsConfigHashOf(w.bench));
    expect(a.harness).not.toHaveProperty('processHost'); // a docker image pins itself
    expect(a.wikiSnapshotHash).toBeNull();
    expect(a.harness.runnerVersion).toBe('0.3.0');
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
    ...(
      [
        ['the temperature', (c) => ({ ...c, temperature: 0.7 })],
        ['the judge role', (c) => ({ ...c, roles: { ...c.roles, judge: 'frontier' } })],
        ['the provider', (c) => ({ ...c, provider: 'anthropic' })],
        [
          'a fallback setting',
          (c) => ({
            ...c,
            roles: { ...c.roles, frontier: { ...c.roles.frontier, fallback: c.roles.small.id } },
          }),
        ],
      ] as [string, (c: ModelsJson) => unknown][]
    ).map(([name, edit]): [string, (w: ReturnType<typeof world>) => unknown, string[]] => [
      `${name} in models.json`,
      (w) => {
        const f = join(w.bench, 'models.json');
        writeFileSync(f, JSON.stringify(edit(JSON.parse(readFileSync(f, 'utf8')))));
      },
      ['modelsConfigHash'],
    ]),
    [
      'which skills a task exercises (its slice, 06 §5.2)',
      (w) => {
        const f = join(w.bench, 'tasks', LOOP, 'task.json');
        const spec = JSON.parse(readFileSync(f, 'utf8'));
        writeFileSync(f, JSON.stringify({ ...spec, skills: ['provider-neon'] }));
      },
      ['taskSetHash', 'tasks'],
    ],
    [
      'the machine, in the process sandbox',
      () => ({ imageDigest: 'process', processHost: 'f'.repeat(64) }),
      ['harness'],
    ],
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

  it('rate limits and prices in models.json are not part of the identity', () => {
    const w = world();
    const before = computeIdentity(w.input());
    const f = join(w.bench, 'models.json');
    const c = JSON.parse(readFileSync(f, 'utf8'));
    c.roles.frontier.limits.rpd = 1;
    c.roles.small.priceUsdPerMTok = { input: 1, output: 2 };
    c.roles.proposer = 'small';
    writeFileSync(f, JSON.stringify(c));
    expect(identityDiff(before, computeIdentity(w.input()))).toEqual([]);
  });

  it('the process sandbox names its machine: `process` alone is equal everywhere', () => {
    const w = world();
    const here = computeIdentity(w.input({ imageDigest: 'process' }));
    expect(here.harness.imageDigest).toBe('process');
    expect(here.harness.processHost).toBe(processHostHash());
    const there = computeIdentity(w.input({ imageDigest: 'process', processHost: 'e'.repeat(64) }));
    expect(identityDiff(here, there)).toEqual(['harness']);
    expect(sameIdentity(here, there)).toBe(false);
  });

  it('an identity written before a field existed never compares equal to one that has it', () => {
    const w = world();
    const now = computeIdentity(w.input());
    const { modelsConfigHash: _m, ...old } = now;
    expect(identityDiff(old, now)).toEqual(['modelsConfigHash']);
    expect(identityDiff(now, old)).toEqual(['modelsConfigHash']);
    expect(sameIdentity(old, now)).toBe(false);
  });

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
    const config = JSON.parse(readFileSync(HARNESS_MODELS_FILE, 'utf8'));
    const { frontier, small } = config.roles;
    expect(resolveModels(config, ['small', 'frontier'])).toEqual([frontier.id, small.id]);
    expect(resolveModels(config, [small.id])).toEqual([small.id]);
    expect(() => resolveModels(config, ['nope'])).toThrow(/unknown model/);
  });
});
