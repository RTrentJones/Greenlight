import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  listGitHubSecrets,
  ociPrefill,
  parseOciConfig,
  parseRepo,
  parseSecretsEnv,
  setGitHubSecret,
} from '../commands/secrets';

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

describe('parseOciConfig', () => {
  it('parses the Add-API-key config preview (lowercased keys, [PROFILE] + comments ignored)', () => {
    const cfg = parseOciConfig(
      [
        '[DEFAULT]',
        'user=ocid1.user.oc1..aaaa',
        'fingerprint=12:34:56',
        'tenancy=ocid1.tenancy.oc1..bbbb',
        'region=us-ashburn-1',
        'key_file=/home/me/.oci/key.pem',
        '# a comment',
      ].join('\n'),
    );
    expect(cfg).toMatchObject({
      user: 'ocid1.user.oc1..aaaa',
      fingerprint: '12:34:56',
      tenancy: 'ocid1.tenancy.oc1..bbbb',
      region: 'us-ashburn-1',
      key_file: '/home/me/.oci/key.pem',
    });
  });

  it('first profile wins (later duplicate keys ignored)', () => {
    const cfg = parseOciConfig('[DEFAULT]\nregion=us-ashburn-1\n[OTHER]\nregion=uk-london-1');
    expect(cfg.region).toBe('us-ashburn-1');
  });
});

describe('ociPrefill', () => {
  it('maps the config + PEM to the 5 OCI auth secrets (private key read from the file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gl-oci-'));
    const pem = join(dir, 'key.pem');
    writeFileSync(pem, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    const cfgPath = join(dir, 'config');
    writeFileSync(
      cfgPath,
      `[DEFAULT]\nuser=ocid1.user\nfingerprint=fp\ntenancy=ocid1.tenancy\nregion=us-ashburn-1\nkey_file=${pem}\n`,
    );
    const map = ociPrefill(cfgPath);
    expect(map.get('TF_VAR_OCI_USER_OCID')).toBe('ocid1.user');
    expect(map.get('TF_VAR_OCI_TENANCY_OCID')).toBe('ocid1.tenancy');
    expect(map.get('TF_VAR_OCI_FINGERPRINT')).toBe('fp');
    expect(map.get('TF_VAR_OCI_REGION')).toBe('us-ashburn-1');
    expect(map.get('TF_VAR_OCI_PRIVATE_KEY')).toContain('BEGIN PRIVATE KEY');
  });

  it('--oci-key overrides the config key_file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gl-oci-'));
    const realPem = join(dir, 'real.pem');
    writeFileSync(realPem, 'REAL-PEM');
    const cfgPath = join(dir, 'config');
    writeFileSync(cfgPath, '[DEFAULT]\nuser=u\nkey_file=/does/not/exist.pem\n');
    const map = ociPrefill(cfgPath, realPem);
    expect(map.get('TF_VAR_OCI_PRIVATE_KEY')).toBe('REAL-PEM');
  });

  it('skips the private key (still prefills the rest) when no PEM is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gl-oci-'));
    const cfgPath = join(dir, 'config');
    writeFileSync(cfgPath, '[DEFAULT]\ntenancy=ocid1.tenancy\nkey_file=/does/not/exist.pem\n');
    const map = ociPrefill(cfgPath);
    expect(map.has('TF_VAR_OCI_PRIVATE_KEY')).toBe(false);
    expect(map.get('TF_VAR_OCI_TENANCY_OCID')).toBe('ocid1.tenancy');
  });
});

describe('listGitHubSecrets', () => {
  it('parses `gh secret list --json name` into a name set (so gather can flag overrides)', () => {
    const gh = vi.mocked(execFileSync);
    gh.mockClear();
    gh.mockReturnValueOnce(
      JSON.stringify([{ name: 'TF_VAR_OCI_REGION' }, { name: 'GREENLIGHT_STATUS_TOKEN' }]),
    );
    const set = listGitHubSecrets('o/r', undefined);
    expect(gh).toHaveBeenCalledWith(
      'gh',
      ['secret', 'list', '--repo', 'o/r', '--json', 'name'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(set?.has('TF_VAR_OCI_REGION')).toBe(true);
    expect(set?.has('NOPE')).toBe(false);
  });

  it('scopes to an env and returns null when gh fails (advisory only, never blocks)', () => {
    const gh = vi.mocked(execFileSync);
    gh.mockClear();
    gh.mockImplementationOnce(() => {
      throw new Error('gh: not authenticated');
    });
    expect(listGitHubSecrets('o/r', 'prod')).toBeNull();
    expect(gh).toHaveBeenCalledWith(
      'gh',
      ['secret', 'list', '--repo', 'o/r', '--json', 'name', '--env', 'prod'],
      expect.anything(),
    );
  });
});
