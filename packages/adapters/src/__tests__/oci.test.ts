import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdapter,
  dockerConfig,
  ociConfig,
  ociRestartArgs,
  sshDeployArgs,
  wranglerRollbackArgs,
} from '../index';

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

describe('deployStyle (S7 — contract-level, not throw-discovery)', () => {
  it('push targets declare push; vercel declares git', () => {
    const ctx = { domain: 'example.dev', name: 'x' };
    expect(createAdapter('workers', ctx).deployStyle).toBe('push');
    expect(createAdapter('oci', ctx).deployStyle).toBe('push');
    expect(createAdapter('docker', ctx).deployStyle).toBe('push');
    expect(createAdapter('vercel', ctx).deployStyle).toBe('git');
  });
});

describe('rollback (S2 — replaces the throw-only teardown)', () => {
  it('oci/docker return a typed no with the heal path (mutable :prod tag)', async () => {
    const ctx = { domain: 'example.dev', name: 'bamcp' };
    for (const target of ['oci', 'docker'] as const) {
      const r = await createAdapter(target, ctx).rollback?.('.', 'prod');
      expect(r?.ok).toBe(false);
      expect(r?.detail).toMatch(/mutable :prod/);
      expect(r?.detail).toMatch(/follow-up/);
    }
  });

  it('workers without a captured previous version returns the manual path, never throws', async () => {
    const a = createAdapter('workers', { domain: 'example.dev', name: 'x' });
    const r = await a.rollback?.('.', 'prod', undefined);
    expect(r?.ok).toBe(false);
    expect(r?.detail).toMatch(/wrangler rollback/);
  });

  it('vercel has no rollback (git-integration owns its deploys)', () => {
    const a = createAdapter('vercel', { domain: 'example.dev', name: 'x' });
    expect(a.rollback).toBeUndefined();
  });
});

describe('wranglerRollbackArgs', () => {
  it('builds the non-interactive rollback invocation', () => {
    expect(wranglerRollbackArgs('ver-123', 'prod')).toEqual([
      'exec',
      'wrangler',
      'rollback',
      'ver-123',
      '--env',
      'prod',
      '--message',
      'greenlight auto-rollback (post-deploy verify failed)',
    ]);
  });
});
