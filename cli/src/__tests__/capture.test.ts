import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawRecordSchema } from '@rtrentjones/greenlight-shared';
import type { VerifyReport } from '@rtrentjones/greenlight-verify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureGate, gateExcerpt } from '../capture';
import { type WikiIo, wikiCommand } from '../commands/wiki';

// Raw capture (vision 07 §3.5, 08 §5): the identity cases of 13 §2.9, the planted-secret case of
// 13 §2.6, and retention. Each test runs in its own scratch repository.

let cwd: string;
let out: string[];
let err: string[];
let env: NodeJS.ProcessEnv;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const io = (): WikiIo => ({ cwd, env, out: (s) => out.push(s), err: (s) => err.push(s) });
const run = (...args: string[]) => wikiCommand(args, io());
const records = () => {
  const dir = join(cwd, '.greenlight/raw');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((f) => RawRecordSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
};
const report = (pass: boolean, detail?: string): VerifyReport => ({
  pass,
  mode: 'api',
  url: 'http://localhost:4321',
  checks: [
    { name: 'GET / 200', id: 'home', pass: true },
    { name: 'GET /og.png is a PNG', id: 'og-png', pass, ...(detail ? { detail } : {}) },
  ],
  ...(pass ? {} : { logs: 'line one\nline two' }),
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gl-capture-'));
  out = [];
  err = [];
  env = { GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1' };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'owner@example.test');
  git('config', 'user.name', 'Owner');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'https://github.com/acme/site.git');
  mkdirSync(join(cwd, 'apps/blog'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), '.greenlight/\n');
  writeFileSync(join(cwd, 'apps/blog/verify.config.ts'), 'export default { mode: "api" };\n');
  mkdirSync(join(cwd, '.claude/skills/demo'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude/skills/demo/SKILL.md'),
    '---\nname: demo\nversion: "2"\n---\n# Demo\n',
  );
  git('add', '.');
  git('commit', '-q', '-m', 'one');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const gate = (over: Partial<Parameters<typeof captureGate>[0]> = {}) =>
  captureGate({
    kind: 'preview',
    tool: 'blog',
    env: 'preview',
    reports: [report(false, 'content-type was text/html')],
    dir: 'apps/blog',
    cwd,
    processEnv: env,
    log: () => {},
    ...over,
  });

describe('gate capture', () => {
  it('writes one valid record with the run’s identity, verify document and failing checks', () => {
    const rawId = gate({ wikiHits: ['pattern/og-image-missing'] });
    const [r] = records();
    expect(r?.rawId).toBe(rawId);
    expect(r).toMatchObject({
      tool: 'blog',
      env: 'preview',
      kind: 'preview',
      passed: false,
      sourceRepo: 'acme/site',
      gitSha: git('rev-parse', 'HEAD'),
      dirty: false,
      runId: 'gha:777',
      attempt: 1,
      wikiHits: ['pattern/og-image-missing'],
    });
    expect(r?.wrapperRev.sha).toBe(git('rev-parse', 'HEAD'));
    expect(r?.wrapperRev.verifyConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r?.skills.installed.demo?.version).toBe('2');
    expect(r?.skills.used).toBe('unknown');
    expect(r?.retained.verdict).toBe('failed');
    expect(r?.retained.excerpt).toContain(
      '✘ [og-png] GET /og.png is a PNG — content-type was text/html',
    );
    expect(r?.retained.excerpt).toContain('line two');
    expect((r?.verify as { wiki_hits: string[] }).wiki_hits).toEqual(['pattern/og-image-missing']);
  });

  it('does nothing with --no-capture or GREENLIGHT_RAW=off, and never throws', () => {
    expect(gate({ noCapture: true })).toBeUndefined();
    expect(gate({ processEnv: { GREENLIGHT_RAW: 'off' } })).toBeUndefined();
    expect(records()).toEqual([]);
    // A failure inside capture is swallowed: the gate's result never depends on it.
    writeFileSync(join(cwd, '.greenlight'), 'a file where the directory should be');
    expect(gate()).toBeUndefined();
  });

  it('records a gate that never reached verify as failed', () => {
    gate({ reports: [] });
    expect(records()[0]).toMatchObject({ passed: false });
    expect(records()[0]?.retained.excerpt).toBe('the gate did not reach verify');
  });

  it('13 §2.9: two dirty trees at one HEAD get different tree hashes', () => {
    writeFileSync(join(cwd, 'apps/blog/page.md'), 'first\n');
    gate();
    writeFileSync(join(cwd, 'apps/blog/page.md'), 'second\n');
    gate();
    const [a, b] = records();
    expect(a?.gitSha).toBe(b?.gitSha);
    expect([a?.dirty, b?.dirty]).toEqual([true, true]);
    expect(a?.treeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.treeHash).not.toBe(b?.treeHash);
  });

  it('13 §2.9: a changed verify config changes the wrapper revision', () => {
    gate();
    writeFileSync(join(cwd, 'apps/blog/verify.config.ts'), 'export default { mode: "mcp" };\n');
    gate();
    const [a, b] = records();
    expect(a?.wrapperRev.verifyConfigHash).not.toBe(b?.wrapperRev.verifyConfigHash);
  });

  it('13 §2.9: two attempts of one CI run are distinct records', () => {
    gate();
    gate({ processEnv: { ...env, GITHUB_RUN_ATTEMPT: '2' } });
    const attempts = records()
      .map((r) => `${r.runId}#${r.attempt}`)
      .sort();
    expect(attempts).toEqual(['gha:777#1', 'gha:777#2']);
  });

  it('13 §2.9: skills the agent reports as used are recorded, the rest stay installed only', () => {
    const stamp = { version: '2', contentHash: 'a'.repeat(64) };
    gate({ processEnv: { ...env, GREENLIGHT_SKILLS_USED: JSON.stringify({ demo: stamp }) } });
    expect(records()[0]?.skills.used).toEqual({ demo: stamp });
  });

  it('13 §2.6: a planted secret reaches no part of the record', () => {
    const canary = 'canary-value-9f3b2c7d1e';
    const shaped = `ghp_${'A1b2C3d4E5'.repeat(4)}`.slice(0, 40);
    gate({
      processEnv: { ...env, CLOUDFLARE_API_TOKEN: canary },
      reports: [
        {
          ...report(false, `env dump: CLOUDFLARE_API_TOKEN=${canary}`),
          logs: `Authorization: Bearer ${canary}\ngithub token ${shaped}\n`,
        },
      ],
      stages: [{ stage: 'verify', detail: `token ${canary} and ${shaped}` }],
    });
    const text = readFileSync(
      join(cwd, '.greenlight/raw', readdirSync(join(cwd, '.greenlight/raw'))[0] as string),
      'utf8',
    );
    expect(text).not.toContain(canary);
    expect(text).not.toContain(shaped);
    expect(text).toContain('gl-redacted-');
  });

  it('summarizes a passing run in one line per spec', () => {
    expect(gateExcerpt([report(true)])).toBe('verify api http://localhost:4321: pass (2/2 checks)');
  });
});

describe('wiki capture', () => {
  it('--manual records a redacted note as a session record and prints its id', async () => {
    env.NPM_TOKEN = 'canary-token-55aa66bb';
    expect(
      await run(
        'capture',
        '--manual',
        '--tool',
        'blog',
        '--env',
        'prod',
        '--passed',
        'false',
        '--note',
        'Share previews broke; the token canary-token-55aa66bb was in the log.',
        '--ref',
        'issue:acme/site#12',
        '--ref',
        'run:acme/site/99',
      ),
    ).toBe(0);
    const [r] = records();
    expect(out.at(-1)).toBe(r?.rawId);
    expect(r).toMatchObject({
      kind: 'session',
      env: 'prod',
      passed: false,
      refs: ['issue:acme/site#12', 'run:acme/site/99'],
    });
    expect(r?.retained.excerpt).toContain('Share previews broke');
    expect(r?.retained.excerpt).not.toContain('canary-token-55aa66bb');
  });

  it('records an unknown verdict, and a commit the caller names', async () => {
    const sha = 'b'.repeat(40);
    expect(
      await run(
        'capture',
        '--manual',
        '--tool',
        'blog',
        '--env',
        'beta',
        '--passed',
        'unknown',
        '--note',
        'n',
        '--sha',
        sha,
      ),
    ).toBe(0);
    expect(records()[0]).toMatchObject({ gitSha: sha, dirty: false, passed: false });
    expect(records()[0]?.retained.verdict).toBe('unknown');
  });

  it('--kind reads the excerpt and the verify document from files', async () => {
    writeFileSync(join(cwd, 'excerpt.txt'), 'keepalive: store paused');
    writeFileSync(join(cwd, 'verify.json'), JSON.stringify({ passed: false }));
    expect(
      await run(
        'capture',
        '--kind',
        'alert',
        '--tool',
        'heist',
        '--env',
        'prod',
        '--passed',
        'false',
        '--excerpt-file',
        'excerpt.txt',
        '--verify-json',
        'verify.json',
      ),
    ).toBe(0);
    const [r] = records();
    expect(r).toMatchObject({ kind: 'alert', verify: { passed: false } });
    expect(r?.retained.hashes.verify).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong command line (exit 2) and bad inputs (exit 3)', async () => {
    const base = ['capture', '--manual', '--tool', 'blog', '--env', 'prod', '--passed', 'true'];
    expect(await run('capture')).toBe(2);
    expect(await run(...base)).toBe(2);
    expect(await run(...base, '--note', 'n', '--kind', 'ship')).toBe(2);
    expect(
      await run(
        'capture',
        '--manual',
        '--tool',
        'b',
        '--env',
        'bench',
        '--passed',
        'true',
        '--note',
        'n',
      ),
    ).toBe(2);
    expect(
      await run(
        'capture',
        '--manual',
        '--tool',
        'b',
        '--env',
        'prod',
        '--passed',
        'maybe',
        '--note',
        'n',
      ),
    ).toBe(2);
    expect(
      await run('capture', '--kind', 'bench', '--tool', 'b', '--env', 'prod', '--passed', 'true'),
    ).toBe(2);
    expect(await run(...base, '--note', 'n', '--ref', 'not-a-ref')).toBe(3);
    expect(await run(...base, '--note', 'n', '--sha', 'abc')).toBe(3);
    expect(
      await run(
        'capture',
        '--kind',
        'ship',
        '--tool',
        'b',
        '--env',
        'prod',
        '--passed',
        'true',
        '--excerpt-file',
        'missing.txt',
      ),
    ).toBe(3);
    expect(records()).toEqual([]);
  });

  it('is a no-op that exits 0 when capture is off', async () => {
    env.GREENLIGHT_RAW = 'off';
    expect(
      await run(
        'capture',
        '--manual',
        '--tool',
        'b',
        '--env',
        'prod',
        '--passed',
        'true',
        '--note',
        'n',
      ),
    ).toBe(0);
    expect(out).toEqual([]);
    expect(records()).toEqual([]);
  });

  it('--retain copies a record into wiki/evidence once, and it is then immutable', async () => {
    await run(
      'capture',
      '--manual',
      '--tool',
      'blog',
      '--env',
      'prod',
      '--passed',
      'true',
      '--note',
      'drill passed',
    );
    const rawId = out.at(-1) as string;
    expect(await run('capture', '--retain', rawId)).toBe(0);
    const kept = join(cwd, 'wiki/evidence', `${rawId}.json`);
    expect(out.at(-1)).toBe(kept);
    expect(readFileSync(kept, 'utf8')).toBe(
      readFileSync(join(cwd, '.greenlight/raw', `${rawId}.json`), 'utf8'),
    );
    expect(await run('capture', '--retain', rawId)).toBe(0);
    expect(out.at(-1)).toContain('already retained');
    writeFileSync(kept, '{}\n');
    expect(await run('capture', '--retain', rawId)).toBe(3);
    expect(await run('capture', '--retain', '20260101T000000Z-deadbeef')).toBe(3);
    expect(await run('capture', '--retain', 'nonsense')).toBe(3);
  });
});
