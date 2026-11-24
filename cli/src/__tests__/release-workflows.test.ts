import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '@rtrentjones/greenlight-shared';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { releaseAuthorityChecks } from '../commands/doctor';
import {
  productionWorkflowFindings,
  releaseVerifySteps,
  releaseWorkflowYml,
} from '../release-workflows';

const problems = (yml: string, file = 'x.yml') =>
  productionWorkflowFindings(file, yml).map(
    (f) => `${f.severity}:${f.job ?? '-'}:${f.problem.slice(0, 40)}`,
  );

const job = (steps: string, on = 'on:\n  workflow_dispatch:\n') =>
  `${on}jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
const VERIFY = `${releaseVerifySteps('blog')}\n`;
const SHIP = '      - run: pnpm exec greenlight ship blog --env prod\n';

describe('DR-34: production jobs verify an approval first (vision 18)', () => {
  it('accepts a production job that verifies before it ships, started by a tag or a dispatch', () => {
    expect(problems(job(VERIFY + SHIP))).toEqual([]);
    expect(problems(job(VERIFY + SHIP, "on:\n  push:\n    tags: ['release/blog/*']\n"))).toEqual(
      [],
    );
    expect(
      problems(job(VERIFY + SHIP, 'on:\n  repository_dispatch:\n    types: [deploy-blog]\n')),
    ).toEqual([]);
  });

  it('ignores workflows that never touch production', () => {
    expect(
      problems(
        job(
          '      - run: pnpm exec greenlight ship blog --env beta\n',
          'on:\n  push:\n    branches: [develop]\n',
        ),
      ),
    ).toEqual([]);
    expect(problems(job('      - run: pnpm test\n', 'on: push\n'))).toEqual([]);
    expect(problems(job('      - run: pnpm exec wrangler deploy --env beta\n'))).toEqual([]);
  });

  it('fails a production job with no verification, or one that verifies too late', () => {
    expect(problems(job(SHIP))).toEqual(['fail:deploy:changes production and never runs `green']);
    expect(problems(job(SHIP + VERIFY))).toEqual([
      'fail:deploy:`greenlight release verify` runs after t',
    ]);
  });

  it('fails a production workflow started by a push to a branch, in every spelling', () => {
    for (const on of [
      'on: push\n',
      'on: [push, workflow_dispatch]\n',
      'on:\n  push:\n',
      'on:\n  push:\n    branches: [main]\n',
      "on:\n  push:\n    branches-ignore: [x]\n    tags: ['release/**']\n",
    ]) {
      expect(problems(job(VERIFY + SHIP, on)), on).toEqual([
        'fail:-:a production workflow is started by a pu',
      ]);
    }
  });

  it('knows the ways a job reaches production', () => {
    const prod = [
      '      - run: pnpm exec greenlight ship blog --env "${{ steps.env.outputs.env }}"\n',
      '      - run: pnpm exec greenlight deploy muse --env=prod\n',
      '      - run: terraform -chdir=infra apply -auto-approve\n',
      '      - run: npx wrangler deploy\n',
      '      - run: vercel deploy --prebuilt --prod\n',
      '      - uses: ./.github/actions/oci-deploy-verify\n',
    ];
    for (const step of prod) expect(problems(job(step)), step).toHaveLength(1);
    // The production environment alone marks a job, whatever its steps are.
    const envJob =
      'on:\n  workflow_dispatch:\njobs:\n  release:\n    environment: production\n    steps:\n      - run: ./do-it.sh\n';
    expect(problems(envJob)).toEqual(['fail:release:changes production and never runs `green']);
  });

  it('reports a recovery job as a warning: it cannot take a fresh approval (18 §6)', () => {
    const heal = job(
      '      - uses: ./.github/actions/oci-deploy-verify\n',
      'on:\n  repository_dispatch:\n    types: [remediate-bamcp]\n',
    );
    expect(problems(heal, 'greenlight-remediate-bamcp.yml')).toEqual([
      'warn:deploy:a recovery job restarts production witho',
    ]);
  });

  it('says so when a workflow is not YAML', () => {
    expect(problems('on: [unclosed')).toEqual(['fail:-:the workflow does not parse as YAML']);
  });
});

describe('doctor: release authority', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (yml: string) => {
    const root = mkdtempSync(join(tmpdir(), 'greenlight-dr34-'));
    dirs.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/deploy.yml'), yml);
    return root;
  };
  const config = (enforced: boolean) =>
    ConfigSchema.parse({
      domain: 'example.test',
      alerts: { sink: 'github-issue' },
      ...(enforced ? { release: { approval: 'signed-tag' } } : {}),
    });

  it('is skipped, not warned, until the manifest opts in', () => {
    const checks = releaseAuthorityChecks(config(false), repo(job(SHIP, 'on: push\n')));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: 'skip',
      detail: expect.stringContaining('not enforced'),
    });
  });

  it('fails an ungated production job once enforced, and passes a gated one', () => {
    const bad = releaseAuthorityChecks(config(true), repo(job(SHIP, 'on: push\n')));
    expect(bad.map((c) => c.status)).toEqual(['fail', 'fail']);
    expect(bad[0]?.detail).toContain('deploy.yml › deploy');
    const good = releaseAuthorityChecks(config(true), repo(job(VERIFY + SHIP)));
    expect(good).toEqual([
      {
        name: 'release authority (DR-34)',
        status: 'ok',
        detail: 'every production job verifies an approval first',
      },
    ]);
  });

  it('refuses an unknown release setting', () => {
    expect(() =>
      ConfigSchema.parse({
        domain: 'example.test',
        alerts: { sink: 'github-issue' },
        release: { approval: 'none' },
      }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({
        domain: 'example.test',
        alerts: { sink: 'github-issue' },
        release: { approvals: 'signed-tag' },
      }),
    ).toThrow();
  });
});

describe('release workflow: the generated production workflow', () => {
  const steps = (yml: string): string[] =>
    (parse(yml).jobs.release.steps as { name?: string; run?: string; uses?: string }[]).map(
      (s) => s.name ?? s.run ?? s.uses ?? '',
    );

  it('passes DR-34 as written, for every target, with and without a beta', () => {
    for (const target of ['workers', 'vercel', 'oci', 'docker']) {
      for (const beta of [true, false]) {
        const yml = releaseWorkflowYml('pinboard', { target, beta });
        expect(productionWorkflowFindings('release-pinboard.yml', yml)).toEqual([]);
      }
    }
  });

  it('starts only from the tool’s approval tag and verifies before anything else it does', () => {
    const yml = releaseWorkflowYml('pinboard', { target: 'workers', beta: true });
    const doc = parse(yml);
    expect(doc.on).toEqual({ push: { tags: ['release/pinboard/*'] } });
    expect(doc.permissions).toEqual({ contents: 'write', deployments: 'write' });
    const order = steps(yml);
    const at = (needle: string) => order.findIndex((s) => s.includes(needle));
    expect(at('Verify the owner-signed release approval')).toBeGreaterThan(-1);
    expect(at('Verify the owner-signed release approval')).toBeLessThan(at('Verify beta'));
    expect(at('Verify beta')).toBeLessThan(at('Fast-forward main'));
    expect(at('Fast-forward main')).toBeLessThan(at('Ship production'));
    expect(yml).toContain('greenlight ship pinboard --env prod --expect-sha "${{ github.sha }}"');
    expect(yml).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
  });

  it('ships directly, read-only, for a tool with no beta', () => {
    const yml = releaseWorkflowYml('my-box', { target: 'docker', beta: false });
    expect(parse(yml).permissions).toEqual({ contents: 'read', deployments: 'write' });
    expect(steps(yml).some((s) => s.includes('Fast-forward main'))).toBe(false);
    expect(yml).toContain('DOCKER_SSH_KEY: ${{ secrets.DOCKER_SSH_KEY_MY_BOX }}');
    expect(releaseWorkflowYml('box', { target: 'oci', beta: false })).toContain(
      'An oci tool resolves its container instance',
    );
  });
});
