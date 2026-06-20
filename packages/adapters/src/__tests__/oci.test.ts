import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter, ociConfig, ociRestartArgs } from '../index';

afterEach(() => vi.unstubAllEnvs());

describe('ociConfig', () => {
  it('reads the container instance OCID', () => {
    expect(ociConfig({ OCI_CONTAINER_INSTANCE_OCID: 'ocid1.computecontainerinstance.x' })).toEqual({
      containerInstanceId: 'ocid1.computecontainerinstance.x',
    });
  });

  it('is empty when unset', () => {
    expect(ociConfig({}).containerInstanceId).toBeUndefined();
  });
});

describe('ociRestartArgs', () => {
  it('builds the OCI CLI restart invocation (re-pulls the GHCR image)', () => {
    expect(ociRestartArgs('ocid1.x')).toEqual([
      'container-instances',
      'container-instance',
      'restart',
      '--container-instance-id',
      'ocid1.x',
    ]);
  });
});

describe('createAdapter(oci)', () => {
  it('build is a no-op (the tool CI builds the container)', async () => {
    const a = createAdapter('oci', { domain: 'example.dev', name: 'bamcp' });
    expect(a.target).toBe('oci');
    await expect(a.build('.', 'prod')).resolves.toEqual({ artifactDir: '.' });
  });

  it('has a deterministic url and deploy needs the instance OCID', async () => {
    const a = createAdapter('oci', { domain: 'example.dev', name: 'bamcp' });
    expect(a.url('prod')).toBe('https://bamcp.example.dev');
    expect(a.url('beta')).toBe('https://beta.bamcp.example.dev');
    vi.stubEnv('OCI_CONTAINER_INSTANCE_OCID', '');
    await expect(a.deploy('.', 'prod')).rejects.toThrow(/OCI_CONTAINER_INSTANCE_OCID/);
  });

  it('vercel stays a skeleton (deploy rides git-integration)', async () => {
    const a = createAdapter('vercel', { domain: 'example.dev', name: 'app' });
    await expect(a.deploy('.', 'prod')).rejects.toThrow(/git-integration/);
  });
});
