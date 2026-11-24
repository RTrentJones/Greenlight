import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RELEASE_AUTHORIZED_ENV,
  ReleaseNotAuthorizedError,
  approvalProblems,
  assertReleaseAuthorized,
  authorizedValue,
  githubDeploymentNonces,
  memoryNonces,
  parseApproval,
  parseAuthorized,
  prepareApproval,
  verifyApproval,
} from '../approval';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const sh = (cwd: string, cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const HAS_SSH = spawnSync('ssh-keygen', ['-?']).error === undefined;

const NOW = new Date('2026-11-24T12:00:00.000Z');
const SHA = 'a'.repeat(40);
const base = { tool: 'blog', sha: SHA, repo: 'acme/site', now: NOW, nonce: '0123abcd' };

describe('the approval payload', () => {
  it('is prepared with a bounded lifetime and a tag name that carries the nonce', () => {
    const { approval, tag } = prepareApproval(base);
    expect(tag).toBe(`release/blog/${'a'.repeat(12)}-0123abcd`);
    expect(approval).toEqual({
      v: 1,
      tool: 'blog',
      sha: SHA,
      repo: 'acme/site',
      env: 'prod',
      expiresAt: '2026-11-25T12:00:00.000Z',
      nonce: '0123abcd',
    });
    expect(() => prepareApproval({ ...base, expiresInHours: 73 })).toThrow(/at most 72 hours/);
    expect(prepareApproval({ ...base, nonce: undefined }).approval.nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  it('refuses malformed payloads, and fields nothing checks', () => {
    const good = JSON.stringify(prepareApproval(base).approval);
    expect(parseApproval(good).ok).toBe(true);
    expect(parseApproval('not json')).toEqual({
      ok: false,
      errors: ['the tag message is not JSON'],
    });
    const bad = (edit: Record<string, unknown>) => {
      const r = parseApproval(JSON.stringify({ ...JSON.parse(good), ...edit }));
      return r.ok ? [] : r.errors;
    };
    expect(bad({ env: 'beta' })).toEqual(['env must be "prod"']);
    expect(bad({ sha: 'abc' })).toEqual(['sha is not a 40-hex commit']);
    expect(bad({ extra: 1 })).toEqual(['unknown field "extra"']);
    expect(bad({ policyChange: false })).toEqual(['policyChange, when present, must be true']);
  });

  it('authorizes only the job it names (A-15, A-17)', () => {
    const { approval, tag } = prepareApproval({ ...base, artifact: 'sha256:d1' });
    const job = {
      tool: 'blog',
      sha: SHA,
      repo: 'acme/site',
      headSha: SHA,
      artifact: 'sha256:d1',
      now: NOW,
    };
    expect(approvalProblems(approval, tag, job)).toEqual([]);
    expect(approvalProblems(approval, tag, { ...job, tool: 'muse' })[0]).toMatch(
      /approved tool "blog"/,
    );
    const other = 'b'.repeat(40);
    expect(approvalProblems(approval, tag, { ...job, sha: other, headSha: other })).toHaveLength(2);
    expect(approvalProblems(approval, tag, { ...job, headSha: other })[0]).toMatch(
      /HEAD is bbbbbbbbbbbb/,
    );
    expect(approvalProblems(approval, tag, { ...job, repo: 'evil/site' })[0]).toMatch(
      /approved repo/,
    );
    expect(approvalProblems(approval, tag, { ...job, artifact: 'sha256:d2' })[0]).toMatch(
      /approved artifact/,
    );
    expect(approvalProblems(approval, tag, { ...job, artifact: undefined })[0]).toMatch(
      /job names none/,
    );
    const later = new Date('2026-11-25T12:00:00.000Z');
    expect(approvalProblems(approval, tag, { ...job, now: later })[0]).toMatch(/expired/);
    // A payload under a tag name that is not its own is refused.
    expect(approvalProblems(approval, 'release/blog/aaaaaaaaaaaa-ffffffff', job)[0]).toMatch(
      /tag name/,
    );
    // A hand-written far-future expiry does not outlive the cap.
    const long = { ...approval, expiresAt: '2027-01-01T00:00:00.000Z' };
    expect(approvalProblems(long, tag, job)[0]).toMatch(/more than 72 hours/);
  });
});

describe('GREENLIGHT_RELEASE_AUTHORIZED (18 §3.1a)', () => {
  it('round-trips, and guards a production operation', () => {
    const v = authorizedValue({ tool: 'blog', sha: SHA, artifact: 'ver_1' });
    expect(v).toBe(`blog@${SHA}#ver_1`);
    expect(parseAuthorized(v)).toEqual({ tool: 'blog', sha: SHA, artifact: 'ver_1' });
    expect(parseAuthorized('blog')).toBeNull();
    const env = { [RELEASE_AUTHORIZED_ENV]: v };
    expect(() =>
      assertReleaseAuthorized({ tool: 'blog', sha: SHA, artifact: 'ver_1' }, env),
    ).not.toThrow();
    expect(() => assertReleaseAuthorized({ tool: 'blog', sha: SHA }, {})).toThrow(
      ReleaseNotAuthorizedError,
    );
    expect(() =>
      assertReleaseAuthorized({ tool: 'muse', sha: SHA, artifact: 'ver_1' }, env),
    ).toThrow(/authorized blog@/);
    expect(() =>
      assertReleaseAuthorized({ tool: 'blog', sha: SHA, artifact: 'ver_2' }, env),
    ).toThrow(/artifact/);
    // An approval that bound no artifact covers the tool at the commit.
    const loose = { [RELEASE_AUTHORIZED_ENV]: authorizedValue({ tool: 'blog', sha: SHA }) };
    expect(() =>
      assertReleaseAuthorized({ tool: 'blog', sha: SHA, artifact: 'ver_9' }, loose),
    ).not.toThrow();
  });
});

describe('consumed nonces as GitHub deployments', () => {
  it('reads and records through the deployments API, and fails closed', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    let found = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if ((init?.method ?? 'GET') === 'POST') {
        found = true;
        return new Response('{}', { status: 201 });
      }
      return new Response(JSON.stringify(found ? [{ id: 1 }] : []), { status: 200 });
    }) as unknown as typeof fetch;
    const store = githubDeploymentNonces({ repo: 'acme/site', token: 't', fetchImpl });
    const { approval, tag } = prepareApproval(base);
    expect(await store.consumed(approval.nonce)).toBe(false);
    await store.consume(approval, tag);
    expect(await store.consumed(approval.nonce)).toBe(true);
    expect(calls[0]?.url).toContain(
      '/repos/acme/site/deployments?environment=production&task=greenlight-release%3A0123abcd',
    );
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({
      ref: SHA,
      environment: 'production',
      task: 'greenlight-release:0123abcd',
      required_contexts: [],
      payload: { tag, tool: 'blog' },
    });
    const down = githubDeploymentNonces({
      repo: 'acme/site',
      token: 't',
      fetchImpl: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
    });
    await expect(down.consumed('0123abcd')).rejects.toThrow(/nonce is unchecked/);
  });
});

(HAS_SSH ? describe : describe.skip)('verifyApproval against real signed tags', () => {
  /** A repository with one commit, an owner key and an attacker key. */
  function world() {
    const root = tmp('greenlight-approval-');
    const repo = join(root, 'repo');
    sh(root, 'git', ['init', '-q', '-b', 'main', repo]);
    sh(repo, 'git', ['config', 'user.email', 'owner@example.test']);
    sh(repo, 'git', ['config', 'user.name', 'Owner']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
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
    const signers = `owner@example.test ${owner.pub}\n`;
    const sign = (keyFile: string, tag: string, payload: unknown, at = sha) => {
      const msg = join(root, `${tag.replace(/\//g, '_')}.json`);
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
        at,
        '-F',
        msg,
      ]);
    };
    return { root, repo, sha, owner, attacker, signers, sign };
  }
  const job = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => ({
    repoDir: w.repo,
    tool: 'blog',
    repo: 'acme/site',
    allowedSigners: w.signers,
    nonces: memoryNonces(),
    now: NOW,
    ...over,
  });

  it('accepts an owner-signed approval exactly once (A-16, A-14)', async () => {
    const w = world();
    const { approval, tag } = prepareApproval({ ...base, sha: w.sha });
    w.sign(w.owner.file, tag, approval);
    const nonces = memoryNonces();
    const first = await verifyApproval(job(w, { nonces }));
    expect(first).toMatchObject({ ok: true, tag, authorized: `blog@${w.sha}` });
    const again = await verifyApproval(job(w, { nonces }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.tags[0]?.problems[0]).toMatch(/already consumed/);
  });

  it('a dry run checks everything and leaves the approval usable', async () => {
    const w = world();
    const { approval, tag } = prepareApproval({ ...base, sha: w.sha });
    w.sign(w.owner.file, tag, approval);
    const nonces = memoryNonces();
    expect((await verifyApproval(job(w, { nonces, dryRun: true }))).ok).toBe(true);
    expect((await verifyApproval(job(w, { nonces }))).ok).toBe(true);
  });

  it('refuses a tag signed by a key that is not on the list, an unsigned tag and a lightweight tag (A-06)', async () => {
    const w = world();
    const p = (nonce: string) => prepareApproval({ ...base, sha: w.sha, nonce });
    const forged = p('00000001');
    w.sign(w.attacker.file, forged.tag, forged.approval);
    const unsigned = p('00000002');
    sh(w.repo, 'git', ['tag', '-a', unsigned.tag, '-m', JSON.stringify(unsigned.approval)]);
    const light = p('00000003');
    sh(w.repo, 'git', ['tag', light.tag]);
    const r = await verifyApproval(job(w));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.tags.map((t) => t.problems[0])).toEqual([
      'the signature does not verify against the allowed signers',
      'the tag is not signed',
      'not an annotated tag (a lightweight tag carries no signature)',
    ]);
  });

  it('refuses with no trusted signer, with no tag, and for another tool or commit (A-05, A-15)', async () => {
    const w = world();
    expect(await verifyApproval(job(w, { allowedSigners: ' ' }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no signer is trusted/),
    });
    expect(await verifyApproval(job(w))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no approval tag release\/blog\//),
    });
    const { approval, tag } = prepareApproval({ ...base, sha: w.sha });
    w.sign(w.owner.file, tag, approval);
    // The approval is for blog: the muse job finds no tag of its own.
    expect((await verifyApproval(job(w, { tool: 'muse' }))).ok).toBe(false);
    // A later commit is not covered by an approval for the earlier one.
    writeFileSync(join(w.repo, 'a.txt'), 'two\n');
    sh(w.repo, 'git', ['commit', '-q', '-am', 'two']);
    expect((await verifyApproval(job(w))).ok).toBe(false);
    const stale = await verifyApproval(job(w, { sha: w.sha }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.tags[0]?.problems[0]).toMatch(/HEAD is/);
  });

  it('binds the artifact, the repository and the expiry (A-15, A-17)', async () => {
    const w = world();
    const { approval, tag } = prepareApproval({ ...base, sha: w.sha, artifact: 'sha256:d1' });
    w.sign(w.owner.file, tag, approval);
    const why = async (over: Record<string, unknown>) => {
      const r = await verifyApproval(job(w, over));
      return r.ok ? 'ok' : (r.tags[0]?.problems[0] ?? r.reason);
    };
    expect(await why({ artifact: 'sha256:d2' })).toMatch(/approved artifact sha256:d1/);
    expect(await why({ repo: 'acme/other', artifact: 'sha256:d1' })).toMatch(/approved repo/);
    expect(await why({ now: new Date('2026-11-26T00:00:00.000Z'), artifact: 'sha256:d1' })).toMatch(
      /expired/,
    );
    expect(await why({ artifact: 'sha256:d1' })).toBe('ok');
  });

  it('a signed payload moved under another tag name is refused', async () => {
    const w = world();
    const { approval } = prepareApproval({ ...base, sha: w.sha });
    w.sign(w.owner.file, `release/blog/${w.sha.slice(0, 12)}-ffffffff`, approval);
    const r = await verifyApproval(job(w));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.tags[0]?.problems[0]).toMatch(/tag name does not match/);
  });
});
