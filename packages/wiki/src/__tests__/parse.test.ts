import { describe, expect, it } from 'vitest';
import { idToPath, isArchivedPath, normalizeId, pathToId, resolveId, resolveLink } from '../ids';
import { PageParseError, parsePage, serializePage } from '../parse';
import { DECISION, INTENT, PATTERN_CONFIRMED } from './fixtures';

// Vision 03 §3 parse.ts / ids.ts; 04 §2.1 id normalization; 13 §2.2 round-trip byte stability.

describe('parsePage / serializePage', () => {
  it.each([
    ['a pattern with YAML comments and flow maps', PATTERN_CONFIRMED],
    ['a decision', DECISION],
    ['a CRLF page', DECISION.replace(/\n/g, '\r\n')],
    ['a page with no trailing newline', DECISION.trimEnd()],
    [
      'a page whose body is empty and has no final newline',
      `${INTENT.split('---\n').slice(0, 2).join('---\n')}---`,
    ],
    ['a body with odd whitespace', `${INTENT}\n\n  trailing spaces   \n\t\n`],
  ])('round-trips %s byte for byte', (_name, text) => {
    const page = parsePage('p.md', text);
    expect(serializePage(page)).toBe(text);
    expect(page.frontmatterBlock + page.body).toBe(text);
    expect(page.raw).toBe(text);
  });

  it('keeps the body exactly, separator lines included', () => {
    const page = parsePage('decisions/never-pause.md', DECISION);
    expect(page.body).toBe(
      'A content site must stay up unattended. It never depends on a store that pauses.\n',
    );
    expect(page.frontmatter).toMatchObject({ id: 'decision/never-pause', decided: '2026-01-01' });
  });

  it('re-emits the frontmatter when a value changed, and the result parses back', () => {
    const page = parsePage('p.md', PATTERN_CONFIRMED);
    const changed = { ...page, frontmatter: { ...page.frontmatter, title: 'Renamed' } };
    const text = serializePage(changed);
    expect(text).not.toContain('# what idles');
    expect(text.endsWith(page.body)).toBe(true);
    const again = parsePage('p.md', text);
    expect(again.frontmatter).toEqual(changed.frontmatter);
    expect(serializePage(again)).toBe(text);
  });

  it('serializes a page built without an original block', () => {
    const { frontmatter, body } = parsePage('p.md', DECISION);
    expect(parsePage('p.md', serializePage({ frontmatter, body })).frontmatter).toEqual(
      frontmatter,
    );
  });

  it.each([
    ['no frontmatter', '# Title\n', /must start with a "---" YAML frontmatter block/],
    ['an unclosed block', '---\nid: decision/x\n', /must start with a "---"/],
    ['invalid YAML', '---\nid: [x\n---\n', /not valid YAML/],
    [
      'a duplicate key',
      DECISION.replace('title:', 'title: one\ntitle:'),
      /not valid YAML.*[Uu]nique|not valid YAML/,
    ],
    ['an unknown key', DECISION.replace('scope:', 'colour: red\nscope:'), /Unrecognized key/],
    ['an empty block', '---\n---\nbody\n', /type/],
  ])('refuses %s, naming the file', (_name, text, msg) => {
    expect(() => parsePage('decisions/x.md', text)).toThrow(PageParseError);
    expect(() => parsePage('decisions/x.md', text)).toThrow(/^decisions\/x\.md: /);
    expect(() => parsePage('decisions/x.md', text)).toThrow(msg);
  });

  it('reports schema issues with their JSON path', () => {
    try {
      parsePage('patterns/x.md', PATTERN_CONFIRMED.replace('verified: true', 'verified: yes'));
      expect.unreachable();
    } catch (err) {
      expect((err as PageParseError).issues.map((i) => i.path)).toContain('remediation.0.verified');
    }
  });
});

describe('ids', () => {
  it.each([
    ['patterns/keepalive.md', 'pattern/keepalive'],
    ['facts/neon-free.md', 'fact/neon-free'],
    ['decisions/lockstep.md', 'decision/lockstep'],
    ['incidents/2026-08-paused.md', 'incident/2026-08-paused'],
    ['contract/c1-identity.md', 'contract/c1-identity'],
    ['tools/blog/intent.md', 'intent/blog'],
    ['tools/blog/liveness.md', 'liveness/blog'],
    ['tools/blog/decisions.md', 'tool-decisions/blog'],
    ['tools/blog/incidents/2026-08-x.md', 'incident/blog/2026-08-x'],
    ['archive/patterns/old.md', 'pattern/old'],
  ])('maps %s ↔ %s', (path, id) => {
    expect(pathToId(path)).toBe(id);
    expect(idToPath(id, { archived: isArchivedPath(path) })).toBe(path);
  });

  it.each([
    'index.md',
    'log.md',
    'skill-impact.md',
    'portfolio.md',
    'proposals/x.md',
    'ledger.jsonl',
    'tools/blog/notes.md',
    'patterns.md',
  ])('%s is not a page', (path) => expect(pathToId(path)).toBeUndefined());

  it.each([
    ['patterns/x', 'pattern/x'],
    ['pattern/x', 'pattern/x'],
    ['wiki/patterns/x.md', 'pattern/x'],
    ['./patterns/x.md', 'pattern/x'],
    ['fact/neon-free#compute-hours', 'fact/neon-free'],
    ['tools/demo/intent.md', 'intent/demo'],
    ['intent/demo', 'intent/demo'],
  ])('normalizes %s to %s', (ref, id) => expect(normalizeId(ref)).toBe(id));

  it('refuses to map a non-page id to a path', () => {
    expect(() => idToPath('widget/x')).toThrow(/not a page id/);
    expect(() => idToPath('pattern')).toThrow(/not a page id/);
  });

  it('resolves either spelling against a wiki', () => {
    const wiki = { pages: new Map([['pattern/x', 'X']]) };
    expect(resolveId(wiki, 'patterns/x')).toBe('X');
    expect(resolveId(wiki, 'pattern/x')).toBe('X');
    expect(resolveId(wiki, 'pattern/y')).toBeUndefined();
  });

  it('resolves relative links from a page', () => {
    expect(resolveLink('patterns/a.md', '../decisions/b.md#why')).toBe('decisions/b.md');
    expect(resolveLink('patterns/a.md', 'c.md')).toBe('patterns/c.md');
    expect(resolveLink('patterns/a.md', '../../docs/x.md')).toBe('../docs/x.md');
  });
});
