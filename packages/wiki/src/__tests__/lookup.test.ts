import { describe, expect, it } from 'vitest';
import { wikiFromFiles } from '../load';
import {
  cellMatches,
  failureLinks,
  livenessSummary,
  lookupPatterns,
  sectionOf,
  toolContext,
  versionInRange,
} from '../lookup';

interface P {
  slug: string;
  status?: 'confirmed' | 'hypothesis' | 'superseded';
  supersededBy?: string;
  signature?: string;
  cls?: string;
  cells?: string[];
  affects?: string;
  relevance?: 'framework-version' | 'app-code' | 'both';
  updated?: string;
  fix?: string;
}

const pattern = (p: P): [string, string] => [
  `patterns/${p.slug}.md`,
  `---
id: pattern/${p.slug}
type: pattern
title: Title of ${p.slug}
updated: ${p.updated ?? '2026-11-01'}
status: ${p.status ?? 'confirmed'}
${p.supersededBy ? `supersededBy: ${p.supersededBy}\n` : ''}kind: failure
class: ${p.cls ?? 'proxy-check'}
atRisk: the store
cells: ${JSON.stringify(p.cells ?? ['*/*/*'])}
${p.affects ? `affects: "${p.affects}"\n` : ''}relevance: ${p.relevance ?? 'app-code'}
evidence:
  - issue:owner/tool#1
catches:
  description: the check that catches it
${p.signature ? `  checkSignature: "${p.signature}"\n` : ''}remediation:
  - { outlet: mechanism, ref: "pr:owner/tool#2", verified: true }
skills: []
---
## Symptom
It broke.

## Fix / workaround
${p.fix ?? `Fix for ${p.slug}.`}

## How it is caught
By a check.
`,
];

const wiki = (...pages: P[]) => wikiFromFiles('/w', new Map(pages.map(pattern)));
const project = (...pages: P[]) => [{ wiki: wiki(...pages), origin: 'project' as const }];
const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

describe('versionInRange', () => {
  it('reads comparators, conjunctions and alternatives', () => {
    expect(versionInRange('0.10.0', '<0.10.1')).toBe(true);
    expect(versionInRange('0.10.1', '<0.10.1')).toBe(false);
    expect(versionInRange('0.9.3', '>=0.8.0 <0.10.0')).toBe(true);
    expect(versionInRange('0.11.0', '>=0.8.0 <0.10.0')).toBe(false);
    expect(versionInRange('0.11.0', '<0.8.0 || >=0.11.0')).toBe(true);
    expect(versionInRange('0.11.0', '*')).toBe(true);
    expect(versionInRange('v0.11.0', '0.11.0')).toBe(true);
  });

  it('shows a page whose range or version cannot be read', () => {
    expect(versionInRange(undefined, '<0.1.0')).toBe(true);
    expect(versionInRange('0.11.0', undefined)).toBe(true);
    expect(versionInRange('0.11.0', '<nonsense')).toBe(true);
    expect(versionInRange('workspace', '<0.1.0')).toBe(true);
  });
});

describe('cellMatches', () => {
  it('matches segment by segment with wildcards on either side', () => {
    expect(cellMatches('*/*/supabase', 'next/vercel/supabase')).toBe(true);
    expect(cellMatches('mcp/oci/*', 'mcp/oci/none')).toBe(true);
    expect(cellMatches('mcp/oci/*', 'next/vercel/none')).toBe(false);
    expect(cellMatches('next/vercel/none', 'next/*/none')).toBe(true);
    expect(cellMatches('next/vercel', 'next/vercel/none')).toBe(false);
  });
});

describe('lookupPatterns', () => {
  it('scores 3 per matching check, 2 for the class and 1 for the cell', () => {
    const hits = lookupPatterns(
      project(
        { slug: 'both-checks', signature: 'identity|og-png' },
        { slug: 'class-and-cell', cls: 'env-drift', cells: ['next/*/*'] },
        { slug: 'cell-only', cells: ['next/vercel/*'] },
        { slug: 'unrelated', cells: ['mcp/oci/*'], cls: 'iac-hazard' },
      ),
      { checks: ['identity', 'og-png'], class: 'env-drift', cell: 'next/vercel/none' },
    );
    expect(hits.map((h) => [h.id, h.score])).toEqual([
      ['pattern/both-checks', 7],
      ['pattern/class-and-cell', 3],
      ['pattern/cell-only', 1],
    ]);
    expect(hits[0]?.fix).toBe('Fix for both-checks.');
    expect(hits[0]?.path).toBe('patterns/both-checks.md');
  });

  it('breaks ties by the most recent update and returns at most five', () => {
    const pages = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug, i) => ({
      slug,
      signature: 'x',
      updated: `2026-11-0${i + 1}`,
    }));
    const hits = lookupPatterns(project(...pages), { checks: ['x'] });
    expect(ids(hits)).toEqual(['f', 'e', 'd', 'c', 'b'].map((s) => `pattern/${s}`));
  });

  it('never returns a hypothesis unless asked, and never an incident', () => {
    const w = wiki({ slug: 'guess', status: 'hypothesis', signature: 'x' });
    const guess = w.pages.get('pattern/guess');
    if (!guess) throw new Error('fixture page missing');
    w.pages.set('incident/2026-01-x', {
      ...guess,
      id: 'incident/2026-01-x',
      frontmatter: { ...guess.frontmatter, type: 'incident' } as never,
    });
    const src = [{ wiki: w, origin: 'project' as const }];
    expect(lookupPatterns(src, { checks: ['x'] })).toEqual([]);
    const asked = lookupPatterns(src, { checks: ['x'], includeHypothesis: true });
    expect(asked.map((h) => [h.id, h.status])).toEqual([['pattern/guess', 'hypothesis']]);
  });

  it('replaces a superseded match with the page that superseded it', () => {
    const hits = lookupPatterns(
      project(
        { slug: 'old', status: 'superseded', supersededBy: 'pattern/new', signature: 'probe' },
        { slug: 'new', signature: 'something-else' },
      ),
      { checks: ['probe'] },
    );
    expect(hits.map((h) => [h.id, h.replaces, h.score])).toEqual([
      ['pattern/new', 'pattern/old', 3],
    ]);
    // A chain that ends nowhere, or loops, yields nothing rather than a dead page.
    const broken = project(
      { slug: 'a', status: 'superseded', supersededBy: 'pattern/b', signature: 'probe' },
      { slug: 'b', status: 'superseded', supersededBy: 'pattern/a' },
    );
    expect(lookupPatterns(broken, { checks: ['probe'] })).toEqual([]);
  });

  it('applies affects and relevance to the installed version (04 §6)', () => {
    const src = project(
      { slug: 'fw-fixed', signature: 'x', relevance: 'framework-version', affects: '<0.10.0' },
      { slug: 'fw-live', signature: 'x', relevance: 'framework-version', affects: '<0.12.0' },
      { slug: 'app', signature: 'x', relevance: 'app-code', affects: '<0.10.0' },
      { slug: 'both-fixed', signature: 'x', relevance: 'both', affects: '<0.10.0' },
      { slug: 'both-live', signature: 'x', relevance: 'both', affects: '<0.12.0' },
    );
    const hits = lookupPatterns(src, { checks: ['x'], installed: '0.11.0' });
    const note = Object.fromEntries(hits.map((h) => [h.id.slice(8), h.note]));
    expect(Object.keys(note).sort()).toEqual(['app', 'both-fixed', 'both-live', 'fw-live']);
    expect(note['fw-live']).toContain('upgrade fixes this');
    expect(note.app).toBeUndefined();
    expect(note['both-fixed']).toContain('app-code half only');
    expect(note['both-live']).toContain('upgrade fixes the framework half');
    // With no installed version nothing is hidden.
    expect(lookupPatterns(src, { checks: ['x'] })).toHaveLength(5);
  });

  it('lets a project page shadow a framework page with the same id', () => {
    const hits = lookupPatterns(
      [
        { wiki: wiki({ slug: 'same', signature: 'x', fix: 'project fix' }), origin: 'project' },
        {
          wiki: wiki(
            { slug: 'same', signature: 'x', fix: 'framework fix' },
            { slug: 'fw', signature: 'x' },
          ),
          origin: 'framework',
        },
      ],
      { checks: ['x'] },
    );
    expect(hits.map((h) => [h.id, h.origin, h.fix])).toEqual([
      ['pattern/fw', 'framework', 'Fix for fw.'],
      ['pattern/same', 'project', 'project fix'],
    ]);
  });

  it('treats an unreadable signature as a literal', () => {
    const src = project({ slug: 'bad', signature: '(' });
    expect(lookupPatterns(src, { checks: ['('] })).toHaveLength(1);
    expect(lookupPatterns(src, { checks: ['x'] })).toEqual([]);
  });
});

describe('failureLinks', () => {
  it('links only pages whose signature matches a failing check', () => {
    const src = project({ slug: 'id', signature: 'identity|__version' }, { slug: 'other' });
    expect(ids(failureLinks(src, ['GET /__version', 'rss-valid']))).toEqual(['pattern/id']);
    expect(failureLinks(src, [])).toEqual([]);
  });
});

describe('toolContext', () => {
  const files = new Map([
    pattern({ slug: 'for-cell', cells: ['next/vercel/*'] }),
    pattern({ slug: 'other-cell', cells: ['mcp/oci/*'] }),
    pattern({ slug: 'guess', status: 'hypothesis' }),
    [
      'tools/app/intent.md',
      '---\nid: intent/app\ntype: intent\ntitle: App — intent\nupdated: 2026-11-01\nstatus: confirmed\ntool: app\ncriteria: []\n---\nWhat it is for.\n',
    ],
    [
      'tools/app/liveness.md',
      '---\nid: liveness/app\ntype: liveness\ntitle: App — liveness\nupdated: 2026-11-01\nstatus: confirmed\ntool: app\nmodel: needs-traffic\natRisk: the idle timer\nprobe: /rest/v1/probe\nquotas: []\n---\nKeep it awake.\n',
    ],
    [
      'tools/app/decisions.md',
      `---\nid: tool-decisions/app\ntype: tool-decisions\ntitle: App — decisions\nupdated: 2026-11-01\nstatus: confirmed\ntool: app\n---\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n`,
    ],
  ] as [string, string][]);
  const w = wikiFromFiles('/w', files);

  it('bundles the tool pages, the head of the decisions and the patterns for the cell', () => {
    const ctx = toolContext(w, undefined, 'app', { cell: 'next/vercel/supabase' });
    expect(ctx.hasPages).toBe(true);
    expect(ctx.intent).toContain('What it is for.');
    expect(ctx.liveness).toContain('Keep it awake.');
    expect(ctx.decisions?.split('\n')).toHaveLength(40);
    expect(ctx.livenessSummary).toBe(
      'liveness: needs-traffic — at risk: the idle timer — probe: /rest/v1/probe',
    );
    expect(ctx.patterns.map((p) => p.id)).toEqual(['pattern/for-cell']);
  });

  it('reports a tool with no pages without failing', () => {
    const ctx = toolContext(w, undefined, 'unknown', { cell: 'mcp/oci/none' });
    expect(ctx.hasPages).toBe(false);
    expect(ctx.patterns.map((p) => p.id)).toEqual(['pattern/other-cell']);
    expect(livenessSummary(w, 'unknown')).toBeUndefined();
    expect(toolContext(undefined, undefined, 'x').patterns).toEqual([]);
  });
});

describe('sectionOf', () => {
  it('returns one section without its heading', () => {
    expect(
      sectionOf('## A\none\n\n## Fix / workaround\ntwo\nthree\n\n## C\nfour\n', 'Fix / workaround'),
    ).toBe('two\nthree');
    expect(sectionOf('## A\none\n', 'Fix / workaround')).toBe('');
  });
});
