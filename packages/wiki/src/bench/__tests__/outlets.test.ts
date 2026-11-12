import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProposerOutput } from '../../schema/io';
import { LedgerEventSchema } from '../../schema/ledger';
import {
  type OutletContext,
  buildEvaluatedTree,
  checkAllCommands,
  evaluateOutlet,
  extractAssertion,
  harnessConfigTouches,
  installEnv,
  loadRepros,
  parseAssertion,
  runSandboxedCheckAll,
} from '../outlets';
import { dockerAvailable, ensureRunnerImage } from '../sandbox';

const REPO = resolve(__dirname, '../../../../..');
const NOW = new Date('2026-11-12T10:00:00.000Z');
const PATTERN = 'pattern/toy-condition';
const DOCKER = dockerAvailable();

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
  const faultyRef = 'run:RTrentJones/greenlight/101';
  const fixedRef = 'run:RTrentJones/greenlight/102';
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

describe('check-all on a candidate (harness commands, base + diff, docker sandbox)', () => {
  it("expands the harness's check-all through its own scripts", () => {
    const h = mkdtempSync(join(tmpdir(), 'outlets-test-harness-'));
    try {
      writeFileSync(
        join(h, 'package.json'),
        JSON.stringify({
          scripts: {
            'check-all': 'pnpm a && pnpm run b && echo c',
            a: 'echo a1 && echo a2',
            b: 'echo b',
          },
        }),
      );
      expect(checkAllCommands(h)).toEqual(['echo a1', 'echo a2', 'echo b', 'echo c']);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('install env carries no secret', () => {
    expect(installEnv({ PATH: '/bin', GEMINI_API_KEY: 'x', GITHUB_TOKEN: 'y' })).toEqual({
      CI: '1',
      PATH: '/bin',
    });
  });

  /** A clone of the toy repo at `fixed` with `edit` applied and committed (a clean candidate). */
  function candidateClone(edit: (dir: string) => void): { root: string; dir: string } {
    const root = mkdtempSync(join(tmpdir(), 'outlets-test-cand-'));
    git(root, 'clone', '-q', repo, 'c');
    const dir = join(root, 'c');
    git(dir, 'checkout', '-q', sha.fixed as string);
    git(dir, 'config', 'user.email', 'test@example.test');
    git(dir, 'config', 'user.name', 'test');
    edit(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'candidate');
    return { root, dir };
  }

  it.each([
    ['vitest.config.ts', 'export default {};\n'],
    ['turbo.json', '{}\n'],
    ['package.json', '{"scripts":{"check-all":"true"}}\n'],
    ['packages/x/package.json', '{}\n'],
    ['tsconfig.base.json', '{}\n'],
    ['scripts/check-seam.ts', 'process.exit(0);\n'],
    ['bench/repro/toy/run.mjs', 'process.exit(0);\n'],
    ['.github/workflows/ci.yml', 'on: push\n'],
  ])('refuses a candidate that edits %s, before anything of it runs', async (path, body) => {
    const c = candidateClone((d) => {
      mkdirSync(dirname(join(d, path)), { recursive: true });
      writeFileSync(join(d, path), body);
    });
    try {
      let ran = false;
      const r = await evaluateOutlet(
        issue('doctor'),
        ctx({
          candidate: { dir: c.dir },
          checkAll: async () => {
            ran = true;
            return { ok: true };
          },
        }),
      );
      expect(r.decision).toBe('invalid');
      expect(r.reasons[0]?.code).toBe('candidate-touches-harness-config');
      expect(r.reasons[0]?.detail).toContain(path);
      expect(r.ledgerEvent).toBeNull();
      expect(ran).toBe(false);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('never uses a planted node_modules, .turbo cache or tsbuildinfo, and judges base + diff', async () => {
    const c = candidateClone((d) => {
      writeFileSync(join(d, '.gitignore'), 'node_modules/\n.turbo/\n*.tsbuildinfo\n');
      writeFileSync(join(d, 'feature.txt'), 'the candidate change\n');
    });
    try {
      // Ignored, so the clone stays clean, and planted: a fake vitest that always passes.
      mkdirSync(join(c.dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(c.dir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      });
      mkdirSync(join(c.dir, '.turbo', 'cache'), { recursive: true });
      writeFileSync(join(c.dir, '.turbo', 'cache', 'hit.json'), '{}');
      writeFileSync(join(c.dir, 'x.tsbuildinfo'), '{}');
      const seen: string[] = [];
      const r = await evaluateOutlet(
        issue('doctor'),
        ctx({
          candidate: { dir: c.dir },
          checkAll: async (tree) => {
            seen.push(tree);
            return { ok: true };
          },
        }),
      );
      expect(r.decision, JSON.stringify(r.reasons)).toBe('accept');
      expect(seen).toHaveLength(1);
      const tree = seen[0] as string;
      expect(tree).not.toBe(c.dir);
      expect(seen.some((t) => t.startsWith(c.root))).toBe(false);
    } finally {
      rmSync(c.root, { recursive: true, force: true });
    }
  });

  it('builds base + the diff only: planted dirs absent, edits and deletions applied', () => {
    const root = mkdtempSync(join(tmpdir(), 'outlets-test-overlay-'));
    try {
      const base = join(root, 'base');
      const cand = join(root, 'cand');
      for (const d of [base, cand]) mkdirSync(join(d, 'src'), { recursive: true });
      writeFileSync(join(base, 'src', 'a.ts'), 'a0');
      writeFileSync(join(base, 'src', 'gone.ts'), 'g');
      writeFileSync(join(cand, 'src', 'a.ts'), 'a1');
      writeFileSync(join(cand, 'src', 'new.ts'), 'n');
      mkdirSync(join(cand, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(cand, 'node_modules', '.bin', 'vitest'), 'planted');
      mkdirSync(join(base, 'node_modules'), { recursive: true });
      writeFileSync(join(base, 'node_modules', 'base-dep'), 'not copied either');
      const out = join(root, 'out');
      const built = buildEvaluatedTree(base, cand, out);
      expect(built).toEqual({
        ok: true,
        changed: ['src/a.ts', 'src/new.ts'],
        removed: ['src/gone.ts'],
      });
      expect(readFileSync(join(out, 'src', 'a.ts'), 'utf8')).toBe('a1');
      expect(existsSync(join(out, 'src', 'gone.ts'))).toBe(false);
      expect(existsSync(join(out, 'node_modules'))).toBe(false);
      symlinkSync('/etc/passwd', join(cand, 'src', 'leak'));
      expect(buildEvaluatedTree(base, cand, join(root, 'out2'))).toEqual({
        refused: 'unsafe-link',
        paths: ['src/leak'],
      });
      expect(harnessConfigTouches(['a/b/package.json', 'src/x.ts', 'vitest.config.mts'])).toEqual([
        'a/b/package.json',
        'vitest.config.mts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('without docker, check-all is unavailable (the outlet is invalid, never unsandboxed)', async () => {
    const r = await runSandboxedCheckAll(repo, repo, { docker: 'greenlight-no-such-docker' });
    expect(r).toMatchObject({ ok: false, unavailable: true });
    const out = await evaluateOutlet(
      issue('doctor'),
      ctx({
        checkAll: (t) => runSandboxedCheckAll(repo, t, { docker: 'greenlight-no-such-docker' }),
      }),
    );
    expect(out.decision).toBe('invalid');
    expect(out.reasons[0]?.code).toBe('no-sandbox');
  });

  it.skipIf(!DOCKER)(
    'runs in the sandbox: uid 10000, no network, no harness secret, only the tree mounted',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'outlets-test-sandbox-'));
      const was = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'test-not-a-real-key';
      try {
        const harness = join(root, 'harness');
        mkdirSync(harness);
        // The suite fails (exit 3..6) on any isolation breach, else passes iff the tree has `ok`.
        const probe = [
          "const os=require('os'),fs=require('fs');",
          'if (process.env.GEMINI_API_KEY) process.exit(3);',
          'if (process.getuid() !== 10000) process.exit(4);',
          "if (Object.keys(os.networkInterfaces()).some((n) => n !== 'lo')) process.exit(5);",
          `if (fs.existsSync(${JSON.stringify(harness)})) process.exit(6);`,
          "if (!/^10\\.12\\.1/.test(require('child_process').execSync('pnpm --version').toString())) process.exit(7);",
          "process.exit(fs.existsSync('ok') ? 0 : 1);",
        ].join(' ');
        writeFileSync(join(harness, 'probe.cjs'), probe);
        writeFileSync(
          join(harness, 'package.json'),
          JSON.stringify({
            packageManager: 'pnpm@10.12.1',
            scripts: { 'check-all': 'pnpm suite', suite: 'node probe.cjs' },
          }),
        );
        const tree = join(root, 'tree');
        mkdirSync(tree);
        copyFileSync(join(harness, 'probe.cjs'), join(tree, 'probe.cjs'));
        const image = ensureRunnerImage(join(REPO, 'bench', 'runner'));
        const bad = await runSandboxedCheckAll(harness, tree, { image });
        expect(bad.ok, bad.detail).toBe(false);
        expect(bad.unavailable).toBeUndefined();
        writeFileSync(join(tree, 'ok'), '');
        const good = await runSandboxedCheckAll(harness, tree, { image });
        expect(good.ok, good.detail).toBe(true);
      } finally {
        if (was === undefined) Reflect.deleteProperty(process.env, 'GEMINI_API_KEY');
        else process.env.GEMINI_API_KEY = was;
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

describe('a directory named by a commit ref', () => {
  it('must be a clean checkout at that commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outlets-test-pin-'));
    try {
      git(dir, 'clone', '-q', repo, 'c');
      const clone = join(dir, 'c');
      git(clone, 'checkout', '-q', sha.fixed as string);
      const right = `commit:RTrentJones/greenlight@${sha.fixed}`;
      const wrong = `commit:RTrentJones/greenlight@${sha.broken}`;
      const ok = await evaluateOutlet(
        issue('doctor'),
        ctx({ candidate: { dir: clone, ref: right } }),
      );
      expect(ok.decision).toBe('accept');
      const lie = await evaluateOutlet(
        issue('doctor'),
        ctx({ candidate: { dir: clone, ref: wrong } }),
      );
      expect(lie.decision).toBe('invalid');
      expect(lie.reasons[0]?.code).toBe('unpinned-tree');
      writeFileSync(join(clone, 'untracked.txt'), 'dirty');
      const dirty = await evaluateOutlet(
        issue('doctor'),
        ctx({ candidate: { dir: clone, ref: right } }),
      );
      expect(dirty.decision).toBe('invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
