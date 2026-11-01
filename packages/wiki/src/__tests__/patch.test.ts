import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWiki } from '../load';
import {
  type FilePatchOp,
  PatchError,
  applyFilePatches,
  applyMaintainerOutput,
  applyOps,
  applyProposerPatch,
  writeChangeset,
} from '../patch';
import { PATTERN_HYPOTHESIS, goodFiles, writeTree } from './fixtures';

// Vision 08 §9: exact-substring, exactly-once targets; whole outputs atomic; proposer edits
// contained in their target. Acceptance rows: 13 §2.2 "Patch application".

describe('applyOps', () => {
  it('applies append, replace and insert_after on single occurrences, in order', () => {
    const out = applyOps('alpha beta gamma', [
      { op: 'replace', target: 'beta', text: 'BETA' },
      { op: 'insert_after', target: 'alpha', text: ',' },
      { op: 'append', text: '!' },
      // A later op sees the earlier ops' result.
      { op: 'replace', target: 'BETA', text: 'b' },
    ]);
    expect(out).toBe('alpha, b gamma!');
  });

  it.each([
    ['missing', 'zeta', /target "zeta" does not occur/],
    ['duplicated', 'a', /target "a" occurs 5 times/],
    // Overlapping occurrences count: "aa" occurs twice in "aaa".
    ['overlapping', 'aa', /occurs 2 times/],
  ])('refuses a %s target', (_n, target, msg) => {
    const text = target === 'aa' ? 'aaa' : 'alpha banana';
    expect(() => applyOps(text, [{ op: 'replace', target, text: 'x' }])).toThrow(PatchError);
    expect(() => applyOps(text, [{ op: 'insert_after', target, text: 'x' }])).toThrow(msg);
  });

  it('names the failing op', () => {
    const ops = [
      { op: 'append' as const, text: 'x' },
      { op: 'replace' as const, target: 'nope', text: 'y' },
    ];
    expect(() => applyOps('abc', ops)).toThrow(/^op 1: /);
  });
});

const NOW = new Date('2026-11-01T12:00:00.000Z');

function output(over: Record<string, unknown> = {}) {
  return {
    create_pages: [
      {
        id: 'patterns/new-lesson',
        content: PATTERN_HYPOTHESIS.replace('pattern/maybe-cause', 'pattern/new-lesson').replace(
          'A suspected cause',
          'A new lesson',
        ),
      },
    ],
    update_pages: [
      {
        id: 'pattern/maybe-cause',
        ops: [{ op: 'replace', target: 'Something drifts', text: 'Config drifts' }],
      },
    ],
    update_index: '- [A suspected cause](patterns/maybe-cause.md) — maintainer wording\n',
    append_log: 'Created pattern/new-lesson; reworded pattern/maybe-cause.',
    ...over,
  };
}

const snapshot = (root: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const abs = join(d.parentPath, d.name);
        return [abs.slice(root.length + 1), readFileSync(abs, 'utf8')];
      }),
  );

describe('applyMaintainerOutput', () => {
  it('builds a changeset with pages, a reconciled index and a log entry', () => {
    const root = writeTree(goodFiles());
    const result = applyMaintainerOutput(loadWiki(root), output(), {
      actor: 'maintainer:m',
      now: NOW,
    });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const byPath = Object.fromEntries(result.changeset.writes.map((w) => [w.path, w.content]));
    expect(Object.keys(byPath).sort()).toEqual([
      'index.md',
      'log.md',
      'patterns/maybe-cause.md',
      'patterns/new-lesson.md',
    ]);
    expect(byPath['patterns/maybe-cause.md']).toContain('Config drifts between environments');
    // The submitted wording is kept; pages the submission forgot are added with generated lines.
    expect(byPath['index.md']).toContain('(patterns/maybe-cause.md) — maintainer wording');
    expect(byPath['index.md']).toContain('[A new lesson](patterns/new-lesson.md)');
    expect(result.indexCorrections).toContain('added patterns/new-lesson.md');
    expect(byPath['log.md']).toMatch(
      /\n## 2026-11-01T12:00:00\.000Z — maintainer:m — ingest\nCreated pattern\/new-lesson; reworded pattern\/maybe-cause\.\nindex corrections: added /,
    );

    writeChangeset(root, result.changeset);
    const after = loadWiki(root);
    expect(after.pages.get('pattern/new-lesson')?.frontmatter.title).toBe('A new lesson');
  });

  it('drops a submitted index line for a page that does not exist', () => {
    const wiki = loadWiki(writeTree(goodFiles()));
    const out = output({ update_index: '- [Ghost](patterns/ghost.md) — x\n' });
    const result = applyMaintainerOutput(wiki, out, { actor: 'maintainer:m', now: NOW });
    expect(result.ok && result.indexCorrections).toContain(
      'dropped patterns/ghost.md (no such page)',
    );
  });

  it('is atomic: when the third op fails, nothing is returned and no file changes', () => {
    const root = writeTree(goodFiles());
    const before = snapshot(root);
    const out = output({
      update_pages: [
        { id: 'pattern/maybe-cause', ops: [{ op: 'append', text: '\nmore\n' }] },
        {
          id: 'decision/never-pause',
          ops: [{ op: 'replace', target: 'unattended', text: 'alone' }],
        },
        { id: 'contract/c1-identity', ops: [{ op: 'replace', target: 'not there', text: 'x' }] },
      ],
    });
    const result = applyMaintainerOutput(loadWiki(root), out, { actor: 'maintainer:m', now: NOW });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([
      'update_pages.2 (contract/c1-identity): op 0: replace target "not there" does not occur; it must occur exactly once',
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ['an invalid output', { update_index: '' }, /update_index/],
    [
      'a create of an existing page',
      {
        create_pages: [{ id: 'pattern/maybe-cause', content: PATTERN_HYPOTHESIS }],
        update_pages: [],
      },
      /already exists/,
    ],
    [
      'a create of a non-page id',
      { create_pages: [{ id: 'widget/x', content: 'x' }] },
      /not a page id/,
    ],
    [
      'a created page whose id is not its path',
      { create_pages: [{ id: 'pattern/elsewhere', content: PATTERN_HYPOTHESIS }] },
      /frontmatter id "pattern\/maybe-cause" is not pattern\/elsewhere/,
    ],
    [
      'an update of a missing page',
      { update_pages: [{ id: 'pattern/nope', ops: [{ op: 'append', text: 'x' }] }] },
      /does not exist/,
    ],
    [
      'an update that breaks the frontmatter',
      {
        update_pages: [
          {
            id: 'pattern/maybe-cause',
            ops: [{ op: 'replace', target: 'kind: failure', text: 'kind: oops' }],
          },
        ],
      },
      /kind/,
    ],
    [
      'a duplicated target',
      {
        update_pages: [
          { id: 'pattern/maybe-cause', ops: [{ op: 'replace', target: 'e', text: 'x' }] },
        ],
      },
      /occurs \d+ times/,
    ],
  ])('refuses %s', (_n, over, msg) => {
    const wiki = loadWiki(writeTree(goodFiles()));
    const result = applyMaintainerOutput(wiki, output(over), { actor: 'maintainer:m', now: NOW });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join('\n')).toMatch(msg);
  });

  it('refuses a maintainer-created confirmed page', () => {
    // A confirmed strategy is schema-valid (LR-05 binds failures only), so only the status rule bites.
    const confirmedStrategy = PATTERN_HYPOTHESIS.replace('pattern/maybe-cause', 'pattern/sure')
      .replace('status: hypothesis', 'status: confirmed')
      .replace('kind: failure', 'kind: strategy');
    const wiki = loadWiki(writeTree(goodFiles()));
    const out = output({ create_pages: [{ id: 'pattern/sure', content: confirmedStrategy }] });
    const result = applyMaintainerOutput(wiki, out, { actor: 'maintainer:m', now: NOW });
    expect(!result.ok && result.errors).toEqual([
      'create_pages.0: a maintainer creates pages as status: hypothesis',
    ]);
  });
});

describe('applyFilePatches', () => {
  function skillDir(): string {
    const root = writeTree({
      'skill/SKILL.md': '---\nname: s\nversion: "1"\n---\n## Rule\nDo the thing.\n',
      'skill/PURPOSE.md': '---\nskill: s\n---\n# Why\nBecause.\n',
      'outside.md': 'secret plans\n',
    });
    return join(root, 'skill');
  }

  const edits: FilePatchOp[] = [
    { op: 'replace', file: 'SKILL.md', target: 'Do the thing.', text: 'Do the right thing.' },
    { op: 'append', file: 'PURPOSE.md', text: 'Evidence: pattern/x.\n' },
    { op: 'insert_after', file: 'SKILL.md', target: 'the right thing.', text: ' Always.' },
  ];

  it('applies edits across files in order, as one changeset', () => {
    const dir = skillDir();
    const result = applyFilePatches(dir, edits);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    writeChangeset(dir, result.changeset);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Do the right thing. Always.');
    expect(readFileSync(join(dir, 'PURPOSE.md'), 'utf8')).toMatch(/Evidence: pattern\/x\.\n$/);
  });

  it('refuses everything when one edit fails', () => {
    const bad = [
      ...edits,
      { op: 'replace' as const, file: 'PURPOSE.md', target: 'absent', text: 'x' },
    ];
    const result = applyFilePatches(skillDir(), bad);
    expect(!result.ok && result.errors).toEqual([
      'edits.3 (PURPOSE.md): replace target "absent" does not occur; it must occur exactly once',
    ]);
  });

  it.each([
    ['a parent escape', '../outside.md', /is outside the target/],
    ['an absolute path', '/etc/passwd', /is outside the target/],
    ['the target itself', '.', /is outside the target/],
    ['a missing file', 'NEW.md', /does not exist/],
  ])('refuses %s', (_n, file, msg) => {
    const result = applyFilePatches(skillDir(), [{ op: 'append', file, text: 'x' }]);
    expect(!result.ok && result.errors.join('\n')).toMatch(msg);
  });

  it('refuses a symlink that leads outside the target', () => {
    const dir = skillDir();
    symlinkSync(join(dir, '..', 'outside.md'), join(dir, 'link.md'));
    const result = applyFilePatches(dir, [{ op: 'append', file: 'link.md', text: 'x' }]);
    expect(!result.ok && result.errors).toEqual(['edits.0 (link.md): resolves outside the target']);
  });

  it('validates a proposer output before applying it', () => {
    const dir = skillDir();
    const patch = { action: 'patch', outlet: 'skill', name: 's', edits, patterns: ['pattern/x'] };
    expect(applyProposerPatch(dir, patch).ok).toBe(true);
    // The schema itself refuses a `..` path, before containment is even checked.
    const escaping = { ...patch, edits: [{ op: 'append', file: '../outside.md', text: 'x' }] };
    expect(applyProposerPatch(dir, escaping).ok).toBe(false);
    const issue = { action: 'no_action', reason: 'nothing' };
    expect(applyProposerPatch(dir, issue)).toEqual({
      ok: false,
      errors: ['action "no_action" carries no file edits'],
    });
  });
});

describe('writeChangeset', () => {
  it('creates directories and refuses a path outside the root, writing nothing', () => {
    const root = writeTree({ 'a.md': 'a\n' });
    writeChangeset(root, { writes: [{ path: 'deep/new/b.md', content: 'b\n' }] });
    expect(readFileSync(join(root, 'deep/new/b.md'), 'utf8')).toBe('b\n');
    const before = snapshot(root);
    expect(() =>
      writeChangeset(root, {
        writes: [
          { path: 'a.md', content: 'changed\n' },
          { path: '../escape.md', content: 'x' },
        ],
      }),
    ).toThrow(/outside/);
    expect(snapshot(root)).toEqual(before);
  });

  it('leaves no staging files behind when a write fails', () => {
    const root = writeTree({ 'a.md': 'a\n' });
    writeFileSync(join(root, 'blocker'), 'x');
    expect(() =>
      writeChangeset(root, {
        writes: [
          { path: 'a.md', content: 'changed\n' },
          { path: 'blocker/inside.md', content: 'x' },
        ],
      }),
    ).toThrow();
    expect(readdirSync(root).filter((n) => n.startsWith('.gl-tmp-'))).toEqual([]);
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('a\n');
  });
});
