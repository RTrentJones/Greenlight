import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter, dockerConfig, ociConfig, ociRestartArgs, sshDeployArgs } from '../index';

afterEach(() => vi.unstubAllEnvs());

describe('dockerConfig', () => {
  it('reads SSH facts and defaults user/port/remoteDir', () => {
    expect(
      dockerConfig('bamcp', { DOCKER_SSH_HOST: 'host.example', DOCKER_SSH_KEY: 'KEY' }),
    ).toEqual({
      host: 'host.example',
      user: 'root',
      port: '22',
      remoteDir: 'greenlight/bamcp',
      key: 'KEY',
    });
  });
  it('honours overrides', () => {
    const cfg = dockerConfig('bamcp', {
      DOCKER_SSH_HOST: 'h',
      DOCKER_SSH_USER: 'deploy',
      DOCKER_SSH_PORT: '2222',
      DOCKER_COMPOSE_DIR: '/opt/app',
    });
    expect(cfg).toMatchObject({ user: 'deploy', port: '2222', remoteDir: '/opt/app' });
  });
});

describe('sshDeployArgs', () => {
  it('builds the ssh invocation that re-pulls + restarts the compose', () => {
    const cfg = dockerConfig('bamcp', { DOCKER_SSH_HOST: 'h', DOCKER_SSH_KEY: 'K' });
    expect(sshDeployArgs(cfg, '/tmp/id')).toEqual([
      '-i',
      '/tmp/id',
      '-p',
      '22',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'BatchMode=yes',
      'root@h',
      'cd greenlight/bamcp && docker compose pull && docker compose up -d',
    ]);
  });
});

describe('createAdapter(docker)', () => {
  it('build is a no-op (the tool CI builds the container) and url is deterministic', async () => {
    const a = createAdapter('docker', { domain: 'example.dev', name: 'bamcp' });
    expect(a.target).toBe('docker');
    await expect(a.build('.', 'prod')).resolves.toEqual({ artifactDir: '.' });
    expect(a.url('prod')).toBe('https://bamcp.example.dev');
  });

  it('deploy fails clearly without DOCKER_SSH_HOST', async () => {
    vi.stubEnv('DOCKER_SSH_HOST', '');
    const a = createAdapter('docker', { domain: 'example.dev', name: 'bamcp' });
    await expect(a.deploy('.', 'prod')).rejects.toThrow(/DOCKER_SSH_HOST/);
  });
});

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
