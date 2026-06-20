import { describe, expect, it } from 'vitest';
import { createAdapter, ociConfig, ociImageRef, ociRemoteDeployScript } from '../index';

describe('ociConfig', () => {
  it('reads registry/host/user and derives owner from GHCR_OWNER', () => {
    const cfg = ociConfig({
      OCI_REGISTRY: 'ghcr.io',
      GHCR_OWNER: 'acme',
      OCI_DEPLOY_HOST: '1.2.3.4',
      OCI_DEPLOY_USER: 'opc',
    });
    expect(cfg).toMatchObject({ registry: 'ghcr.io', owner: 'acme', host: '1.2.3.4', user: 'opc' });
  });

  it('falls back to the owner from GITHUB_REPOSITORY', () => {
    expect(ociConfig({ GITHUB_REPOSITORY: 'acme/bamcp' }).owner).toBe('acme');
  });
});

describe('ociImageRef', () => {
  it('builds <registry>/<owner>/<tool>:<env>', () => {
    expect(ociImageRef('bamcp', 'prod', { registry: 'ghcr.io', owner: 'acme' })).toBe(
      'ghcr.io/acme/bamcp:prod',
    );
    expect(ociImageRef('bamcp', 'beta', { owner: 'acme' })).toBe('ghcr.io/acme/bamcp:beta');
  });

  it('throws when the owner is missing', () => {
    expect(() => ociImageRef('bamcp', 'prod', {})).toThrow(/GHCR_OWNER/);
  });
});

describe('ociRemoteDeployScript', () => {
  it('pulls, replaces, and runs the container bound to localhost', () => {
    const s = ociRemoteDeployScript('bamcp', 'ghcr.io/acme/bamcp:prod', {});
    expect(s).toContain('docker pull ghcr.io/acme/bamcp:prod');
    expect(s).toContain('docker rm -f bamcp');
    expect(s).toContain('--restart=always');
    expect(s).toContain('-p 127.0.0.1:8000:8000'); // localhost-only; tunnel reaches it
    expect(s).toContain('--env-file ~/bamcp.env');
  });

  it('honors a custom app port and env-file', () => {
    const s = ociRemoteDeployScript('bamcp', 'img', { appPort: '9000', envFile: '/etc/bamcp.env' });
    expect(s).toContain('-p 127.0.0.1:9000:9000');
    expect(s).toContain('--env-file /etc/bamcp.env');
  });
});

describe('createAdapter(oci)', () => {
  it('returns an oci adapter with a deterministic url and a real teardown', () => {
    const a = createAdapter('oci', { domain: 'example.dev', name: 'bamcp' });
    expect(a.target).toBe('oci');
    expect(a.url('prod')).toBe('https://bamcp.example.dev');
    expect(a.url('beta')).toBe('https://beta.bamcp.example.dev');
  });

  it('vercel stays a skeleton (deploy rides git-integration)', async () => {
    const a = createAdapter('vercel', { domain: 'example.dev', name: 'app' });
    await expect(a.deploy('.', 'prod')).rejects.toThrow(/git-integration/);
  });
});
