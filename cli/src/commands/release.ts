import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  RELEASE_AUTHORIZED_ENV,
  RELEASE_SIGNERS_ENV,
  assertReleaseAuthorized,
  githubDeploymentNonces,
  headSha,
  memoryNonces,
  prepareApproval,
  verifyApproval,
} from '@rtrentjones/greenlight-loop';
import type { GreenlightConfig } from '@rtrentjones/greenlight-shared';
import { UsageError, parseFlags } from '../args';
import { loadManifest, resolveEntry } from '../manifest';
import { releaseVerifySteps, releaseWorkflowYml } from '../release-workflows';

/**
 * Release authority (vision 18 §3): the owner approves ONE production operation by signing a git
 * tag, and every production job verifies that tag before it does anything else.
 *
 *   greenlight approve <name> --sha <sha> [--artifact <id>] [--policy-change] [--expires 24h]
 *       prepares the approval payload and prints the exact command for the OWNER to run on a
 *       machine that holds the signing key. It holds no key and signs nothing, so running it from
 *       an agent session is safe: the agent prepares the request, only the owner can complete it.
 *
 *   greenlight release verify <name> [--sha <sha>] [--artifact <id>] [--dry-run]
 *       the first step of a production job. Verifies an owner-signed approval for this tool at the
 *       checked-out commit, consumes its nonce, and exports GREENLIGHT_RELEASE_AUTHORIZED for the
 *       job's remaining steps.
 *
 *   greenlight release workflow <name>
 *       prints a complete tag-triggered production workflow for the tool.
 *
 *   greenlight release steps <name>
 *       prints the workflow steps that run the verification, to paste into a production job.
 *
 * Enforcement is opt-in per wrapper (`release: { approval: 'signed-tag' }` in the manifest), so an
 * existing consumer's deploys keep working until its owner has a signing key and a signer list in
 * place. Without the opt-in `release verify` says so and exits 0, and production operations are
 * not guarded.
 *
 * Exit codes: 0 authorized (or not enforced); 2 usage; 3 a prerequisite is missing (no signer
 * list, no token to record the nonce); 4 refused.
 */

export const approvalEnforced = (config: GreenlightConfig): boolean =>
  config.release?.approval === 'signed-tag';

function repoSlug(cwd: string, explicit?: string): string {
  const fromEnv = explicit ?? process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).stdout;
  const m = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(url ?? '');
  if (!m) throw new UsageError('cannot tell the repository: pass --repo <owner>/<name>');
  return m[1] as string;
}

function fullSha(cwd: string, rev: string): string {
  const r = spawnSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new UsageError(`"${rev}" is not a commit in this repository`);
  return r.stdout.trim();
}

function hours(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d+)h$/.exec(text);
  if (!m) throw new UsageError(`--expires takes hours, e.g. 24h (got "${text}")`);
  return Number(m[1]);
}

export async function approveCommand(args: string[]): Promise<number> {
  const a = parseFlags('approve', args, {
    value: ['--sha', '--artifact', '--expires', '--repo'],
    boolean: ['--policy-change', '--json'],
  });
  const name = a.positional[0];
  const rev = a.values['--sha'];
  if (!name || a.positional.length > 1 || !rev) {
    throw new UsageError(
      'usage: greenlight approve <name> --sha <sha> [--artifact <id>] [--policy-change] [--expires 24h] [--repo o/r] [--json]',
    );
  }
  const cwd = process.cwd();
  const { config } = await loadManifest(cwd);
  resolveEntry(config, name); // an unknown tool is refused here
  const sha = fullSha(cwd, rev);
  let prepared: ReturnType<typeof prepareApproval>;
  try {
    prepared = prepareApproval({
      tool: name,
      sha,
      repo: repoSlug(cwd, a.values['--repo']),
      artifact: a.values['--artifact'],
      policyChange: a.flags.has('--policy-change'),
      expiresInHours: hours(a.values['--expires']),
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { approval, tag } = prepared;
  const payload = JSON.stringify(approval);
  if (a.flags.has('--json')) {
    console.log(JSON.stringify({ tag, approval }, null, 2));
    return 0;
  }
  const file = `greenlight-approval-${approval.nonce}.json`;
  console.log(
    `Approval prepared for ${name} @ ${sha.slice(0, 12)} (not signed; this command holds no key).`,
  );
  console.log(
    `It authorizes one production release of exactly this commit until ${approval.expiresAt}.`,
  );
  if (!approvalEnforced(config)) {
    console.log(
      "Note: this wrapper's manifest does not set release.approval to 'signed-tag', so production jobs do not check approvals yet.",
    );
  }
  console.log('\nThe OWNER runs this on a machine that holds the signing key:\n');
  console.log(`  cat > ${file} <<'JSON'\n  ${payload}\n  JSON`);
  console.log(`  git -c gpg.format=ssh tag -s ${tag} ${sha} -F ${file}`);
  console.log(`  git push origin ${tag}`);
  console.log(`  rm ${file}`);
  return 0;
}

export async function releaseCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'steps') {
    const a = parseFlags('release steps', args.slice(1), { value: ['--artifact'] });
    const name = a.positional[0];
    if (!name || a.positional.length > 1) {
      throw new UsageError('usage: greenlight release steps <name> [--artifact <expression>]');
    }
    const { config } = await loadManifest(process.cwd());
    resolveEntry(config, name);
    console.log(
      '# The first steps of a production job, after checkout and install. The job also needs:\n#   permissions: { contents: read, deployments: write }',
    );
    console.log(releaseVerifySteps(name, a.values['--artifact']));
    return 0;
  }
  if (sub === 'workflow') {
    const a = parseFlags('release workflow', args.slice(1));
    const name = a.positional[0];
    if (!name || a.positional.length > 1) {
      throw new UsageError('usage: greenlight release workflow <name>');
    }
    const { config } = await loadManifest(process.cwd());
    const entry = resolveEntry(config, name);
    const envs =
      name === 'blog' ? ['beta', 'prod'] : (config.tools.find((t) => t.name === name)?.envs ?? []);
    // The workflow goes to stdout alone, so it can be redirected into .github/workflows/.
    console.error(`# save as .github/workflows/release-${name}.yml`);
    process.stdout.write(
      releaseWorkflowYml(name, { target: entry.target, beta: envs.includes('beta') }),
    );
    return 0;
  }
  if (sub !== 'verify') {
    throw new UsageError(
      'usage: greenlight release verify <name> [--sha <sha>] [--artifact <id>] [--repo o/r] [--dry-run] [--json]\n       greenlight release steps <name> [--artifact <expression>]\n       greenlight release workflow <name>',
    );
  }
  const a = parseFlags('release verify', args.slice(1), {
    value: ['--sha', '--artifact', '--repo'],
    boolean: ['--dry-run', '--json'],
  });
  const name = a.positional[0];
  if (!name || a.positional.length > 1) {
    throw new UsageError('usage: greenlight release verify <name> [--sha <sha>] [--artifact <id>]');
  }
  const cwd = process.cwd();
  const { config } = await loadManifest(cwd);
  resolveEntry(config, name);
  const json = a.flags.has('--json');
  if (!approvalEnforced(config)) {
    const msg =
      "release approval is not enforced: the manifest does not set release.approval to 'signed-tag'";
    console.log(json ? JSON.stringify({ enforced: false }) : `· ${msg}`);
    return 0;
  }
  const signers = process.env[RELEASE_SIGNERS_ENV] ?? '';
  if (!signers.trim()) {
    console.error(
      `✘ ${RELEASE_SIGNERS_ENV} is not set: it holds the owner's allowed-signers list, as an Actions secret`,
    );
    return 3;
  }
  const repo = repoSlug(cwd, a.values['--repo']);
  const dryRun = a.flags.has('--dry-run');
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!dryRun && !token) {
    console.error(
      '✘ no GITHUB_TOKEN: the consumed nonce is recorded as a deployment, so the job needs `deployments: write` (or pass --dry-run to check without consuming)',
    );
    return 3;
  }
  const sha = a.values['--sha'] ? fullSha(cwd, a.values['--sha']) : headSha(cwd);
  const result = await verifyApproval({
    repoDir: cwd,
    tool: name,
    sha,
    repo,
    artifact: a.values['--artifact'],
    allowedSigners: signers,
    nonces: token
      ? githubDeploymentNonces({ repo, token, apiUrl: process.env.GITHUB_API_URL })
      : memoryNonces(),
    dryRun,
  });
  if (!result.ok) {
    if (json) console.log(JSON.stringify({ enforced: true, ...result }));
    console.error(`✘ release not authorized: ${result.reason}`);
    for (const t of result.tags) console.error(`  ${t.tag}: ${t.problems.join('; ')}`);
    return 4;
  }
  if (!dryRun && process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${RELEASE_AUTHORIZED_ENV}=${result.authorized}\n`);
  }
  if (json) {
    console.log(
      JSON.stringify({
        enforced: true,
        ok: true,
        tag: result.tag,
        authorized: result.authorized,
        dryRun,
      }),
    );
  } else {
    console.log(
      `✔ ${dryRun ? 'would authorize' : 'authorized'} ${result.authorized} by ${result.tag}${dryRun ? ' (dry run: the nonce was not consumed)' : ''}`,
    );
    if (!dryRun && !process.env.GITHUB_ENV) {
      console.log(`  export ${RELEASE_AUTHORIZED_ENV}=${result.authorized}`);
    }
  }
  return 0;
}

/**
 * The guard `deploy` and `ship` call before a production operation (18 §3.1a). A no-op unless the
 * wrapper opted in. Defence in depth, not the boundary: it catches a production deploy wired into
 * a job that never verified an approval.
 */
export function guardProduction(config: GreenlightConfig, tool: string, cwd: string): void {
  if (!approvalEnforced(config)) return;
  assertReleaseAuthorized({ tool, sha: headSha(cwd) });
}
