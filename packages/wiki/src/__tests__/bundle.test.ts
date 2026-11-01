import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BundleLeakError,
  BundleSecretError,
  MAINTAINER_PROMPT,
  PROPOSER_PROMPT,
  buildMaintainerBundle,
  buildProposerBundle,
  checkProposal,
  listTraces,
  loadRawStore,
  readTarget,
  recordAccess,
  writeBundle,
} from '../bundle';
import { renderSkillImpact } from '../ledger';
import { loadWiki, withWrites } from '../load';
import { canonicalJson, sealEvent } from '../schema';
import { rec, writeRaw } from './raw-fixtures';

const SEED = resolve(__dirname, '../../../../wiki');
const VAL_TASK = 'replay/held-out-task-val';
const TEST_TASK = 'replay/held-out-task-test';
const SPLITS_VAL = 'loop/held-out-loop-val';

const train1 = rec({ id: 'aaaa0001', split: 'train', task: 'replay/fixture-task-train' });
const train2 = rec({
  id: 'aaaa0002',
  split: 'train',
  task: 'replay/fixture-task-train',
  passed: true,
});
const field1 = rec({ id: 'aaaa0003', skill: { name: 'deploy-verify-promote', version: '2' } });
const valRec = rec({ id: 'bbbb0001', split: 'val', task: VAL_TASK });
const testRec = rec({ id: 'bbbb0002', split: 'test', task: TEST_TASK });
const records = [train1, train2, field1, valRec, testRec];

const CONTEXT = { installed: '0.10.1', cells: ['mcp/oci/none'], verifyCheckIds: [], skills: {} };

function allText(files: Map<string, string>): string {
  return [...files].map(([p, t]) => `${p}\n${t}`).join('\n');
}

function heldOutAbsent(files: Map<string, string>) {
  const text = allText(files);
  for (const t of [valRec.rawId, testRec.rawId, VAL_TASK, TEST_TASK, SPLITS_VAL]) {
    expect(text).not.toContain(t);
  }
  for (const p of ['bench/graders', 'bench/mutants', 'bench/references', 'bench/tasks']) {
    expect(text).not.toContain(p);
  }
}

describe('maintainer bundle (06 §2.1)', () => {
  const wiki = loadWiki(SEED);
  const build = (extra: Partial<Parameters<typeof buildMaintainerBundle>[0]> = {}) =>
    buildMaintainerBundle({
      id: '20261101T120000Z-0000beef',
      dir: '/sandbox/bundle',
      wiki,
      records,
      context: CONTEXT,
      heldOutTaskIds: [SPLITS_VAL],
      ...extra,
    });

  it('holds only allow-listed files', () => {
    const b = build();
    for (const path of b.files.keys()) {
      expect(path).toMatch(/^(wiki\/|raw\/|incident\/|context\.json$|PROMPT\.md$|bundle\.json$)/);
    }
    expect(b.files.has('wiki/index.md')).toBe(true);
    expect(b.files.has('wiki/patterns/probe-touches-wrong-layer.md')).toBe(true);
    expect(b.files.has('wiki/incidents/2026-09-idle-app-neon-never-sleeps.md')).toBe(true);
    expect(JSON.parse(b.files.get('bundle.json') as string).files).toEqual(
      [...b.files.keys()].sort(),
    );
  });

  it('never contains a val or test raw id, task id, or grader/mutant path', () => {
    const b = build({ sample: { failing: 50, passing: 50 } });
    heldOutAbsent(b.files);
    expect(b.manifest.rawIds.sort()).toEqual([train1.rawId, train2.rawId, field1.rawId].sort());
  });

  it('fills PROMPT.md with the full 06 §2.2 prompt and the bundle paths', () => {
    const prompt = build().files.get('PROMPT.md') as string;
    expect(prompt).toContain('/sandbox/bundle/wiki/index.md');
    expect(prompt).toContain('Perform DEEP ANALYSIS.');
    expect(prompt).toContain(MAINTAINER_PROMPT.split('\n').at(-2));
    expect(prompt).not.toContain('{{dir}}');
  });

  it('bundles an incident page under incident/ and refuses a non-incident id', () => {
    const b = build({ incident: 'incident/2026-08-keepalive-green-database-paused' });
    expect(b.files.has('incident/2026-08-keepalive-green-database-paused.md')).toBe(true);
    expect(JSON.parse(b.files.get('incident/refs.json') as string).fetched).toBe(false);
    expect(() => build({ incident: 'pattern/neon-never-sleeps' })).toThrow(/not an incident/);
  });

  it('refuses the whole bundle when held-out material leaks in through a source', () => {
    const leaky = withWrites(wiki, [
      { path: 'log.md', content: `${wiki.log}\nmentions ${VAL_TASK}\n` },
    ]);
    expect(() => build({ wiki: leaky })).toThrow(BundleLeakError);
  });

  it('refuses (does not redact) a bundle whose raw sample holds a secret-shaped string', () => {
    const token = `ghp_${'A1b2'.repeat(9)}`; // built at runtime: no secret-shaped literal in the repo
    const leaky = rec({ id: 'dddd0001', split: 'train', excerpt: `FAIL auth\ntoken ${token}` });
    expect(() =>
      build({ records: [...records, leaky], sample: { failing: 50, passing: 50 } }),
    ).toThrow(BundleSecretError);
    try {
      build({ records: [leaky] });
    } catch (err) {
      expect((err as Error).message).toMatch(/raw\/.*: line \d+: github-shaped secret/);
      expect((err as Error).message).not.toContain(token);
    }
  });

  it('is deterministic for a seed', () => {
    const a = build({ seed: 'x' });
    const b = build({ seed: 'x' });
    expect(a.manifest.rawIds).toEqual(b.manifest.rawIds);
  });
});

describe('proposer bundle (06 §3.1)', () => {
  const evaluation = 'e'.repeat(64);
  const event = sealEvent({
    ts: '2026-11-01T10:00:00.000Z',
    proposalId: 'prop-1',
    stage: 'candidate-rejected',
    path: 'standard',
    skill: 'deploy-verify-promote',
    outlet: 'skill',
    evidence: {
      kind: 'bench',
      gateInput: 'f'.repeat(64),
      evaluationRecords: [evaluation],
      results: [
        {
          model: 'model-a',
          mode: 'isolation',
          split: 'val',
          runs: 3,
          replay: { total: 2, baselinePassing: 2, candidatePassing: 1, regressions: [VAL_TASK] },
          capability: { before: 0.5, after: 0.25, delta: -0.25, pValue: null },
          decision: 'fail',
        },
      ],
    },
  });
  const seed = loadWiki(SEED);
  const wiki = withWrites(seed, [
    { path: 'ledger.jsonl', content: `${canonicalJson(event)}\n` },
    { path: 'skill-impact.md', content: renderSkillImpact([event]) },
  ]);
  const b = buildProposerBundle({
    id: '20261101T120000Z-0000cafe',
    dir: '/sandbox/p',
    wiki,
    records,
    skills: ['deploy-verify-promote'],
    heldOutTaskIds: [SPLITS_VAL],
  });

  it('holds exactly index, skill-impact, outcomes, the prompt, the access log and the manifest', () => {
    expect([...b.files.keys()].sort()).toEqual(
      [
        'PROMPT.md',
        'access.jsonl',
        'bundle.json',
        'index.md',
        'outcomes.md',
        'skill-impact.md',
      ].sort(),
    );
    expect(b.files.get('PROMPT.md')).toContain(PROPOSER_PROMPT.split('\n')[0]);
    expect(b.files.get('PROMPT.md')).toContain('/sandbox/p/outcomes.md');
  });

  it('builds outcomes.md from train records and ledger aggregates only', () => {
    const outcomes = b.files.get('outcomes.md') as string;
    expect(outcomes).toContain('replay/fixture-task-train');
    expect(outcomes).toContain(
      '| 2026-11-01 | deploy-verify-promote | model-a | isolation | 0.25 |',
    );
    expect(outcomes).toContain('pattern/neon-never-sleeps');
    expect(outcomes).toMatch(/\| 2 \| 1 \| 0 \| 0% \|/);
    heldOutAbsent(b.files);
  });
});

describe('read-only interface (06 §1.4, §3.1)', () => {
  const wiki = loadWiki(SEED);
  const src = { wiki, records, skillsDir: resolve(__dirname, '../../../../.claude/skills') };

  it('refuses val and test raw records with the documented error', () => {
    expect(readTarget(`raw:${valRec.rawId}`, 'proposer', src)).toEqual({
      ok: false,
      code: 4,
      message: `raw ${valRec.rawId} belongs to split val; not visible to role proposer`,
    });
    expect(readTarget(`raw:${testRec.rawId}`, 'maintainer', src)).toMatchObject({
      ok: false,
      message: `raw ${testRec.rawId} belongs to split test; not visible to role maintainer`,
    });
    expect(readTarget(`raw:${train1.rawId}`, 'proposer', src).ok).toBe(true);
    expect(readTarget(`raw:${field1.rawId}`, 'proposer', src).ok).toBe(true);
  });

  it('serves pages with a hypothesis banner and refuses incidents outside the maintainer role', () => {
    const h = readTarget('pattern/neon-never-sleeps', 'proposer', src);
    expect(h.ok && h.text.startsWith('> HYPOTHESIS — not guidance')).toBe(true);
    const inc = 'incidents/2026-08-keepalive-green-database-paused';
    expect(readTarget(inc, 'proposer', src)).toMatchObject({ ok: false, code: 4 });
    expect(readTarget(inc, 'maintainer', src).ok).toBe(true);
    expect(readTarget('skill:deploy-verify-promote', 'proposer', src).ok).toBe(true);
    expect(readTarget('pattern/nope', 'proposer', src)).toMatchObject({ ok: false, code: 3 });
  });

  it('wiki traces never lists val or test records', () => {
    const listed = listTraces(records, { failed: true, limit: 100 }).map((r) => r.rawId);
    expect(listed.sort()).toEqual([train1.rawId, field1.rawId].sort());
    expect(listTraces(records, { skill: 'deploy-verify-promote' }).map((r) => r.rawId)).toContain(
      field1.rawId,
    );
  });
});

describe('loadRawStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gl-raw-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('validates records, skips bad files, and orders newest first', () => {
    const late = rec({ id: 'cccc0001', startedAt: '2026-11-02T09:00:00Z' });
    writeRaw(dir, [train1, late]);
    writeFileSync(join(dir, 'bad.json'), '{"tool":1}');
    const store = loadRawStore(dir);
    expect(store.records.map((r) => r.rawId)).toEqual([late.rawId, train1.rawId]);
    expect(store.errors.map((e) => e.file)).toEqual(['bad.json']);
  });
});

describe('checkProposal (06 §3.4)', () => {
  let root: string;
  let bundleDir: string;
  let skillsDir: string;
  const wiki = loadWiki(SEED);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gl-prop-'));
    bundleDir = join(root, 'bundle');
    skillsDir = join(root, 'skills');
    mkdirSync(join(skillsDir, 'demo'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'demo/SKILL.md'),
      '---\nname: demo\nversion: "1"\n---\n# Demo\nRule one.\n',
    );
    mkdirSync(join(root, 'tools/_template-next'), { recursive: true });
    writeBundle(
      bundleDir,
      buildProposerBundle({ id: 'b1', dir: bundleDir, wiki, records: [], skills: ['demo'] }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const patch = (edits: unknown[], extra: Record<string, unknown> = {}) => ({
    action: 'patch',
    outlet: 'skill',
    name: 'demo',
    edits,
    patterns: ['pattern/probe-touches-wrong-layer'],
    ...extra,
  });
  const check = (output: unknown) =>
    checkProposal({ output, bundleDir, wiki, skillsDir, templatesDir: join(root, 'tools') });
  const readFour = () => {
    for (const id of ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004']) {
      recordAccess(bundleDir, { ts: 'now', command: 'read', target: `raw:20261101T090000Z-${id}` });
    }
  };
  const good = patch([{ op: 'replace', file: 'SKILL.md', target: 'Rule one.', text: 'Rule two.' }]);

  it('refuses a proposal before four raw traces were read', () => {
    recordAccess(bundleDir, {
      ts: 'now',
      command: 'read',
      target: 'raw:20261101T090000Z-aaaa0001',
    });
    recordAccess(bundleDir, {
      ts: 'now',
      command: 'read',
      target: 'raw:20261101T090000Z-aaaa0001',
    });
    recordAccess(bundleDir, {
      ts: 'now',
      command: 'read',
      target: 'raw:20261101T090000Z-bbbb0001',
      refused: 'not visible',
    });
    const r = check(good);
    expect(r).toMatchObject({ ok: false, code: 4 });
    expect(!r.ok && r.errors.join()).toMatch(/shows 1 `wiki read raw:` call/);
  });

  it('accepts a valid patch after four distinct raw reads, with a stable id', () => {
    readFour();
    const r = check(good);
    expect(r.ok).toBe(true);
    expect(r.ok && r.proposalId).toMatch(/^prop-[0-9a-f]{12}$/);
    expect(r.ok && check(good).ok && r.proposalId).toBe(
      (check(good) as { proposalId: string }).proposalId,
    );
  });

  it('refuses a version touch', () => {
    readFour();
    const r = check(
      patch([{ op: 'replace', file: 'SKILL.md', target: 'version: "1"', text: 'version: "2"' }]),
    );
    expect(r).toMatchObject({ ok: false, code: 4 });
    expect(!r.ok && r.errors.join()).toMatch(/version/);
  });

  it('refuses paths that leave the target, and missing targets', () => {
    readFour();
    expect(check(patch([{ op: 'append', file: '../other/SKILL.md', text: 'x' }]))).toMatchObject({
      ok: false,
      code: 1,
    });
    const outside = check(
      patch([{ op: 'append', file: 'SKILL.md', text: 'x' }], { name: '../../etc' }),
    );
    expect(outside).toMatchObject({ ok: false, code: 4 });
    const tpl = check(
      patch([{ op: 'append', file: 'x.ts', text: 'x' }], {
        outlet: 'template',
        name: 'not-a-template',
      }),
    );
    expect(!tpl.ok && tpl.errors.join()).toMatch(/outside/);
    const missing = check(patch([{ op: 'append', file: 'NOPE.md', text: 'x' }]));
    expect(!missing.ok && missing.errors.join()).toMatch(/does not exist/);
  });

  it('refuses unknown pattern ids and a create over an existing skill', () => {
    readFour();
    expect(check({ ...good, patterns: ['pattern/does-not-exist'] })).toMatchObject({
      ok: false,
      code: 4,
    });
    const create = {
      action: 'create',
      outlet: 'skill',
      name: 'demo',
      skill_md: '# x',
      purpose_md: '# y',
      patterns: ['pattern/neon-never-sleeps'],
    };
    expect(check(create)).toMatchObject({ ok: false, code: 4 });
  });

  it('rejects a malformed output with exit 1', () => {
    expect(check({ action: 'patch' })).toMatchObject({ ok: false, code: 1 });
  });
});
