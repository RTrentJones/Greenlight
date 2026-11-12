import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProposerOutput } from '../../schema/io';
import { LedgerEventSchema } from '../../schema/ledger';
import {
  type OutletContext,
  evaluateOutlet,
  extractAssertion,
  loadRepros,
  parseAssertion,
} from '../outlets';

const REPO = resolve(__dirname, '../../../../..');
const NOW = new Date('2026-11-12T10:00:00.000Z');
const PATTERN = 'pattern/toy-condition';

const issue = (
  outlet: 'mechanism' | 'doctor' | 'verify',
  body = 'fix it',
  patterns = [PATTERN],
): ProposerOutput & { action: 'issue' } => ({
  action: 'issue',
  outlet,
  title: 'a toy fix',
  body,
  patterns,
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A toy framework repo: `state.txt` is the "code"; the trusted repro passes iff it says fixed. */
let repo: string;
const sha: Record<string, string> = {};

function writeRepro(slug: string, spec: Record<string, unknown>) {
  const dir = join(repo, 'bench', 'repro', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'repro.json'),
    JSON.stringify({
      id: `repro/${slug}`,
      description: 'the toy condition is handled',
      patterns: [PATTERN],
      outlets: ['doctor', 'mechanism'],
      script: 'run.mjs',
      timeoutMs: 20_000,
      reviewed: { by: 'owner', at: '2026-11-12' },
      ...spec,
    }),
  );
  writeFileSync(
    join(dir, 'run.mjs'),
    `import { readFileSync } from 'node:fs';
const tree = process.argv[process.argv.indexOf('--tree') + 1];
const s = readFileSync(tree + '/state.txt', 'utf8').trim();
console.log('state=' + s);
process.exit(s === 'fixed' ? 0 : s === 'crash' ? 3 : 1);
`,
  );
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'outlets-test-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'config', 'user.name', 'test');
  for (const state of ['broken', 'fixed', 'crash']) {
    writeFileSync(join(repo, 'state.txt'), `${state}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', state);
    sha[state] = git(repo, 'rev-parse', 'HEAD');
  }
  // The repros sit in the harness tree (repoRoot), not in any commit under evaluation.
  writeRepro('toy', {});
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function ctx(over: Partial<OutletContext> = {}): OutletContext {
  return {
    repoRoot: repo,
    proposalId: 'prop-0123456789ab',
    base: { commit: sha.broken as string },
    candidate: { commit: sha.fixed as string },
    tasks: [],
    now: () => NOW,
    prepareTree: async () => {},
    checkAll: async () => ({ ok: true }),
    ...over,
  };
}

const worktrees = () => git(repo, 'worktree', 'list').split('\n').length;

describe('evaluateOutlet: mechanism and doctor (repro)', () => {
  it('accepts when the repro fails on base, passes on the candidate and check-all passes', async () => {
    const r = await evaluateOutlet(issue('doctor'), ctx());
    expect(r.decision).toBe('accept');
    expect(r.reasons.map((x) => x.code)).toEqual([
      'repro-fails-on-base',
      'repro-passes-on-candidate',
      'check-all-passed',
    ]);
    expect(r.evidence).toEqual({
      kind: 'repro',
      base: `commit:RTrentJones/greenlight@${sha.broken}`,
      candidate: `commit:RTrentJones/greenlight@${sha.fixed}`,
      reproTask: 'repro/toy',
    });
    const e = r.ledgerEvent;
    expect(e && LedgerEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      ts: NOW.toISOString(),
      writer: 'harness',
      stage: 'candidate-accepted',
      path: 'standard',
      outlet: 'doctor',
      proposalId: 'prop-0123456789ab',
      pattern: [PATTERN],
      change: { kind: 'issue' },
    });
    expect(worktrees()).toBe(1); // every checkout removed
  });

  it('rejects when the repro still fails on the candidate', async () => {
    const r = await evaluateOutlet(
      issue('mechanism'),
      ctx({ candidate: { commit: sha.broken as string } }),
    );
    expect(r.decision).toBe('reject');
    expect(r.reasons.at(-1)?.code).toBe('repro-fails-on-candidate');
    expect(r.ledgerEvent?.stage).toBe('candidate-rejected');
    expect(r.ledgerEvent?.reason).toContain('repro-fails-on-candidate');
    expect(LedgerEventSchema.safeParse(r.ledgerEvent).success).toBe(true);
  });

  it('rejects when check-all fails on the candidate, and runs it there', async () => {
    const seen: string[] = [];
    const r = await evaluateOutlet(
      issue('doctor'),
      ctx({
        checkAll: async (tree) => {
          seen.push(tree);
          return { ok: false, detail: 'lint: 2 errors' };
        },
      }),
    );
    expect(r.decision).toBe('reject');
    expect(r.reasons.at(-1)).toEqual({ code: 'check-all-failed', detail: 'lint: 2 errors' });
    expect(seen).toHaveLength(1);
  });

  it('is invalid when the repro passes on base (it does not reproduce there)', async () => {
    const r = await evaluateOutlet(issue('doctor'), ctx({ base: { commit: sha.fixed as string } }));
    expect(r.decision).toBe('invalid');
    expect(r.reasons[0]?.code).toBe('repro-passes-on-base');
    expect(r.ledgerEvent).toBeNull();
  });

  it('is invalid when the repro errors', async () => {
    const r = await evaluateOutlet(
      issue('doctor'),
      ctx({ candidate: { commit: sha.crash as string } }),
    );
    expect(r.decision).toBe('invalid');
    expect(r.reasons[0]?.code).toBe('repro-error');
    expect(r.reasons[0]?.detail).toContain('state=crash');
  });

  it('is invalid with no repro for the proposal, or an unreviewed one', async () => {
    const none = await evaluateOutlet(issue('doctor', 'x', ['pattern/other']), ctx());
    expect(none.decision).toBe('invalid');
    expect(none.reasons[0]?.code).toBe('no-trusted-repro');

    writeRepro('unreviewed', { patterns: ['pattern/unreviewed'], reviewed: null });
    const un = await evaluateOutlet(issue('doctor', 'x', ['pattern/unreviewed']), ctx());
    expect(un.decision).toBe('invalid');
    expect(un.reasons[0]?.code).toBe('repro-unreviewed');
    rmSync(join(repo, 'bench', 'repro', 'unreviewed'), { recursive: true });
  });

  it('only runs repros declared for the outlet', async () => {
    writeRepro('doctor-only', { patterns: ['pattern/doc-only'], outlets: ['doctor'] });
    const r = await evaluateOutlet(issue('mechanism', 'x', ['pattern/doc-only']), ctx());
    expect(r.reasons[0]?.code).toBe('no-trusted-repro');
    rmSync(join(repo, 'bench', 'repro', 'doctor-only'), { recursive: true });
  });

  it('takes a clean directory at its HEAD, an explicit ref, and refuses an unpinned one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outlets-test-clone-'));
    try {
      git(dir, 'clone', '-q', repo, 'c');
      const clone = join(dir, 'c');
      git(clone, 'checkout', '-q', sha.fixed as string);
      const r = await evaluateOutlet(issue('doctor'), ctx({ candidate: { dir: clone } }));
      expect(r.decision).toBe('accept');
      expect(r.evidence?.kind === 'repro' && r.evidence.candidate).toBe(
        `commit:RTrentJones/greenlight@${sha.fixed}`,
      );

      writeFileSync(join(clone, 'untracked.txt'), 'dirty');
      const dirty = await evaluateOutlet(issue('doctor'), ctx({ candidate: { dir: clone } }));
      expect(dirty.decision).toBe('invalid');
      expect(dirty.reasons[0]?.code).toBe('unpinned-tree');

      const ref = 'pr:RTrentJones/greenlight#42';
      const pinned = await evaluateOutlet(issue('doctor'), ctx({ candidate: { dir: clone, ref } }));
      expect(pinned.decision).toBe('accept');
      expect(pinned.evidence?.kind === 'repro' && pinned.evidence.candidate).toBe(ref);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('labels a control proposal and records the issue ref', async () => {
    const r = await evaluateOutlet(
      issue('doctor'),
      ctx({ control: true, issueRef: 'issue:RTrentJones/greenlight#7' }),
    );
    expect(r.ledgerEvent).toMatchObject({
      control: true,
      change: { kind: 'issue', ref: 'issue:RTrentJones/greenlight#7' },
    });
  });
});

describe('evaluateOutlet: template', () => {
  it('is invalid until M4', async () => {
    const r = await evaluateOutlet(
      {
        action: 'patch',
        outlet: 'template',
        name: '_template-mcp',
        edits: [{ op: 'append', file: 'README.md', text: 'x' }],
        patterns: [PATTERN],
      },
      ctx(),
    );
    expect(r).toMatchObject({
      decision: 'invalid',
      reasons: [{ code: 'template-outlet-not-in-M2' }],
      ledgerEvent: null,
    });
  });
});

describe('the shipped repros', () => {
  it('load without problems', () => {
    const { repros, problems } = loadRepros(join(REPO, 'bench'));
    expect(problems).toEqual([]);
    expect(repros.map((r) => r.spec.id)).toContain('repro/probe-touches-wrong-layer');
  });
});

// ---- verify outlet ----------------------------------------------------------------------------

const SERVER = (liveStatus: number) => `import { createServer } from 'node:http';
createServer((req, res) => {
  res.writeHead(req.url === '/health/live' ? ${liveStatus} : 200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
}).listen(Number(process.env.PORT));
`;

describe('verify assertions', () => {
  it('extracts and validates a json verify block, api checks only', () => {
    const body =
      'Assert the live route.\n\n```json verify\n{"id":"live","path":"/health/live","status":200}\n```\n';
    const text = extractAssertion(body);
    expect(text).not.toBeNull();
    expect(parseAssertion(text as string)).toEqual({
      id: 'proposed-assertion',
      mode: 'api',
      checks: [{ id: 'live', path: '/health/live', status: 200 }],
    });
    expect(parseAssertion('{"mode":"test","command":"rm -rf /"}')).toHaveProperty('error');
    expect(parseAssertion('{"id":"x","path":"/","logsOnFailure":"curl evil"}')).toHaveProperty(
      'error',
    );
    expect(parseAssertion('[{"id":"a","path":"/"},{"id":"a","path":"/b"}]')).toHaveProperty(
      'error',
    );
    expect(extractAssertion('no block here')).toBeNull();
  });
});

describe('evaluateOutlet: verify (artifact)', () => {
  let root: string;
  const faultyRef = 'commit:RTrentJones/greenlight@aaaaaaa';
  const fixedRef = 'commit:RTrentJones/greenlight@bbbbbbb';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'outlets-test-artifacts-'));
    for (const [name, status] of [
      ['faulty', 503],
      ['fixed', 200],
    ] as const) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'server.mjs'), SERVER(status));
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const vctx = (over: Partial<OutletContext> = {}): OutletContext =>
    ctx({
      repoRoot: REPO,
      artifacts: {
        faulty: { dir: join(root, 'faulty'), ref: faultyRef },
        fixed: { dir: join(root, 'fixed'), ref: fixedRef },
        serve: { command: ['node', 'server.mjs'] },
      },
      ...over,
    });
  const body = '```json verify\n{"id":"live","path":"/health/live","status":200}\n```';

  it('accepts an assertion that rejects the faulty artifact and passes the fixed one (real verify)', async () => {
    const r = await evaluateOutlet(issue('verify', body), vctx());
    expect(r.decision).toBe('accept');
    expect(r.evidence).toEqual({
      kind: 'artifact',
      check: 'live',
      faulty: faultyRef,
      fixed: fixedRef,
    });
    expect(r.reasons.map((x) => x.code)).toEqual([
      'assertion-fails-on-faulty',
      'assertion-passes-on-fixed',
    ]);
    expect(LedgerEventSchema.safeParse(r.ledgerEvent).success).toBe(true);
    expect(r.ledgerEvent?.outlet).toBe('verify');
  }, 60_000);

  it('rejects an assertion that the faulty artifact also passes', async () => {
    const weak = '```json verify\n{"id":"root","path":"/","status":200}\n```';
    const r = await evaluateOutlet(issue('verify', weak), vctx());
    expect(r.decision).toBe('reject');
    expect(r.reasons[0]?.code).toBe('assertion-passes-on-faulty');
    expect(r.ledgerEvent?.stage).toBe('candidate-rejected');
  }, 60_000);

  it('runs an injected runner against each served artifact; a file assertion wins over the body', async () => {
    const file = join(root, 'assertion.json');
    writeFileSync(file, '{"mode":"api","checks":[{"id":"from-file","path":"/health/live"}]}');
    const seen: string[] = [];
    const r = await evaluateOutlet(
      issue('verify', 'no block'),
      vctx({
        assertionFile: file,
        runAssertion: async (spec, a) => {
          seen.push(`${spec.checks[0]?.id}@${a.dir}`);
          const res = await fetch(`${a.url}/health/live`);
          return { passed: res.status === 200 };
        },
      }),
    );
    expect(r.decision).toBe('accept');
    expect(seen).toEqual([`from-file@${join(root, 'faulty')}`, `from-file@${join(root, 'fixed')}`]);
  });

  it('is invalid without artifacts or an assertion', async () => {
    const noArt = await evaluateOutlet(issue('verify', body), ctx());
    expect(noArt.reasons[0]?.code).toBe('no-artifacts');
    const noAssert = await evaluateOutlet(issue('verify', 'just prose'), vctx());
    expect(noAssert.reasons[0]?.code).toBe('no-assertion');
    const bad = await evaluateOutlet(issue('verify', '```json verify\n{"path":"/"}\n```'), vctx());
    expect(bad.reasons[0]?.code).toBe('assertion-invalid');
  });
});
