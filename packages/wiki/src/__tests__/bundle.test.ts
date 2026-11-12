import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_LOG,
  BundleLeakError,
  BundleSecretError,
  BundleTrustError,
  MAINTAINER_PROMPT,
  PROPOSER_PROMPT,
  acceptedSkillSet,
  buildMaintainerBundle,
  buildProposerBundle,
  checkProposal,
  listTraces,
  loadRawStore,
  openBundle,
  readAccessLog,
  readTarget,
  recordAccess,
  renderOutcomes,
  skillSetHash,
  writeBundle,
} from '../bundle';
import { renderSkillImpact } from '../ledger';
import { loadWiki, withWrites } from '../load';
import { type LedgerEvent, canonicalJson, sealEvent } from '../schema';
import { SKILL_SET, fixtureSplits, rec, writeRaw } from './raw-fixtures';

const SEED = resolve(__dirname, '../../../../wiki');
const VAL_TASK = 'replay/held-out-task-val';
const TEST_TASK = 'replay/held-out-task-test';
const SPLITS_VAL = 'loop/held-out-loop-val';
const splits = fixtureSplits({ [VAL_TASK]: 'val', [TEST_TASK]: 'test', [SPLITS_VAL]: 'val' });

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

/** A control-arm rejection whose gate evidence and reason name a val task (the M2 control arm). */
const controlRejection = sealEvent({
  ts: '2026-11-01T10:00:00.000Z',
  proposalId: 'prop-control',
  stage: 'candidate-rejected',
  path: 'standard',
  control: true,
  skill: 'deploy-verify-promote',
  outlet: 'skill',
  reason: `control arm: regressed on ${VAL_TASK}`,
  evidence: {
    kind: 'bench',
    gateInput: 'f'.repeat(64),
    evaluationRecords: ['e'.repeat(64)],
    results: [
      {
        model: 'model-a',
        mode: 'isolation',
        split: 'val',
        runs: 3,
        replay: { total: 2, baselinePassing: 2, candidatePassing: 1, regressions: [VAL_TASK] },
        capability: { before: 0.5, after: 0.25, delta: -0.25, pValue: 0.04 },
        decision: 'fail',
      },
      {
        model: 'model-a',
        mode: 'isolation',
        split: 'test',
        runs: 3,
        replay: { total: 1, baselinePassing: 1, candidatePassing: 0, regressions: [TEST_TASK] },
        capability: { before: 0.9, after: 0.1, delta: -0.8, pValue: null },
        decision: 'fail',
      },
    ],
  },
});

const withLedger = (events: LedgerEvent[]) =>
  withWrites(loadWiki(SEED), [
    { path: 'ledger.jsonl', content: events.map((e) => `${canonicalJson(e)}\n`).join('') },
    { path: 'skill-impact.md', content: renderSkillImpact(events) },
  ]);

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
      splits,
      ...extra,
    });

  it('holds only allow-listed files', () => {
    const b = build();
    for (const path of b.files.keys()) {
      expect(path).toMatch(
        /^(wiki\/|raw\/|incident\/|context\.json$|PROMPT\.md$|bundle\.json$|access\.jsonl$)/,
      );
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

  it('bundles a PROJECTED ledger: a control-arm rejection naming a val task does not leak', () => {
    const b = build({ wiki: withLedger([controlRejection]) });
    heldOutAbsent(b.files);
    const ledger = b.files.get('wiki/ledger.jsonl') as string;
    const projected = JSON.parse(ledger.trim());
    expect(projected).toEqual({
      ts: controlRejection.ts,
      proposalId: 'prop-control',
      stage: 'candidate-rejected',
      path: 'standard',
      control: true,
      skill: 'deploy-verify-promote',
      outlet: 'skill',
      evidence: 'bench',
    });
    // The maintainer sees no val results at all (06 §1.4): no scores, no regressions, no reason.
    for (const t of ['regressions', 'reason', 'capability', '0.25', 'pValue']) {
      expect(ledger).not.toContain(t);
    }
    const impact = b.files.get('wiki/skill-impact.md') as string;
    expect(impact).toContain('prop-control');
    expect(impact).toContain('candidate-rejected: bench evidence');
    expect(impact).not.toContain('regressed');
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

  it('bundles no bench record when splits.json is unavailable', () => {
    const b = build({ splits: undefined, sample: { failing: 50, passing: 50 } });
    expect(b.manifest.rawIds).toEqual([field1.rawId]);
  });
});

describe('proposer bundle (06 §3.1)', () => {
  const wiki = withLedger([controlRejection]);
  const b = buildProposerBundle({
    id: '20261101T120000Z-0000cafe',
    dir: '/sandbox/p',
    wiki,
    records,
    skills: ['deploy-verify-promote'],
    heldOutTaskIds: [SPLITS_VAL],
    splits,
    acceptedSkillSetHash: SKILL_SET,
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

  it('projects skill-impact.md: aggregate val score per model × mode, no regressions or test', () => {
    const impact = b.files.get('skill-impact.md') as string;
    expect(impact).toContain(
      'candidate-rejected: model-a isolation/val: capability 0.50→0.25 (-0.25) → fail',
    );
    expect(impact).toMatch(/## Controls[\s\S]*prop-control/);
    for (const t of ['regressed', 'replay', 'p=', '0.90', '/test']) expect(impact).not.toContain(t);
    heldOutAbsent(b.files);
  });
});

describe('outcomes.md baseline: the ACCEPTED skill set', () => {
  const accepted = 'a'.repeat(64);
  const candidate = 'c'.repeat(64);
  const older = rec({ id: 'cccc0001', split: 'train', startedAt: '2026-11-01T08:00:00Z' });
  const newerCandidate = rec({
    id: 'cccc0002',
    split: 'train',
    startedAt: '2026-11-01T11:00:00Z',
    task: 'replay/other-task-train',
    skillSetHash: candidate,
  });
  const wiki = loadWiki(SEED);
  const render = (h?: string) =>
    renderOutcomes({
      records: [newerCandidate, older],
      ledger: [],
      wiki,
      skills: [],
      splits: fixtureSplits({ 'replay/other-task-train': 'train' }),
      acceptedSkillSetHash: h,
    });

  it('reports the accepted set, not the newest train record', () => {
    const out = render(accepted);
    expect(out).toContain(`Accepted skill set \`${accepted.slice(0, 12)}\``);
    expect(out).toContain('replay/fixture-task-train');
    expect(out).not.toContain('replay/other-task-train');
    expect(render()).toContain('No accepted skill set is known yet');
  });

  it('derives the accepted set from the latest merged or gated ledger state', () => {
    const gate = (ch: string) => ({ kind: 'bench' as const, gateInput: ch.repeat(64) });
    const ev = (e: Omit<LedgerEvent, 'eventId' | 'writer'>) => sealEvent(e);
    const bench = (ch: string) => ({
      ...gate(ch),
      evaluationRecords: ['e'.repeat(64)],
      results: controlRejection.evidence?.kind === 'bench' ? controlRejection.evidence.results : [],
    });
    const sets: Record<string, { acceptedSkillSetHash: string; candidateSkillSetHash: string }> = {
      ['1'.repeat(64)]: { acceptedSkillSetHash: accepted, candidateSkillSetHash: candidate },
      ['2'.repeat(64)]: { acceptedSkillSetHash: accepted, candidateSkillSetHash: 'd'.repeat(64) },
    };
    const lookup = (h: string) => sets[h];
    const acceptedEv = ev({
      ts: '2026-11-01T01:00:00.000Z',
      proposalId: 'p1',
      stage: 'candidate-accepted',
      path: 'standard',
      outlet: 'skill',
      evidence: bench('1'),
    });
    const merged = ev({ ts: '2026-11-01T02:00:00.000Z', proposalId: 'p1', stage: 'merged' });
    const control = ev({
      ts: '2026-11-01T03:00:00.000Z',
      proposalId: 'p2',
      stage: 'candidate-rejected',
      path: 'standard',
      control: true,
      evidence: bench('2'),
    });
    expect(acceptedSkillSet([acceptedEv], lookup)).toBe(accepted);
    expect(acceptedSkillSet([acceptedEv, merged, control], lookup)).toBe(candidate);
    const withdrawn = ev({
      ts: '2026-11-01T04:00:00.000Z',
      proposalId: 'p1',
      stage: 'withdrawn',
      reason: 'rolled back',
    });
    expect(acceptedSkillSet([acceptedEv, merged, withdrawn], lookup)).toBeUndefined();
    expect(acceptedSkillSet([], lookup)).toBeUndefined();
  });

  it('hashes the installed skill set over SKILL.md and PURPOSE.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gl-skillset-'));
    try {
      expect(skillSetHash(dir)).toBeUndefined();
      mkdirSync(join(dir, 'a'));
      writeFileSync(join(dir, 'a/SKILL.md'), '---\nname: a\nversion: "1"\n---\n');
      const h1 = skillSetHash(dir);
      writeFileSync(join(dir, 'a/PURPOSE.md'), '---\nversion: "1"\n---\n');
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(skillSetHash(dir)).not.toBe(h1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('read-only interface (06 §1.4, §3.1)', () => {
  const wiki = loadWiki(SEED);
  const src = {
    wiki,
    records,
    skillsDir: resolve(__dirname, '../../../../.claude/skills'),
    splits,
  };

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

  it('derives the split from splits.json, not from the record', () => {
    const liar = rec({ id: 'bbbb0003', split: 'train', task: VAL_TASK });
    const unknown = rec({ id: 'bbbb0004', split: 'train', task: 'replay/unlisted-train' });
    const s = { ...src, records: [liar, unknown] };
    expect(readTarget(`raw:${liar.rawId}`, 'proposer', s)).toMatchObject({
      ok: false,
      message: `raw ${liar.rawId} belongs to split val; not visible to role proposer`,
    });
    expect(readTarget(`raw:${unknown.rawId}`, 'proposer', s)).toMatchObject({
      ok: false,
      code: 4,
      message: expect.stringMatching(/split cannot be established/),
    });
    expect(
      readTarget(`raw:${train1.rawId}`, 'proposer', { ...src, splits: undefined }),
    ).toMatchObject({ ok: false, code: 4 });
  });

  it('serves pages with a hypothesis banner; incidents only to the maintainer (06 §1.4)', () => {
    const h = readTarget('pattern/neon-never-sleeps', 'proposer', src);
    expect(h.ok && h.text.startsWith('> HYPOTHESIS — not guidance')).toBe(true);
    const inc = 'incidents/2026-08-keepalive-green-database-paused';
    const refused = readTarget(inc, 'proposer', src);
    expect(refused).toMatchObject({ ok: false, code: 4 });
    expect(!refused.ok && refused.message).toMatch(/only through the pattern pages/);
    expect(readTarget(inc, 'maintainer', src).ok).toBe(true);
    expect(readTarget('skill:deploy-verify-promote', 'proposer', src).ok).toBe(true);
    expect(readTarget('pattern/nope', 'proposer', src)).toMatchObject({ ok: false, code: 3 });
  });

  it('wiki traces never lists val or test records', () => {
    const listed = listTraces(records, { failed: true, limit: 100, splits }).map((r) => r.rawId);
    expect(listed.sort()).toEqual([train1.rawId, field1.rawId].sort());
    expect(
      listTraces(records, { skill: 'deploy-verify-promote', splits }).map((r) => r.rawId),
    ).toContain(field1.rawId);
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

describe('bundle trust (06 §3.1)', () => {
  let root: string;
  let keysDir: string;
  const wiki = loadWiki(SEED);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gl-trust-'));
    keysDir = join(root, '.greenlight/bundle-keys');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const issue = (id: string, role: 'proposer' | 'maintainer' = 'proposer') => {
    const dir = join(root, 'bundles', id);
    const b =
      role === 'proposer'
        ? buildProposerBundle({ id, dir, wiki, records: [], skills: [] })
        : buildMaintainerBundle({ id, dir, wiki, records: [], context: CONTEXT });
    writeBundle(dir, b, { keysDir });
    return dir;
  };

  it('stores the key outside the bundle with mode 0600 and verifies the manifest', () => {
    const dir = issue('b1');
    const key = join(keysDir, 'b1');
    expect(existsSync(key)).toBe(true);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'bundle.json'), 'utf8')).not.toContain(
      JSON.parse(readFileSync(key, 'utf8')).key,
    );
    expect(openBundle(dir, keysDir).manifest.role).toBe('proposer');
    expect(() =>
      writeBundle(
        join(root, 'x'),
        buildProposerBundle({ id: 'x', dir: '', wiki, records: [], skills: [] }),
        {
          keysDir: join(root, 'x', 'keys'),
        },
      ),
    ).toThrow(BundleTrustError);
  });

  it('refuses a hand-written bundle.json: any dir, an unissued id, or an edited role', () => {
    const fake = join(root, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, 'bundle.json'), JSON.stringify({ id: 'nope', role: 'proposer' }));
    expect(() => openBundle(fake, keysDir)).toThrow(/not issued/);
    const m = issue('m1', 'maintainer');
    const text = readFileSync(join(m, 'bundle.json'), 'utf8');
    writeFileSync(join(m, 'bundle.json'), text.replace('"maintainer"', '"proposer"'));
    expect(() => openBundle(m, keysDir)).toThrow(/does not match/);
    // Copying an issued bundle's manifest into another dir and pointing it at a different id fails.
    writeFileSync(join(fake, 'bundle.json'), text.replace('"m1"', '"../m1"'));
    expect(() => openBundle(fake, keysDir)).toThrow(BundleTrustError);
  });

  it('chains MAC’d access entries; a forged, edited or reordered line breaks verification', () => {
    const dir = issue('b2');
    const b = openBundle(dir, keysDir);
    for (const t of ['raw:a', 'raw:b']) recordAccess(b, { ts: 't', command: 'read', target: t });
    expect(readAccessLog(b)).toMatchObject({ problems: [] });
    expect(readAccessLog(b).entries.map((e) => e.seq)).toEqual([0, 1]);
    const file = join(dir, ACCESS_LOG);
    const good = readFileSync(file, 'utf8');
    // Forged: a well-formed line with a made-up MAC.
    appendFileSync(
      file,
      `${JSON.stringify({ seq: 2, ts: 't', command: 'read', target: 'raw:c', prev: 'a'.repeat(64), mac: 'b'.repeat(64) })}\n`,
    );
    expect(readAccessLog(b).problems).toHaveLength(1);
    expect(() => recordAccess(b, { ts: 't', command: 'read', target: 'raw:d' })).toThrow(
      /tampered/,
    );
    // Reordered.
    const [l0, l1] = good.trim().split('\n');
    writeFileSync(file, `${l1}\n${l0}\n`);
    expect(readAccessLog(b).problems.length).toBeGreaterThan(0);
    // Edited target.
    writeFileSync(file, good.replace('raw:a', 'raw:z'));
    expect(readAccessLog(b).problems.length).toBeGreaterThan(0);
    // Spliced from another bundle (different key).
    const other = openBundle(issue('b3'), keysDir);
    recordAccess(other, { ts: 't', command: 'read', target: 'raw:a' });
    writeFileSync(file, readFileSync(join(other.dir, ACCESS_LOG), 'utf8'));
    expect(readAccessLog(b).problems.length).toBeGreaterThan(0);
  });
});

describe('checkProposal (06 §3.4)', () => {
  let root: string;
  let bundleDir: string;
  let skillsDir: string;
  let keysDir: string;
  const wiki = loadWiki(SEED);
  const store = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004'].map((id) =>
    rec({ id, split: 'train' }),
  );
  const valStored = rec({ id: 'bbbb0001', split: 'val' });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gl-prop-'));
    bundleDir = join(root, 'bundle');
    skillsDir = join(root, 'skills');
    keysDir = join(root, '.greenlight/bundle-keys');
    mkdirSync(join(skillsDir, 'demo'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'demo/SKILL.md'),
      '---\nname: demo\nversion: "1"\n---\n# Demo\nRule one.\n',
    );
    mkdirSync(join(root, 'tools/_template-next'), { recursive: true });
    writeBundle(
      bundleDir,
      buildProposerBundle({ id: 'b1', dir: bundleDir, wiki, records: [], skills: ['demo'] }),
      { keysDir },
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
  const check = (output: unknown, dir = bundleDir) =>
    checkProposal({
      output,
      bundleDir: dir,
      wiki,
      skillsDir,
      templatesDir: join(root, 'tools'),
      keysDir,
      records: [...store, valStored],
      splits: fixtureSplits(),
    });
  const read = (target: string, refused?: string) =>
    recordAccess(openBundle(bundleDir, keysDir), {
      ts: 'now',
      command: 'read',
      target,
      ...(refused ? { refused } : {}),
    });
  const readFour = () => {
    for (const r of store) read(`raw:${r.rawId}`);
  };
  const good = patch([{ op: 'replace', file: 'SKILL.md', target: 'Rule one.', text: 'Rule two.' }]);

  it('refuses a proposal before four raw traces were read', () => {
    read(`raw:${store[0]?.rawId}`);
    read(`raw:${store[0]?.rawId}`);
    read(`raw:${valStored.rawId}`, 'not visible');
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

  it('counts only real raw ids visible to the proposer', () => {
    // Unknown ids and a val record logged as if it were served never count.
    for (const id of ['20261101T090000Z-ffff0001', '20261101T090000Z-ffff0002']) read(`raw:${id}`);
    read(`raw:${valStored.rawId}`);
    read(`raw:${store[0]?.rawId}`);
    const r = check(good);
    expect(!r.ok && r.errors.join()).toMatch(/shows 1 `wiki read raw:` call/);
  });

  it('refuses a forged access log written from inside the bundle', () => {
    const lines = store.map((r, seq) =>
      JSON.stringify({
        seq,
        ts: 'now',
        command: 'read',
        target: `raw:${r.rawId}`,
        prev: '0'.repeat(64),
        mac: '0'.repeat(64),
      }),
    );
    writeFileSync(join(bundleDir, ACCESS_LOG), `${lines.join('\n')}\n`);
    const r = check(good);
    expect(r).toMatchObject({ ok: false, code: 4 });
    expect(!r.ok && r.errors.join()).toMatch(/fails verification/);
  });

  it('refuses a directory that only claims to be a proposer bundle', () => {
    const fake = join(root, 'fake');
    cpSync(bundleDir, fake, { recursive: true });
    const m = JSON.parse(readFileSync(join(fake, 'bundle.json'), 'utf8'));
    writeFileSync(join(fake, 'bundle.json'), JSON.stringify({ ...m, id: 'forged' }));
    expect(check(good, fake)).toMatchObject({ ok: false, code: 4 });
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
    // A name is one canonical segment: the schema refuses a path.
    const outside = check(
      patch([{ op: 'append', file: 'SKILL.md', text: 'x' }], { name: '../../etc' }),
    );
    expect(outside).toMatchObject({ ok: false, code: 1 });
    const tpl = check(
      patch([{ op: 'append', file: 'x.ts', text: 'x' }], {
        outlet: 'template',
        name: 'not-a-template',
      }),
    );
    expect(!tpl.ok && tpl.errors.join()).toMatch(/not a template name/);
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

  it('a name must be exactly an accepted skill: no path, no trailing slash, no other dir', () => {
    readFour();
    mkdirSync(join(skillsDir, 'other'), { recursive: true });
    writeFileSync(join(skillsDir, 'other/SKILL.md'), '---\nname: other\n---\n# Other\nRule one.\n');
    const edit = [{ op: 'replace', file: 'SKILL.md', target: 'Rule one.', text: 'Rule two.' }];
    for (const name of ['demo/', 'other/../demo', './demo', 'Demo', 'demo/.']) {
      expect(check(patch(edit, { name })), name).toMatchObject({ ok: false, code: 1 });
    }
    // A directory under the skills dir that is not a loaded skill (no SKILL.md).
    mkdirSync(join(skillsDir, 'notaskill'), { recursive: true });
    writeFileSync(join(skillsDir, 'notaskill/README.md'), 'Rule one.\n');
    const r = check(
      patch([{ op: 'replace', file: 'README.md', target: 'Rule one.', text: 'x' }], {
        name: 'notaskill',
      }),
    );
    expect(!r.ok && r.errors.join()).toMatch(/not an accepted skill/);
  });

  it('a scoped iteration may only patch its own skill', () => {
    readFour();
    mkdirSync(join(skillsDir, 'other'), { recursive: true });
    writeFileSync(join(skillsDir, 'other/SKILL.md'), '---\nname: other\n---\n# Other\nRule one.\n');
    const scoped = (output: unknown, scope: string) =>
      checkProposal({
        output,
        bundleDir,
        wiki,
        skillsDir,
        templatesDir: join(root, 'tools'),
        keysDir,
        records: [...store, valStored],
        splits: fixtureSplits(),
        scope,
      });
    expect(scoped(good, 'demo').ok).toBe(true);
    expect(scoped(good, 'all').ok).toBe(true);
    const r = scoped(good, 'other');
    expect(!r.ok && r.errors.join()).toMatch(/scoped to skill other/);
    const create = {
      action: 'create',
      outlet: 'skill',
      name: 'brand-new',
      skill_md: '# x',
      purpose_md: '# y',
      patterns: ['pattern/probe-touches-wrong-layer'],
    };
    expect(scoped(create, 'all').ok).toBe(true);
    const c = scoped(create, 'demo');
    expect(!c.ok && c.errors.join()).toMatch(/out of scope/);
  });

  it('refuses any edit of a blast-radius line, whole or partial, and a create declaring one', () => {
    readFour();
    writeFileSync(
      join(skillsDir, 'demo/PURPOSE.md'),
      '---\nskill: demo\nblast-radius: high\n---\n# Purpose\nWhy.\n',
    );
    const cases = [
      [
        {
          op: 'replace',
          file: 'PURPOSE.md',
          target: 'blast-radius: high',
          text: 'blast-radius: low',
        },
      ],
      // The target names only part of the line: caught by the before/after comparison.
      [{ op: 'replace', file: 'PURPOSE.md', target: 'radius: high', text: 'radius: low' }],
      [{ op: 'replace', file: 'PURPOSE.md', target: 'high\n---', text: 'low\n---' }],
      [
        {
          op: 'insert_after',
          file: 'PURPOSE.md',
          target: 'skill: demo',
          text: '\nblast-radius: low',
        },
      ],
    ];
    for (const edits of cases) {
      const r = check(patch(edits));
      expect(r, JSON.stringify(edits)).toMatchObject({ ok: false, code: 4 });
      expect(!r.ok && r.errors.join()).toMatch(/blast-radius/);
    }
    // An edit elsewhere in PURPOSE.md is fine.
    expect(
      check(patch([{ op: 'replace', file: 'PURPOSE.md', target: 'Why.', text: 'Because.' }])).ok,
    ).toBe(true);
    const create = {
      action: 'create',
      outlet: 'skill',
      name: 'brand-new',
      skill_md: '# x',
      purpose_md: '---\nskill: brand-new\nblast-radius: low\n---\n',
      patterns: ['pattern/probe-touches-wrong-layer'],
    };
    const r = check(create);
    expect(!r.ok && r.errors.join()).toMatch(/blast-radius/);
  });

  it('rejects a malformed output with exit 1', () => {
    expect(check({ action: 'patch' })).toMatchObject({ ok: false, code: 1 });
  });
});
