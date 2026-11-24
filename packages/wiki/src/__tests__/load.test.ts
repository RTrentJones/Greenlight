import { describe, expect, it } from 'vitest';
import { loadWiki, withWrites } from '../load';
import { DECISION, goodFiles, ledgerEvents, writeTree } from './fixtures';

// Vision 03 §3 load.ts: pages by id, index, log, ledger; bad content recorded, never thrown.

describe('loadWiki', () => {
  it('loads pages by canonical id, plus index, log and ledger', () => {
    const wiki = loadWiki(writeTree(goodFiles()));
    expect([...wiki.pages.keys()].sort()).toEqual([
      'contract/c1-identity',
      'decision/never-pause',
      'intent/demo',
      'pattern/maybe-cause',
      'pattern/old-probe',
      'pattern/probe-cached',
      'pattern/retired',
    ]);
    expect(wiki.pages.get('pattern/retired')).toMatchObject({
      path: 'archive/patterns/retired.md',
      archived: true,
    });
    expect(wiki.pages.get('pattern/probe-cached')?.archived).toBe(false);
    expect(wiki.index).toContain('## pattern');
    expect(wiki.log).toContain('— harness — seed');
    expect(wiki.ledger).toEqual(ledgerEvents());
    expect(wiki.pageErrors).toEqual([]);
    expect(wiki.ledgerErrors).toEqual([]);
  });

  it('records a page that fails to parse and keeps loading the rest', () => {
    const wiki = loadWiki(writeTree({ ...goodFiles(), 'decisions/bad.md': 'no frontmatter\n' }));
    expect(wiki.pageErrors).toEqual([
      expect.objectContaining({ path: 'decisions/bad.md', kind: 'parse' }),
    ]);
    expect(wiki.pages.has('decision/never-pause')).toBe(true);
    expect(wiki.files.get('decisions/bad.md')).toBe('no frontmatter\n');
  });

  it('skips dot-directories and keeps non-text files only as paths', () => {
    const wiki = loadWiki(
      writeTree({
        '.cache/patterns/x.md': 'junk',
        'img/probe.png': 'png',
        'decisions/a.md': DECISION.replace('never-pause', 'a'),
      }),
    );
    expect(wiki.paths.has('img/probe.png')).toBe(true);
    expect(wiki.files.has('img/probe.png')).toBe(false);
    expect([...wiki.paths].some((p) => p.startsWith('.cache'))).toBe(false);
    expect(wiki.pages.has('decision/a')).toBe(true);
  });

  it('builds a scratch copy with writes applied, leaving the original untouched', () => {
    const wiki = loadWiki(writeTree(goodFiles()));
    const next = withWrites(wiki, [
      { path: 'decisions/b.md', content: DECISION.replace('never-pause', 'b') },
    ]);
    expect(next.pages.has('decision/b')).toBe(true);
    expect(wiki.pages.has('decision/b')).toBe(false);
  });
});
