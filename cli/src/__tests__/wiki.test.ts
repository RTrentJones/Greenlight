import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rec, writeRaw } from '../../../packages/wiki/src/__tests__/raw-fixtures';
import { type WikiIo, wikiCommand } from '../commands/wiki';

// `greenlight wiki …` end to end in a scratch wrapper (no network, no LLM).

const SEED = resolve(__dirname, '../../../wiki');
const VAL_TASK = 'replay/held-out-task-val';
const train = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004'].map((id) =>
  rec({ id, split: 'train', task: 'replay/fixture-task-train' }),
);
const val = rec({ id: 'bbbb0001', split: 'val', task: VAL_TASK });
const test = rec({ id: 'bbbb0002', split: 'test', task: 'replay/held-out-task-test' });

let cwd: string;
let out: string[];
let err: string[];
let env: NodeJS.ProcessEnv;

const io = (): WikiIo => ({
  cwd,
  env,
  out: (s) => out.push(s),
  err: (s) => err.push(s),
});
const run = (...args: string[]) => wikiCommand(args, io());

/** Every file under `dir` with its contents, for "nothing changed" assertions. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gl-wiki-cli-'));
  out = [];
  err = [];
  env = { GREENLIGHT_MODEL: 'model-x' };
  cpSync(SEED, join(cwd, 'wiki'), { recursive: true });
  writeRaw(join(cwd, '.greenlight/raw'), [...train, val, test]);
  mkdirSync(join(cwd, '.claude/skills/demo'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude/skills/demo/SKILL.md'),
    '---\nname: demo\nversion: "1"\n---\n# Demo\nRule one.\n',
  );
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('wiki lint', () => {
  it('passes on the seed and fails (exit 1) on a broken page', async () => {
    expect(await run('lint', '--strict')).toBe(0);
    writeFileSync(join(cwd, 'wiki/patterns/broken.md'), '---\nid: pattern/broken\n---\n');
    expect(await run('lint', '--json')).toBe(1);
    const { findings } = JSON.parse(out.at(-1) as string);
    expect(findings.map((f: { rule: string }) => f.rule)).toContain('LR-01');
  });

  it('exits 2 on an unknown flag and 3 without a wiki', async () => {
    expect(await run('lint', '--nope')).toBe(2);
    expect(await run('lint', '--root', 'missing')).toBe(3);
  });
});

describe('wiki ingest', () => {
  it('writes a maintainer bundle with no val/test material', async () => {
    expect(await run('ingest', '--out', 'b1', '--seed', 's', '--sample', '5:3')).toBe(0);
    const dir = join(cwd, 'b1');
    expect(out.at(-1)).toBe(dir);
    const files = snapshot(dir);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['PROMPT.md', 'context.json', 'bundle.json', 'wiki/index.md']),
    );
    expect(Object.keys(files).filter((f) => f.startsWith('raw/'))).toHaveLength(4);
    const all = Object.entries(files).join('\n');
    for (const t of [val.rawId, test.rawId, VAL_TASK, 'bench/graders', 'bench/mutants']) {
      expect(all).not.toContain(t);
    }
    expect(JSON.parse(files['context.json'] as string).skills).toEqual({ demo: '1' });
  });

  const page = (id: string, link = '') => `---
id: pattern/${id}
type: pattern
title: A new hypothesis
updated: 2026-11-01
status: hypothesis
kind: failure
class: proxy-check
atRisk: something
cells: ["*/*/*"]
affects: "*"
relevance: app-code
evidence: []
remediation: []
skills: []
---
## Symptom
S.${link}

## Root cause
R.

## Fix / workaround
F.

## How it is caught
C.
`;
  const output = (pages: unknown[], updates: unknown[] = []) => ({
    create_pages: pages,
    update_pages: updates,
    update_index: '# Index\n',
    append_log: 'created pattern/new-one',
  });
  const apply = async (o: unknown) => {
    writeFileSync(join(cwd, 'out.json'), JSON.stringify(o));
    return run('ingest', '--apply', 'out.json');
  };

  it('--apply writes pages, the reconciled index and a log entry', async () => {
    expect(await apply(output([{ id: 'pattern/new-one', content: page('new-one') }]))).toBe(0);
    expect(existsSync(join(cwd, 'wiki/patterns/new-one.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'wiki/index.md'), 'utf8')).toContain('patterns/new-one.md');
    expect(readFileSync(join(cwd, 'wiki/log.md'), 'utf8')).toMatch(/— maintainer:model-x — ingest/);
    expect(await run('lint', '--strict')).toBe(0);
  });

  it('--apply is atomic: a failing third op leaves every file unchanged', async () => {
    const before = snapshot(join(cwd, 'wiki'));
    const o = output(
      [{ id: 'pattern/new-one', content: page('new-one') }],
      [
        { id: 'pattern/neon-never-sleeps', ops: [{ op: 'append', text: '\nMore.\n' }] },
        {
          id: 'pattern/probe-touches-wrong-layer',
          ops: [{ op: 'replace', target: 'no such text', text: 'x' }],
        },
      ],
    );
    expect(await apply(o)).toBe(1);
    expect(snapshot(join(cwd, 'wiki'))).toEqual(before);
  });

  it('--apply is rejected, writing nothing, when the result fails lint', async () => {
    const before = snapshot(join(cwd, 'wiki'));
    const o = output([
      { id: 'pattern/new-one', content: page('new-one', ' See [x](../nowhere.md).') },
    ]);
    expect(await apply(o)).toBe(1);
    expect(err.join('\n')).toMatch(/rejected by lint[\s\S]*LR-03/);
    expect(snapshot(join(cwd, 'wiki'))).toEqual(before);
  });
});

describe('wiki read / traces / propose', () => {
  it('refuses val records with the 06 §1.4 error and logs every read in the bundle', async () => {
    expect(await run('propose', '--out', 'pb')).toBe(0);
    env.GREENLIGHT_BUNDLE = join(cwd, 'pb');
    expect(await run('read', `raw:${val.rawId}`)).toBe(4);
    expect(err.at(-1)).toBe(`raw ${val.rawId} belongs to split val; not visible to role proposer`);
    expect(await run('read', `raw:${train[0]?.rawId}`)).toBe(0);
    expect(await run('read', 'incident/2026-08-keepalive-green-database-paused')).toBe(4);
    const log = readFileSync(join(cwd, 'pb/access.jsonl'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(3);
    expect(JSON.parse(log[0] as string).refused).toMatch(/not visible/);
  });

  it('a proposer bundle cannot widen its role', async () => {
    expect(await run('propose', '--out', 'pb')).toBe(0);
    env.GREENLIGHT_BUNDLE = join(cwd, 'pb');
    expect(
      await run(
        'read',
        '--role',
        'maintainer',
        'incidents/2026-08-keepalive-green-database-paused',
      ),
    ).toBe(4);
  });

  it('traces lists only visible records', async () => {
    expect(await run('traces', '--skill', 'demo', '--failed', '--json')).toBe(0);
    const ids = JSON.parse(out.at(-1) as string).map((r: { rawId: string }) => r.rawId);
    expect(ids.sort()).toEqual(train.map((r) => r.rawId).sort());
    expect(await run('traces', '--failed', '--passing')).toBe(2);
  });

  it('propose --apply refuses before 4 raw reads and records a validated proposal after', async () => {
    expect(await run('propose', '--skill', 'demo', '--out', 'pb')).toBe(0);
    const bundle = join(cwd, 'pb');
    const files = Object.keys(snapshot(bundle)).sort();
    expect(files).toEqual(
      [
        'PROMPT.md',
        'access.jsonl',
        'bundle.json',
        'index.md',
        'outcomes.md',
        'skill-impact.md',
      ].sort(),
    );
    const proposal = {
      action: 'patch',
      outlet: 'skill',
      name: 'demo',
      edits: [{ op: 'replace', file: 'SKILL.md', target: 'Rule one.', text: 'Rule two.' }],
      patterns: ['pattern/probe-touches-wrong-layer'],
    };
    writeFileSync(join(bundle, 'out.json'), JSON.stringify(proposal));
    expect(await run('propose', '--apply', 'pb/out.json')).toBe(4);
    env.GREENLIGHT_BUNDLE = bundle;
    for (const r of train) expect(await run('read', `raw:${r.rawId}`)).toBe(0);
    expect(await run('propose', '--apply', 'pb/out.json')).toBe(0);
    const recorded = JSON.parse(readFileSync(join(bundle, 'proposal.json'), 'utf8'));
    expect(recorded.proposalId).toMatch(/^prop-/);
    // The skill itself is untouched in M1: validation applies edits in memory only.
    expect(readFileSync(join(cwd, '.claude/skills/demo/SKILL.md'), 'utf8')).toContain('Rule one.');

    writeFileSync(
      join(bundle, 'v.json'),
      JSON.stringify({
        ...proposal,
        edits: [{ op: 'replace', file: 'SKILL.md', target: 'version: "1"', text: 'version: "2"' }],
      }),
    );
    expect(await run('propose', '--apply', 'pb/v.json')).toBe(4);
    expect(err.join('\n')).toMatch(/version field/);
  });
});
