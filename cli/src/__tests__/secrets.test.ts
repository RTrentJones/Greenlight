import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { parseRepo, parseSecretsEnv, setGitHubSecret } from '../commands/secrets';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('parseSecretsEnv', () => {
  it('parses KEY=VALUE, skips blanks and comments, splits on the first =', () => {
    const entries = parseSecretsEnv(
      [
        '# a comment',
        '',
        'CLOUDFLARE_API_TOKEN=abc123',
        'SUPABASE_URL=https://x.supabase.co?a=b', // = inside the value is preserved
        '   ',
        'GITHUB_TOKEN = ghp_xxx ', // trimmed key; value keeps leading space then ghp_xxx
      ].join('\n'),
    );
    expect(entries).toEqual([
      { key: 'CLOUDFLARE_API_TOKEN', value: 'abc123' },
      { key: 'SUPABASE_URL', value: 'https://x.supabase.co?a=b' },
      { key: 'GITHUB_TOKEN', value: ' ghp_xxx' },
    ]);
  });

  it('returns nothing for empty / comment-only input', () => {
    expect(parseSecretsEnv('# only\n\n')).toEqual([]);
  });
});

describe('parseRepo', () => {
  it('extracts owner/repo from each GitHub remote form', () => {
    expect(parseRepo('https://github.com/acme/my-site.git')).toBe('acme/my-site');
    expect(parseRepo('https://github.com/acme/greenlight')).toBe('acme/greenlight');
    expect(parseRepo('git@github.com:acme/greenlight.git')).toBe('acme/greenlight');
    expect(parseRepo('ssh://git@github.com/acme/greenlight.git')).toBe('acme/greenlight');
  });

  it('returns null for a non-GitHub remote', () => {
    expect(parseRepo('https://gitlab.com/x/y.git')).toBeNull();
  });
});

describe('setGitHubSecret', () => {
  it('passes the value on stdin, never in argv (no leak)', () => {
    const gh = vi.mocked(execFileSync);
    gh.mockClear();
    setGitHubSecret('owner/repo', undefined, 'TF_VAR_OCI_TENANCY_OCID', 'ocid1.secret.value');
    expect(gh).toHaveBeenCalledWith(
      'gh',
      ['secret', 'set', 'TF_VAR_OCI_TENANCY_OCID', '--repo', 'owner/repo'],
      { input: 'ocid1.secret.value' },
    );
    // the secret value must not appear anywhere in the argv
    const argv = gh.mock.calls[0]?.[1] as string[];
    expect(argv.join(' ')).not.toContain('ocid1.secret.value');
  });

  it('targets a GitHub Environment when given', () => {
    const gh = vi.mocked(execFileSync);
    gh.mockClear();
    setGitHubSecret('o/r', 'release', 'K', 'v');
    expect(gh).toHaveBeenCalledWith(
      'gh',
      ['secret', 'set', 'K', '--repo', 'o/r', '--env', 'release'],
      {
        input: 'v',
      },
    );
  });
});
