/**
 * Production workflows and release authority (vision 18 §3, §5; doctor rule DR-34).
 *
 * A workflow is a PRODUCTION workflow when a job in it deploys, ships, migrates, applies or
 * restarts production, or runs in the `production` environment. For each such job the rule is:
 *
 * - its first production operation comes AFTER a step that runs `greenlight release verify`
 *   (the step that verifies the owner-signed approval and sets GREENLIGHT_RELEASE_AUTHORIZED);
 * - the workflow is not started by a push to a branch. A push may start it only through an
 *   approval tag (`push.tags: release/**`); `workflow_dispatch` and `repository_dispatch` are
 *   fine, because the job verifies whatever starts it.
 *
 * The check reads the YAML only. Whether the `production` environment really has required
 * reviewers is a remote fact (18 §3.2) and belongs to `doctor --live`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Shell text that changes production. */
const PROD_OPERATION = new RegExp(
  [
    // `greenlight ship|deploy <name> --env <x>` unless <x> is literally beta or preview: a computed
    // env ("${{ steps.env.outputs.env }}") can be prod, so the job is production-capable.
    String.raw`greenlight\s+(?:ship|deploy)\b[^\n]*--env[= ](?!["']?(?:beta|preview)\b)`,
    String.raw`terraform\b[^\n]*\b(?:apply|destroy)\b`,
    String.raw`wrangler\s+deploy\b(?![^\n]*--env[= ]["']?(?:beta|preview)\b)`,
    String.raw`vercel\s+(?:deploy[^\n]*--prod|promote|alias)\b`,
    // The container-target composites restart the production instance.
    String.raw`(?:oci|docker)-deploy(?:-verify)?\b`,
  ].join('|'),
);
const VERIFY_STEP = /greenlight\s+release\s+verify\b/;

export interface WorkflowFinding {
  file: string;
  job?: string;
  problem: string;
  /** `warn` for a recovery job: it must not take a fresh approval (18 §6), and the rule that it
   * redeploys the last approved artifact (DR-36) is not built, so it is reported, not failed. */
  severity: 'fail' | 'warn';
}

/** A self-heal or recovery job: started by the keepalive Worker, with nobody there to approve. */
const RECOVERY = /remediat|self-?heal|recover/i;

type Step = { run?: unknown; uses?: unknown; with?: unknown };
type Job = { steps?: unknown; environment?: unknown };

const stepText = (s: Step): string =>
  [
    typeof s.run === 'string' ? s.run : '',
    typeof s.uses === 'string' ? s.uses : '',
    s.with ? JSON.stringify(s.with) : '',
  ].join('\n');

const envName = (e: unknown): string | undefined =>
  typeof e === 'string'
    ? e
    : e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string'
      ? ((e as { name: string }).name as string)
      : undefined;

/** Branch-push triggers of a workflow's `on:` (a YAML 1.1 parser may read the key as `true`). */
function pushesBranches(doc: Record<string, unknown>): boolean {
  const on = doc.on ?? (doc as Record<string, unknown>).true;
  if (on === 'push') return true;
  if (Array.isArray(on)) return on.includes('push');
  if (!on || typeof on !== 'object') return false;
  if (!('push' in on)) return false;
  const push = (on as { push?: unknown }).push;
  if (push === null || push === undefined || typeof push !== 'object') return true;
  const p = push as { branches?: unknown; tags?: unknown; 'branches-ignore'?: unknown };
  // `push: { tags: [...] }` alone starts on tags only; any branch filter, or none at all with no
  // tags filter, starts on branch pushes.
  if (p.branches !== undefined || p['branches-ignore'] !== undefined) return true;
  return p.tags === undefined;
}

/** DR-34 findings for one workflow's text. Empty when it is not a production workflow, or is one
 * that verifies first. */
export function productionWorkflowFindings(file: string, text: string): WorkflowFinding[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return [{ file, problem: 'the workflow does not parse as YAML', severity: 'fail' }];
  }
  if (!doc || typeof doc !== 'object') return [];
  const jobs = (doc as { jobs?: unknown }).jobs;
  if (!jobs || typeof jobs !== 'object') return [];
  const out: WorkflowFinding[] = [];
  let production = false;
  for (const [id, raw] of Object.entries(jobs as Record<string, Job>)) {
    const steps = Array.isArray(raw?.steps) ? (raw.steps as Step[]) : [];
    const firstProd = steps.findIndex((s) => PROD_OPERATION.test(stepText(s)));
    const inProdEnv = envName(raw?.environment) === 'production';
    if (firstProd === -1 && !inProdEnv) continue;
    production = true;
    const verify = steps.findIndex((s) => VERIFY_STEP.test(stepText(s)));
    if (verify === -1 && (RECOVERY.test(file) || RECOVERY.test(id))) {
      out.push({
        file,
        job: id,
        severity: 'warn',
        problem:
          'a recovery job restarts production without an approval: it should redeploy the last approved artifact (vision 18 §6, DR-36, not built)',
      });
    } else if (verify === -1) {
      out.push({
        file,
        job: id,
        severity: 'fail',
        problem:
          'changes production and never runs `greenlight release verify` (the owner-signed approval is not checked)',
      });
    } else if (firstProd !== -1 && verify > firstProd) {
      out.push({
        file,
        job: id,
        severity: 'fail',
        problem: '`greenlight release verify` runs after the first production operation',
      });
    }
  }
  if (production && pushesBranches(doc as Record<string, unknown>)) {
    out.push({
      file,
      severity: 'fail',
      problem:
        'a production workflow is started by a push to a branch: start it from an approval tag (push.tags: release/**) or a dispatch',
    });
  }
  return out;
}

/** DR-34 over every workflow of a repository. */
export function releaseWorkflowFindings(root: string): WorkflowFinding[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .flatMap((f) => productionWorkflowFindings(f, readFileSync(join(dir, f), 'utf8')));
}

/**
 * The steps a production job starts with. They need the full tag list (an approval is a tag), the
 * signer list, and a token that may record the consumed nonce as a deployment, so the job needs
 * `permissions: { contents: read, deployments: write }`.
 */
export function releaseVerifySteps(name: string, artifactExpr?: string): string {
  return `      - name: Fetch approval tags
        run: git fetch --force --tags origin 'refs/tags/release/${name}/*:refs/tags/release/${name}/*'
      - name: Verify the owner-signed release approval (vision 18)
        env:
          GREENLIGHT_RELEASE_SIGNERS: \${{ secrets.GREENLIGHT_RELEASE_SIGNERS }}
          GITHUB_TOKEN: \${{ github.token }}
        run: pnpm exec greenlight release verify ${name}${artifactExpr ? ` --artifact "${artifactExpr}"` : ''}`;
}

const TARGET_SECRETS: Readonly<Record<string, readonly string[]>> = {
  workers: ['CLOUDFLARE_API_TOKEN'],
  vercel: ['VERCEL_API_TOKEN'],
};

export interface ReleaseWorkflowOptions {
  target: string;
  /** The tool has a beta: verify it at the approved commit, then fast-forward `main` to it. */
  beta: boolean;
}

/**
 * A complete production workflow for one tool under release authority: started by the owner's
 * approval tag, it verifies the approval first, then (with a beta) verifies beta at the approved
 * commit and fast-forwards `main` to it, then ships production at that commit. It is what
 * `greenlight release workflow <name>` prints, and it passes DR-34 as written.
 */
export function releaseWorkflowYml(name: string, o: ReleaseWorkflowOptions): string {
  const SUF = name.toUpperCase().replace(/-/g, '_');
  const secrets =
    o.target === 'docker'
      ? ['HOST', 'USER', 'KEY', 'PORT'].map(
          (k) => `          DOCKER_SSH_${k}: \${{ secrets.DOCKER_SSH_${k}_${SUF} }}`,
        )
      : (TARGET_SECRETS[o.target] ?? []).map((k) => `          ${k}: \${{ secrets.${k} }}`);
  const env = secrets.length > 0 ? `        env:\n${secrets.join('\n')}\n` : '';
  const ociNote =
    o.target === 'oci'
      ? '      # An oci tool resolves its container instance before it ships: keep the OCI CLI setup and\n      # the instance lookup from your deploy listener here, between verification and this step.\n'
      : '';
  const betaSteps = o.beta
    ? `      - name: Verify beta at the approved commit
${env}        run: pnpm exec greenlight verify ${name} --env beta --expect-sha "\${{ github.sha }}"
      - name: Fast-forward main to the approved commit
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git fetch --no-tags origin main develop
          pnpm exec greenlight promote ${name} --perform --push --commit "\${{ github.sha }}"
`
    : '';
  return `name: release-${name}

# Production for ${name}, under release authority (docs/release-authority.md). It starts when the
# owner pushes a signed approval tag, release/${name}/<sha12>-<nonce>, and at no other time: a push
# to a branch never reaches production. The first thing the job does is verify that approval.
on:
  push:
    tags: ['release/${name}/*']

permissions:
  contents: ${o.beta ? 'write # the fast-forward of main' : 'read'}
  deployments: write # records the approval as used

concurrency:
  group: release-${name}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          fetch-depth: 0
      - uses: jdx/mise-action@c37c93293d6b742fc901e1406b8f764f6fb19dac # v2.4.4
      - run: pnpm install --frozen-lockfile
${releaseVerifySteps(name)}
${betaSteps}${ociNote}      - name: Ship production (build -> deploy -> SHA-gated verify -> rollback on failure)
${env}        run: pnpm exec greenlight ship ${name} --env prod --expect-sha "\${{ github.sha }}"
`;
}
