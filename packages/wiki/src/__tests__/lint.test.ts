import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateIndex } from '../index-gen';
import { renderSkillImpact } from '../ledger';
import { type LintContext, type RuleId, fix, fixInMemory, lint, lintExitCode } from '../lint';
import { loadWiki } from '../load';
import { writeChangeset } from '../patch';
import { type LedgerEvent, sealEvent } from '../schema';
import {
  type Files,
  OWNER_DOMAIN,
  OWNER_TOOL,
  PATTERN_CONFIRMED,
  PATTERN_HYPOTHESIS,
  goodContext,
  goodFiles,
  ledgerEvents,
  ledgerText,
  loadTree,
  writeTree,
} from './fixtures';

// Vision 04 §5 / 13 §2.2: each implemented rule has a passing and a failing fixture; the test
// asserts the rule id, severity and exit code.

type Case = {
  name: string;
  files?: (f: Files) => Files;
  ctx?: (c: LintContext) => LintContext;
};

const edit =
  (path: string, from: string, to: string) =>
  (f: Files): Files => {
    const text = f[path] ?? '';
    if (!text.includes(from)) throw new Error(`fixture: ${from} not in ${path}`);
    return { ...f, [path]: text.replace(from, to) };
  };

const BAD: Record<RuleId, Case[]> = {
  'LR-01': [
    {
      name: 'unknown frontmatter key',
      files: edit('patterns/maybe-cause.md', 'kind: failure', 'kind: failure\nseverity: high'),
    },
    {
      name: 'invalid YAML',
      files: edit('patterns/maybe-cause.md', 'title: A suspected cause', 'title: [unclosed'),
    },
    {
      name: 'no frontmatter',
      files: (f) => ({ ...f, 'patterns/maybe-cause.md': '# just prose\n' }),
    },
  ],
  'LR-02': [
    {
      name: 'id does not match path',
      files: edit('patterns/maybe-cause.md', 'id: pattern/maybe-cause', 'id: pattern/other-cause'),
    },
    {
      name: 'two files share one id',
      files: (f) => ({
        ...f,
        'archive/patterns/maybe-cause.md': f['patterns/maybe-cause.md'] ?? '',
      }),
    },
  ],
  'LR-03': [
    {
      name: 'broken relative link',
      files: edit(
        'patterns/probe-cached.md',
        '../decisions/never-pause.md',
        '../decisions/missing.md',
      ),
    },
    {
      name: 'malformed evidence ref',
      files: edit('patterns/maybe-cause.md', 'evidence: []', 'evidence: [ticket-55]'),
    },
  ],
  'LR-05': [
    {
      name: 'confirmed failure pattern without a verified remediation',
      files: (f) => ({
        ...f,
        'patterns/maybe-cause.md': PATTERN_HYPOTHESIS.replace(
          'status: hypothesis',
          'status: confirmed',
        ),
      }),
    },
  ],
  'LR-06': [
    {
      name: 'supersededBy names no page',
      files: edit(
        'patterns/old-probe.md',
        'supersededBy: pattern/probe-cached',
        'supersededBy: pattern/nowhere',
      ),
    },
    {
      name: 'supersededBy names an archived page',
      files: edit(
        'patterns/old-probe.md',
        'supersededBy: pattern/probe-cached',
        'supersededBy: pattern/retired',
      ),
    },
    {
      name: 'superseded without supersededBy',
      files: edit('patterns/old-probe.md', 'supersededBy: pattern/probe-cached\n', ''),
    },
  ],
  'LR-08': [
    {
      name: 'page missing from the index',
      files: (f) => ({
        ...f,
        'index.md': (f['index.md'] ?? '').replace(/^- \[A suspected cause\].*\n/m, ''),
      }),
    },
    {
      name: 'index line for no page',
      files: (f) => ({ ...f, 'index.md': `${f['index.md']}- [Ghost](patterns/ghost.md) — gone\n` }),
    },
    {
      name: 'index line for an archived page',
      files: (f) => ({
        ...f,
        'index.md': `${f['index.md']}- [Retired](archive/patterns/retired.md) — old\n`,
      }),
    },
    { name: 'no index', files: ({ 'index.md': _drop, ...f }) => f },
  ],
  'LR-11': [
    { name: 'cites a hypothesis', ctx: (c) => cite(c, 'pattern/maybe-cause') },
    { name: 'cites a missing page', ctx: (c) => cite(c, 'decision/nowhere') },
    { name: 'cites a non-citable type', ctx: (c) => cite(c, 'intent/demo') },
    { name: 'cited page lacks the back-link', ctx: (c) => cite(c, 'contract/c1-identity') },
  ],
  'LR-12': [
    {
      name: 'PURPOSE.md version differs from SKILL.md',
      ctx: (c) => ({ ...c, skills: c.skills?.map((s) => ({ ...s, version: '4' })) }),
    },
  ],
  'LR-14': [
    {
      name: 'a ledger line not written by the harness',
      files: (f) => ({
        ...f,
        'ledger.jsonl': `${f['ledger.jsonl']}{"writer":"human","stage":"merged"}\n`,
      }),
    },
    {
      name: 'a ledger line with a forged eventId',
      files: (f) => ({
        ...f,
        'ledger.jsonl': (f['ledger.jsonl'] ?? '').replace(
          '"stage":"merged"',
          '"stage":"released","release":"0.11.0"',
        ),
      }),
    },
    { name: 'stale skill-impact.md', files: edit('skill-impact.md', 'p-001', 'p-999') },
    { name: 'ledger without a render', files: ({ 'skill-impact.md': _drop, ...f }) => f },
    {
      // Rendered to match, so only the stage machine (06 §6.1) can fire.
      name: 'merged after candidate-rejected',
      files: (f) =>
        withLedger(f, [
          ...ledgerEvents(),
          sealEvent({ ts: '2026-10-06T09:00:00.000Z', proposalId: 'p-002', stage: 'merged' }),
        ]),
    },
    {
      name: 'a duplicated event line',
      files: (f) => withLedger(f, [...ledgerEvents(), ledgerEvents()[0] as LedgerEvent]),
    },
  ],
  'LR-19': [
    {
      name: 'prose names the domain',
      files: edit(
        'decisions/never-pause.md',
        'stay up unattended.',
        `stay up unattended at ${OWNER_DOMAIN}.`,
      ),
    },
    {
      name: 'title names a tool',
      files: edit(
        'patterns/maybe-cause.md',
        'title: A suspected cause',
        `title: A suspected ${OWNER_TOOL} cause`,
      ),
    },
    {
      name: 'prose names the email',
      files: edit(
        'contract/c1-identity.md',
        'Serve the build',
        'Mail owner@example.com. Serve the build',
      ),
    },
  ],
  'LR-20': [
    {
      name: 'a token in the log',
      files: edit('log.md', 'Seeded the wiki.', `Seeded with ${'ghp_'}${'x'.repeat(36)}.`),
    },
    {
      name: 'a private key in a page',
      files: edit(
        'patterns/maybe-cause.md',
        'Something drifts',
        `${'-----BEGIN '}PRIVATE KEY-----\nabc\nSomething drifts`,
      ),
    },
    {
      name: 'a known value',
      files: edit('contract/c1-identity.md', 'Serve', 'Serve s3cr3t-value-123'),
      ctx: (c) => ({ ...c, secretValues: ['s3cr3t-value-123'] }),
    },
  ],
};

/** The good files with a different ledger, its skill-impact.md re-rendered to match. */
function withLedger(f: Files, events: LedgerEvent[]): Files {
  return { ...f, 'ledger.jsonl': ledgerText(events), 'skill-impact.md': renderSkillImpact(events) };
}

function cite(c: LintContext, id: string): LintContext {
  return {
    ...c,
    skills: c.skills?.map((s) => ({
      ...s,
      purpose: { version: s.purpose?.version, cites: [{ id }] },
    })),
  };
}

describe('the good fixture', () => {
  it('passes every implemented rule, strict included', () => {
    const findings = lint(loadTree(goodFiles()), goodContext());
    expect(findings).toEqual([]);
    expect(lintExitCode(findings, { strict: true })).toBe(0);
  });

  it('allows owner names in evidence fields (the LR-19 exception)', () => {
    // The fixture's evidence, remediation ref and graderTask name the owner's tool and domain, and
    // the framework-kind lint above is still clean.
    expect(PATTERN_CONFIRMED).toContain(`post:https://${OWNER_DOMAIN}/`);
    expect(PATTERN_CONFIRMED).toContain(`graderTask: replay/${OWNER_TOOL}-probe`);
  });

  it('does not apply LR-19 to a project wiki', () => {
    const files = edit(
      'decisions/never-pause.md',
      'stay up unattended.',
      `stay up at ${OWNER_DOMAIN}.`,
    )(goodFiles());
    expect(lint(loadTree(files), { ...goodContext(), kind: 'project' })).toEqual([]);
  });
});

describe.each(Object.entries(BAD))('%s', (rule, cases) => {
  it.each(cases)('fails: $name', (c) => {
    const files = (c.files ?? ((f) => f))(goodFiles());
    const ctx = (c.ctx ?? ((x) => x))(goodContext());
    const findings = lint(loadTree(files), ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(new Set(findings.map((f) => f.rule))).toEqual(new Set([rule]));
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
    expect(lintExitCode(findings)).toBe(1);
    expect(lintExitCode(findings, { strict: true })).toBe(1);
  });
});

describe('finding content', () => {
  it('never echoes a secret it found', () => {
    const token = `ghp_${'y'.repeat(36)}`;
    const files = edit('log.md', 'Seeded the wiki.', `token ${token}`)(goodFiles());
    const [finding] = lint(loadTree(files), goodContext());
    expect(finding).toMatchObject({
      rule: 'LR-20',
      page: 'log.md',
      message: 'line 4: github-shaped secret',
    });
    expect(JSON.stringify(finding)).not.toContain(token);
  });

  it('names the file and field for a seam hit', () => {
    const files = edit(
      'patterns/maybe-cause.md',
      'title: A suspected cause',
      `title: ${OWNER_TOOL} cause`,
    )(goodFiles());
    expect(lint(loadTree(files), goodContext())).toEqual([
      {
        rule: 'LR-19',
        severity: 'error',
        page: 'patterns/maybe-cause.md',
        message: `title names the owner's tool "${OWNER_TOOL}"`,
      },
    ]);
  });

  it.each([
    ['a longer word', 'Something drifts between environments.', 'drift', false],
    ['a word prefix', 'Like a museum exhibit.', 'muse', false],
    ['a hyphenated compound', 'The polyphony-api health check passed.', 'polyphony', true],
    ['a compound suffix', 'The env-polyphony value was stale.', 'polyphony', true],
    ['a snake_case compound', 'Set POLYPHONY_URL first.', 'polyphony', true],
    ['a dotted host', 'Served at polyphony.example.dev.', 'polyphony', true],
  ])('treats tool names as whole tokens (%s)', (_n, sentence, tool, flagged) => {
    const files = edit(
      'decisions/never-pause.md',
      'stay up unattended.',
      `stay up unattended. ${sentence}`,
    )(goodFiles());
    const ctx = { ...goodContext(), seam: { toolNames: [tool] } };
    const hits = lint(loadTree(files), ctx).filter((f) => f.page === 'decisions/never-pause.md');
    expect(hits.map((f) => f.rule)).toEqual(flagged ? ['LR-19'] : []);
  });

  it('exempts ref and graderTask fields only while they are evidence refs or task ids', () => {
    const asProse = edit(
      'patterns/probe-cached.md',
      `graderTask: replay/${OWNER_TOOL}-probe`,
      `graderTask: run the ${OWNER_TOOL} probe by hand`,
    )(goodFiles());
    expect(lint(loadTree(asProse), goodContext())).toEqual([
      {
        rule: 'LR-19',
        severity: 'error',
        page: 'patterns/probe-cached.md',
        message: `catches.graderTask names the owner's tool "${OWNER_TOOL}"`,
      },
    ]);
    const ref = (to: string) =>
      edit(
        'patterns/probe-cached.md',
        `ref: "pr:owner/${OWNER_TOOL}#9"`,
        `ref: "${to}"`,
      )(goodFiles());
    // A repository file ref stays traceable; a prose ref naming the tool does not.
    expect(lint(loadTree(ref(`owner/${OWNER_TOOL}:verify/x.config.ts`)), goodContext())).toEqual(
      [],
    );
    expect(lint(loadTree(ref(`the ${OWNER_TOOL} spec`)), goodContext())).toMatchObject([
      { rule: 'LR-19', message: `remediation.ref names the owner's tool "${OWNER_TOOL}"` },
    ]);
  });

  it('attributes schema issues by their rule tag, not their message text', () => {
    const files = edit(
      'patterns/maybe-cause.md',
      'status: hypothesis',
      'status: superseded',
    )(goodFiles());
    const findings = lint(loadTree(files), goodContext());
    expect(findings.map((f) => f.rule)).toContain('LR-06');
  });

  it('reports a schema-enforced LR-05 condition under LR-05, with the field', () => {
    const files = BAD['LR-05'][0]?.files?.(goodFiles()) ?? {};
    const findings = lint(loadTree(files), goodContext());
    expect(findings.map((f) => f.message).join('\n')).toMatch(/catches: .*\(LR-05\)/);
  });

  it('fails on a warning only under --strict', () => {
    const warning = {
      rule: 'LR-01' as const,
      severity: 'warning' as const,
      page: 'x',
      message: 'm',
    };
    expect(lintExitCode([warning])).toBe(0);
    expect(lintExitCode([warning], { strict: true })).toBe(1);
  });
});

describe('--fix', () => {
  const fixable: [string, Case][] = [
    ['LR-02 id from path', BAD['LR-02'][0] as Case],
    ['LR-08 missing line', BAD['LR-08'][0] as Case],
    ['LR-08 ghost line', BAD['LR-08'][1] as Case],
    ['LR-08 no index', BAD['LR-08'][3] as Case],
    ['LR-14 stale render', BAD['LR-14'][2] as Case],
    ['LR-14 missing render', BAD['LR-14'][3] as Case],
  ];

  it.each(fixable)('%s: fixes on disk to the golden tree, then is idempotent', (_n, c) => {
    const root = writeTree((c.files ?? ((f) => f))(goodFiles()));
    expect(lint(loadWiki(root), goodContext()).length).toBeGreaterThan(0);
    writeChangeset(root, fix(loadWiki(root)));
    const after = loadWiki(root);
    expect(lint(after, goodContext())).toEqual([]);
    expect(fix(after).writes).toEqual([]);
    const golden = goodFiles();
    for (const path of ['patterns/maybe-cause.md', 'index.md', 'skill-impact.md']) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(golden[path]);
    }
  });

  it('keeps a human-written index summary for a page that is still listed', () => {
    const custom = '- [A suspected cause](patterns/maybe-cause.md) — hand-written summary';
    const files = goodFiles();
    files['index.md'] =
      `${(files['index.md'] ?? '').replace(/^- \[A suspected cause\].*$/m, custom)}- [Ghost](patterns/ghost.md) — x\n`;
    const after = fixInMemory(loadTree(files));
    expect(after.index).toContain(custom);
    expect(after.index).not.toContain('ghost');
  });

  it('leaves the index alone while a page fails to parse', () => {
    const files = BAD['LR-01'][0]?.files?.(goodFiles()) ?? {};
    const wiki = loadTree(files);
    expect(fix(wiki).writes.map((w) => w.path)).not.toContain('index.md');
  });

  it('does not render over an invalid ledger line', () => {
    const files = BAD['LR-14'][0]?.files?.(goodFiles()) ?? {};
    expect(fix(loadTree(files)).writes).toEqual([]);
  });
});

describe('generated index', () => {
  it('groups by type, skips archived pages, and summarizes from the body', () => {
    expect(generateIndex(loadTree(goodFiles()))).toMatchInlineSnapshot(`
      "# Index

      <!-- the page set is generated by \`greenlight wiki lint --fix\`; summaries may be reworded -->

      ## pattern

      - [A suspected cause](patterns/maybe-cause.md) — Something drifts between environments
      - [The old probe explanation](patterns/old-probe.md) — Superseded by a better root cause
      - [A keepalive probe answered by a cache](patterns/probe-cached.md) — The keepalive reported healthy, but the store paused anyway · The probe was answered from a cache · Probe a real table

      ## decision

      - [Content sites never use a pausing store](decisions/never-pause.md) — A content site must stay up unattended

      ## contract

      - [C1 — identity](contract/c1-identity.md) — Serve the build sha at /__version

      ## intent

      - [Demo — intent](tools/demo/intent.md) — A demo tool
      "
    `);
  });
});
