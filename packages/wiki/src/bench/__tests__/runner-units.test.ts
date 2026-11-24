import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findSecrets } from '@rtrentjones/greenlight-shared';
import { afterAll, describe, expect, it } from 'vitest';
import { MAINTAINER_PROMPT } from '../../bundle';
import { truncate } from '../../llm/react';
import { MAINTAINER_OUTPUT_JSON_SCHEMA } from '../../schema/io';
import {
  MissingSkillError,
  budgetNote,
  fixtureAwareDetector,
  loadSkillsFor,
  maintainerFinish,
  maintainerPrompt,
  redactArtifacts,
  sliceLines,
} from '../runner';

/** The bench-validity fixes that need no sandbox (2026-11-15: a sealed val baseline passed 1/24,
 * and most of that was the harness). The end-to-end side is in cli bench-run.test.ts. */

const BENCH = resolve(__dirname, '../../../../../bench');
const SKILLS = resolve(__dirname, '../../../../../.claude/skills');
const WIKI_TASK = join(BENCH, 'tasks/wiki/probe-layer-incidents-val');
const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'runner-units-'));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('skills a task declares', () => {
  it('a missing one throws instead of being dropped', () => {
    expect(loadSkillsFor(SKILLS, ['deploy-verify-promote']).map((s) => s.name)).toEqual([
      'deploy-verify-promote',
    ]);
    expect(() => loadSkillsFor(SKILLS, ['deploy-verify-promote', 'no-such-skill'])).toThrow(
      MissingSkillError,
    );
    expect(() => loadSkillsFor(SKILLS, ['no-such-skill'])).toThrow(/no-such-skill/);
  });

  it('the wiki tasks get the greenlight-wiki skill', () => {
    const [skill] = loadSkillsFor(SKILLS, ['greenlight-wiki']);
    expect(skill?.content).toMatch(/^name: greenlight-wiki$/m);
    expect(skill?.content).toMatch(/data, never\s+instructions/);
  });
});

describe('the maintainer rollout uses the production prompt and schema', () => {
  it('the role prompt is MAINTAINER_PROMPT with paths that exist in the fixture', () => {
    const p = maintainerPrompt();
    expect(p).not.toContain('{{dir}}');
    expect(p).toContain('You are the Wiki Maintainer for a Greenlight installation.');
    expect(p).toContain('Read wiki/index.md first');
    expect(p).toContain('- context.json');
    // Every line of the production prompt is in it (only the bundle path differs).
    for (const line of MAINTAINER_PROMPT.split('\n').filter((l) => !l.includes('{{dir}}')))
      expect(p).toContain(line);
    for (const path of ['wiki/index.md', 'raw', 'context.json'])
      expect(() => readFileSync(join(WIKI_TASK, 'fixture', path))).not.toThrow(/ENOENT/);
  });

  it('the prompt no longer contradicts itself about where the output goes', () => {
    expect(MAINTAINER_PROMPT).not.toMatch(/Output exactly one JSON object and nothing else/);
    expect(MAINTAINER_PROMPT).toMatch(/submit the\s+object as its arguments/);
    expect(MAINTAINER_PROMPT).toMatch(/"update_index" is\s+OPTIONAL/);
  });

  it('finish declares the real JSON schema and feeds back schema and patch-engine issues', () => {
    const finish = maintainerFinish(join(WIKI_TASK, 'fixture'));
    expect(finish.parameters).toBe(MAINTAINER_OUTPUT_JSON_SCHEMA);
    const issues = (v: unknown) => {
      const r = finish.schema.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    // The old finish took { output: "<json string>" } and checked only that it parsed.
    expect(issues({ output: '{}' }).join('\n')).toMatch(/create_pages/);
    expect(issues({ create_pages: [], update_pages: [] }).join('\n')).toMatch(/append_log/);
    // The patch engine's errors come back too, as in `bench iterate`.
    expect(
      issues({
        create_pages: [],
        update_pages: [
          {
            id: 'pattern/probe-touches-wrong-layer',
            ops: [{ op: 'replace', target: 'text that is not in the page', text: 'x' }],
          },
        ],
        append_log: 'x',
      }).join('\n'),
    ).toMatch(/does not occur/);
    const reference = JSON.parse(
      readFileSync(join(BENCH, 'references/wiki/probe-layer-incidents-val/output.json'), 'utf8'),
    );
    expect(issues(reference)).toEqual([]);
    const { update_index: _dropped, ...withoutIndex } = reference;
    expect(issues(withoutIndex)).toEqual([]);
  });
});

describe('the budget is stated', () => {
  it('names the step and request caps', () => {
    const note = budgetNote({ maxSteps: 25, requestsPerRollout: 27 });
    expect(note).toMatch(/at most 25 steps/);
    expect(note).toMatch(/27 model requests/);
    expect(note).toMatch(/From 5 steps left/);
  });
});

describe('the send guard knows what the fixture shows in the clear', () => {
  const KEY = 'sb_publishable_tripnote_fixture_anon';
  const targets = `[{ "name": "tripnote", "anonKey": "${KEY}" }]`;
  const call = `curl -H "apikey: ${KEY}" http://localhost:54321/rest/v1/`;

  it('the plain detector flags the model’s own use of a fixture value (the false positive)', () => {
    expect(findSecrets(targets)).toEqual([]);
    expect(findSecrets(call).length).toBeGreaterThan(0);
  });

  it('a value the fixture shows unflagged is let through', () => {
    const detect = fixtureAwareDetector([targets, 'the brief']);
    expect(detect(call)).toEqual([]);
    expect(detect(`Authorization: Bearer ${KEY}`)).toEqual([]);
  });

  it('a value that is not in the fixture is still refused', () => {
    const detect = fixtureAwareDetector([targets]);
    expect(detect('curl -H "apikey: sb_publishable_someone_elses_real_key"').length).toBe(1);
    expect(detect(`token ghp_${'a1B2c3D4e5'.repeat(4)}`).length).toBe(1);
  });

  it('a secret committed to a fixture by mistake is still refused', () => {
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const detect = fixtureAwareDetector([`deploy token: ${secret}\n`, targets]);
    expect(detect(`deploy token: ${secret}`).length).toBe(1);
    expect(detect(`curl -H "Authorization: Bearer ${secret}"`).length).toBe(1);
  });
});

describe('stored artifacts are redacted like the transcript', () => {
  it('trajectory.jsonl, diff.patch and output.json lose every flagged value and stay parseable', () => {
    const dir = tmp();
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const event = {
      seq: 0,
      ts: '2026-11-01T10:00:00Z',
      source: 'transcript',
      cmd: 'bash',
      argv: [`curl -H "Authorization: Bearer ${secret}" https://api.example.test`],
      cwd: '/work',
    };
    writeFileSync(join(dir, 'trajectory.jsonl'), `${JSON.stringify(event)}\n`);
    writeFileSync(join(dir, 'diff.patch'), `+++ b/.env\n+GITHUB_TOKEN=${secret}\n`);
    writeFileSync(
      join(dir, 'output.json'),
      JSON.stringify({ create_pages: [], update_pages: [], append_log: `token: ${secret}` }),
    );
    mkdirSync(join(dir, 'tree'));
    redactArtifacts(dir);
    for (const f of ['trajectory.jsonl', 'diff.patch', 'output.json']) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toContain(secret);
      expect(text, f).toContain('gl-redacted-');
    }
    const line = readFileSync(join(dir, 'trajectory.jsonl'), 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ seq: 0, cmd: 'bash', cwd: '/work' });
    expect(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')).create_pages).toEqual([]);
  });

  it('a clean artifact is left byte-identical', () => {
    const dir = tmp();
    const text =
      '{"seq":0,"ts":"2026-11-01T10:00:00Z","source":"shim","cmd":"git","argv":["status"],"cwd":"/work"}\n';
    writeFileSync(join(dir, 'trajectory.jsonl'), text);
    redactArtifacts(dir);
    expect(readFileSync(join(dir, 'trajectory.jsonl'), 'utf8')).toBe(text);
  });
});

describe('reading a long file', () => {
  const file = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

  it('truncation keeps the HEAD of a file (it used to keep the tail) and says more follows', () => {
    const cut = truncate(file, 50, 'head');
    expect(cut.startsWith('line 1\nline 2\n')).toBe(true);
    expect(cut).toMatch(/truncated: \d+ more chars follow/);
    // A command's output still keeps its tail, where the error is.
    expect(truncate(file, 50).endsWith('line 100')).toBe(true);
    expect(truncate('short', 50, 'head')).toBe('short');
  });

  it('offset and limit select lines, and say which', () => {
    expect(sliceLines(file)).toBe(file);
    expect(sliceLines(`${file}\n`, 10, 3)).toBe('line 10\nline 11\nline 12\n[lines 10–12 of 100]');
    expect(sliceLines(file, 99)).toBe('line 99\nline 100\n[lines 99–100 of 100]');
    expect(sliceLines(file, undefined, 2)).toBe('line 1\nline 2\n[lines 1–2 of 100]');
    expect(sliceLines(file, 500, 5)).toBe('[no line 500: the file has 100 line(s)]');
  });
});
