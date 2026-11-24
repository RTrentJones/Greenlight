import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `greenlight approve`, `greenlight release verify` and the production guard, through the real
 * CLI against a scratch wrapper with real SSH-signed tags (vision 18 §3, §9: A-06, A-15, A-16).
 */
const REPO = resolve(__dirname, '../../..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const BIN = join(REPO, 'cli/src/bin.ts');
const HAS_SSH = spawnSync('ssh-keygen', ['-?']).error === undefined;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function wrapper(enforced: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'greenlight-release-'));
  dirs.push(root);
  const repo = join(root, 'w');
  sh(root, 'git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'git', ['config', 'user.email', 'owner@example.test']);
  sh(repo, 'git', ['config', 'user.name', 'Owner']);
  sh(repo, 'git', ['remote', 'add', 'origin', 'https://github.com/acme/site.git']);
  writeFileSync(
    join(repo, 'greenlight.config.mjs'),
    `export default {
  domain: 'example.test',
  alerts: { sink: 'github-issue' },
  tools: [{ name: 'pinboard', lane: 'mcp', target: 'docker', data: 'none', auth: 'none', access: 'public', envs: ['beta', 'prod'], port: 4310 }],
  ${enforced ? "release: { approval: 'signed-tag' }," : ''}
};
`,
  );
  sh(repo, 'git', ['add', '.']);
  sh(repo, 'git', ['commit', '-q', '-m', 'one']);
  const sha = sh(repo, 'git', ['rev-parse', 'HEAD']);
  const key = (name: string) => {
    const file = join(root, name);
    sh(root, 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', file]);
    return { file, pub: readFileSync(`${file}.pub`, 'utf8').trim() };
  };
  const owner = key('owner');
  const attacker = key('attacker');
  const envFile = join(root, 'github_env');
  writeFileSync(envFile, '');
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(TSX, [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: root, ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const sign = (keyFile: string, tag: string, payload: unknown) => {
    const msg = join(root, 'payload.json');
    writeFileSync(msg, `${JSON.stringify(payload)}\n`);
    sh(repo, 'git', [
      '-c',
      'gpg.format=ssh',
      '-c',
      'gpg.ssh.program=ssh-keygen',
      '-c',
      `user.signingkey=${keyFile}`,
      'tag',
      '-s',
      tag,
      sha,
      '-F',
      msg,
    ]);
  };
  return {
    root,
    repo,
    sha,
    owner,
    attacker,
    envFile,
    cli,
    sign,
    signers: `owner@example.test ${owner.pub}\n`,
  };
}

(HAS_SSH ? describe : describe.skip)('release authority through the CLI', () => {
  it('approve prepares a payload and the owner’s command, and signs nothing', () => {
    const w = wrapper(true);
    const r = w.cli(['approve', 'pinboard', '--sha', 'HEAD', '--json']);
    expect(r.code, r.err).toBe(0);
    const { tag, approval } = JSON.parse(r.out);
    expect(approval).toMatchObject({
      v: 1,
      tool: 'pinboard',
      sha: w.sha,
      repo: 'acme/site',
      env: 'prod',
    });
    expect(tag).toBe(`release/pinboard/${w.sha.slice(0, 12)}-${approval.nonce}`);
    expect(sh(w.repo, 'git', ['tag', '--list'])).toBe('');
    const text = w.cli(['approve', 'pinboard', '--sha', 'HEAD']).out;
    expect(text).toContain('this command holds no key');
    expect(text).toMatch(/git -c gpg\.format=ssh tag -s release\/pinboard\//);
    expect(w.cli(['approve', 'nope', '--sha', 'HEAD']).code).not.toBe(0);
    expect(w.cli(['approve', 'pinboard', '--sha', 'HEAD', '--expires', '100h']).code).toBe(2);
    expect(w.cli(['approve', 'pinboard']).code).toBe(2);
  }, 60_000);

  it('verify authorizes the owner’s tag, refuses a forged one, and the guard follows (A-06, A-15, A-16)', () => {
    const w = wrapper(true);
    const env = { GREENLIGHT_RELEASE_SIGNERS: w.signers, GITHUB_ENV: w.envFile };
    // No tag yet: refused, and a production deploy is refused before it builds anything.
    const none = w.cli(['release', 'verify', 'pinboard', '--dry-run'], env);
    expect(none.code).toBe(4);
    expect(none.err).toContain('no approval tag');
    const blocked = w.cli(['deploy', 'pinboard', '--env', 'prod']);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain('GREENLIGHT_RELEASE_AUTHORIZED is not set');

    // A tag an agent can push, signed with a key that is not on the list.
    const forged = JSON.parse(w.cli(['approve', 'pinboard', '--sha', 'HEAD', '--json']).out);
    w.sign(w.attacker.file, forged.tag, forged.approval);
    const bad = w.cli(['release', 'verify', 'pinboard', '--dry-run'], env);
    expect(bad.code).toBe(4);
    expect(bad.err).toContain('does not verify against the allowed signers');

    // The owner's.
    const real = JSON.parse(w.cli(['approve', 'pinboard', '--sha', 'HEAD', '--json']).out);
    w.sign(w.owner.file, real.tag, real.approval);
    const ok = w.cli(['release', 'verify', 'pinboard', '--dry-run', '--json'], env);
    expect(ok.code, ok.err).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({
      enforced: true,
      ok: true,
      tag: real.tag,
      authorized: `pinboard@${w.sha}`,
      dryRun: true,
    });
    // A dry run exports nothing.
    expect(readFileSync(w.envFile, 'utf8')).toBe('');

    // Without a token the nonce cannot be recorded, so a real verification is refused (exit 3).
    expect(w.cli(['release', 'verify', 'pinboard'], env).code).toBe(3);
    // Without a signer list nobody is trusted (exit 3).
    expect(
      w.cli(['release', 'verify', 'pinboard', '--dry-run'], { GITHUB_ENV: w.envFile }).code,
    ).toBe(3);

    // The guard accepts exactly the authorized tool and commit.
    const wrong = w.cli(['deploy', 'pinboard', '--env', 'prod'], {
      GREENLIGHT_RELEASE_AUTHORIZED: `other@${w.sha}`,
    });
    expect(wrong.err).toContain('authorized other@');
    const right = w.cli(['deploy', 'pinboard', '--env', 'prod'], {
      GREENLIGHT_RELEASE_AUTHORIZED: `pinboard@${w.sha}`,
    });
    expect(right.err).not.toContain('production operation refused');
  }, 120_000);

  it('is not enforced until the manifest opts in', () => {
    const w = wrapper(false);
    const r = w.cli(['release', 'verify', 'pinboard']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('not enforced');
    const d = w.cli(['deploy', 'pinboard', '--env', 'prod']);
    expect(d.err).not.toContain('production operation refused');
    expect(w.cli(['approve', 'pinboard', '--sha', 'HEAD']).out).toContain(
      'do not check approvals yet',
    );
  }, 60_000);
});
