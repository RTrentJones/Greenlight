import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { VerifyReport } from '@rtrentjones/greenlight-verify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type WikiIo, wikiCommand } from '../commands/wiki';
import { failingChecks, lookupSources, wikiBlockLines, wikiHitsFor } from '../wiki-hits';

// `wiki context`, `wiki lookup` and the failing-gate `wiki:` block, in a scratch wrapper with its
// own project wiki. The framework wiki is the repository's, read through `frameworkWikiDir()`.

let cwd: string;
let out: string[];
let err: string[];
let env: NodeJS.ProcessEnv;

const io = (): WikiIo => ({ cwd, env, out: (s) => out.push(s), err: (s) => err.push(s) });
const run = (...args: string[]) => wikiCommand(args, io());
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

const PATTERN = `---
id: pattern/og-image-missing
type: pattern
title: A share preview that points at an image nobody serves
updated: 2026-11-20
status: confirmed
kind: failure
class: proxy-check
atRisk: the share preview
cells: ["astro/workers/*"]
relevance: app-code
evidence:
  - issue:acme/site#3
catches:
  description: the image the meta tag names is fetched and is a PNG
  checkSignature: "^og-(png|meta)$"
remediation:
  - { outlet: verify, ref: "og-png", verified: true }
skills: []
---
## Symptom
Links unfurl with no image.

## Fix / workaround
Serve the file the meta tag names, and check its content type.
`;

const INTENT = `---
id: intent/pinboard
type: intent
title: Pinboard — intent
updated: 2026-11-20
status: confirmed
tool: pinboard
criteria:
  - { id: AC-1, text: "Share previews work", source: kickoff, added: 2026-11-20, checks: [og-png] }
---
A page of pins.
`;

const LIVENESS = `---
id: liveness/pinboard
type: liveness
title: Pinboard — liveness
updated: 2026-11-20
status: confirmed
tool: pinboard
model: always-on
atRisk: nothing idles
quotas: []
---
Static assets.
`;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gl-wiki-lookup-'));
  out = [];
  err = [];
  env = { GREENLIGHT_NO_GH: '1' };
  write('wiki/patterns/og-image-missing.md', PATTERN);
  write('wiki/tools/pinboard/intent.md', INTENT);
  write('wiki/tools/pinboard/liveness.md', LIVENESS);
  write(
    'greenlight.config.mjs',
    `export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [{ name: 'pinboard', lane: 'astro', target: 'workers', data: 'none', auth: 'none', access: 'public', envs: ['beta', 'prod'] }],
};
`,
  );
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('wiki context', () => {
  it('prints the tool pages, the manifest entry and the patterns for its cell', async () => {
    expect(await run('context', 'pinboard')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('A page of pins.');
    expect(text).toContain('Static assets.');
    expect(text).toContain('"lane": "astro"');
    expect(text).toContain('pattern/og-image-missing');
    expect(text).toContain('confirmed patterns for astro/workers/none');
    expect(text).not.toContain('no project wiki');
    expect(text).not.toMatch(/incident\//);
  });

  it('gives the same bundle as JSON, and through lookup --tool --start', async () => {
    expect(await run('context', 'pinboard', '--json')).toBe(0);
    const direct = JSON.parse(out.at(-1) as string);
    expect(Object.keys(direct)).toEqual(
      expect.arrayContaining(['intent', 'liveness', 'decisions', 'manifest', 'alerts']),
    );
    expect(direct.decisions).toBeNull();
    expect(direct.manifest.target).toBe('workers');
    expect(direct.patterns.map((p: { id: string }) => p.id)).toContain('pattern/og-image-missing');
    out = [];
    expect(await run('lookup', '--tool', 'pinboard', '--start', '--json')).toBe(0);
    expect(JSON.parse(out.at(-1) as string)).toEqual(direct);
  });

  it('never blocks: a tool with no pages gets a notice and exit 0', async () => {
    expect(await run('context', 'unwritten')).toBe(0);
    expect(out.join('\n')).toContain(
      'no project wiki for unwritten: run greenlight wiki lint --fix to stub it',
    );
  });

  it('prints nothing when the wiki is switched off', async () => {
    env.GREENLIGHT_WIKI = 'off';
    expect(await run('context', 'pinboard')).toBe(0);
    expect(await run('lookup', '--check', 'og-png')).toBe(0);
    expect(out).toEqual([]);
  });
});

describe('wiki lookup', () => {
  it('returns the fix for a failing check, with the tool’s liveness line', async () => {
    expect(await run('lookup', '--check', 'og-png', '--tool', 'pinboard')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('liveness: always-on — at risk: nothing idles');
    expect(text).toContain(
      'pattern/og-image-missing (score 4) — wiki/patterns/og-image-missing.md',
    );
    expect(text).toContain('Serve the file the meta tag names');
  });

  it('accepts several checks and prints JSON hits', async () => {
    expect(await run('lookup', '--check', 'og-png', '--check', 'og-meta', '--json')).toBe(0);
    const { hits } = JSON.parse(out.at(-1) as string);
    expect(hits[0]).toMatchObject({
      id: 'pattern/og-image-missing',
      score: 6,
      path: 'wiki/patterns/og-image-missing.md',
    });
    expect(hits[0].fix).toContain('Serve the file');
  });

  it('says so when nothing matches, and refuses a bad command line', async () => {
    expect(await run('lookup', '--check', 'no-such-check-anywhere')).toBe(0);
    expect(out.at(-1)).toBe('no confirmed pattern matches');
    expect(await run('lookup')).toBe(2);
    expect(await run('lookup', '--cell', 'astro')).toBe(2);
    expect(await run('lookup', '--start')).toBe(2);
    expect(await run('lookup', '--role', 'maintainer')).toBe(4);
  });

  it('reads a framework page the project wiki does not have', async () => {
    expect(await run('read', 'pattern/dcr-disabled-silently')).toBe(0);
    expect(out.join('\n')).toContain('id: pattern/dcr-disabled-silently');
  });
});

describe('the wiki: block of a failing gate', () => {
  const report = (checks: VerifyReport['checks']): VerifyReport => ({
    pass: checks.every((c) => c.pass),
    mode: 'api',
    url: 'http://localhost:4321',
    checks,
  });
  const failing = [
    report([
      { name: 'GET /og.png is a PNG', id: 'og-png', pass: false },
      { name: 'GET / 200', id: 'home', pass: true },
    ]),
  ];

  it('collects the ids and names of failing checks only', () => {
    expect(failingChecks(failing)).toEqual(['og-png', 'GET /og.png is a PNG']);
  });

  it('names the matching confirmed pattern and where to read it', () => {
    const hits = wikiHitsFor(failing, { cwd, env });
    expect(hits.map((h) => h.id)).toEqual(['pattern/og-image-missing']);
    expect(wikiBlockLines(hits)).toEqual([
      '',
      'wiki: read these before changing anything',
      '  see: pattern/og-image-missing — A share preview that points at an image nobody serves (wiki/patterns/og-image-missing.md)',
    ]);
  });

  it('is empty for a passing run, an unmatched failure, or a switched-off wiki', () => {
    expect(wikiHitsFor([report([{ name: 'x', id: 'og-png', pass: true }])], { cwd, env })).toEqual(
      [],
    );
    expect(wikiHitsFor([report([{ name: 'x', id: 'zzz', pass: false }])], { cwd, env })).toEqual(
      [],
    );
    expect(wikiHitsFor(failing, { cwd, env: { GREENLIGHT_WIKI: 'off' } })).toEqual([]);
    expect(wikiBlockLines([])).toEqual([]);
  });

  it('reads the project wiki first and the framework wiki second', () => {
    expect(lookupSources(cwd).map((s) => s.origin)).toEqual(['project', 'framework']);
  });
});
