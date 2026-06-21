import { execFileSync } from 'node:child_process';
import { loadManifest, resolveEntry } from '../manifest';

/**
 * `greenlight status <name>` — in-session visibility into a tool's ship → deploy → verify chain
 * across repos. Reads the manifest, resolves the relevant GitHub Actions workflows by target, and
 * prints each one's last run via `gh`. Degrades to a hint if `gh` is unauthed/absent (read-only).
 */

/** owner/repo from a dir's `origin` remote (the wrapper = cwd; an external tool = its submodule). */
export function repoSlug(dir: string): string | null {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim();
    const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

interface WorkflowRef {
  repo: string;
  workflow: string;
  label: string;
}

/** The ship/deploy/verify workflows for a tool, by target — the model's run chain. */
export function workflowsFor(
  entry: ReturnType<typeof resolveEntry>,
  name: string,
  wrapper: string,
  toolRepo: string,
): WorkflowRef[] {
  if (!entry.external) {
    return [{ repo: wrapper, workflow: 'deploy.yml', label: 'deploy + verify' }];
  }
  if (entry.target === 'oci') {
    return [
      {
        repo: toolRepo,
        workflow: 'greenlight-build.yml',
        label: 'build (test → image → dispatch)',
      },
      { repo: wrapper, workflow: `greenlight-deploy-${name}.yml`, label: 'deploy + verify (prod)' },
      { repo: wrapper, workflow: `greenlight-remediate-${name}.yml`, label: 'self-heal' },
    ];
  }
  if (entry.target === 'vercel') {
    return [
      { repo: toolRepo, workflow: 'greenlight-verify.yml', label: 'verify (deployment_status)' },
    ];
  }
  return [{ repo: toolRepo, workflow: 'deploy.yml', label: 'deploy + verify' }];
}

function lastRun(repo: string, workflow: string): string {
  try {
    const out = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--repo',
        repo,
        '--workflow',
        workflow,
        '--limit',
        '1',
        '--json',
        'status,conclusion,displayTitle,url',
      ],
      { encoding: 'utf8' },
    );
    const runs = JSON.parse(out) as Array<{
      status: string;
      conclusion: string;
      displayTitle: string;
      url: string;
    }>;
    const r = runs[0];
    if (!r) return 'no runs';
    const state = r.status === 'completed' ? r.conclusion : r.status;
    const icon = state === 'success' ? '✔' : state === 'failure' ? '✘' : '·';
    return `${icon} ${state}  ${r.displayTitle}\n    ${r.url}`;
  } catch (e) {
    return `(gh unavailable — ${e instanceof Error ? e.message.split('\n')[0] : 'error'})`;
  }
}

export async function statusCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) throw new Error('usage: greenlight status <name>');
  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  const wrapper = repoSlug(process.cwd()) ?? '(this repo)';
  const toolRepo = entry.external ? (repoSlug(entry.dir) ?? '(tool repo)') : wrapper;

  console.log(`status: ${name} (${entry.lane}/${entry.target})\n`);
  for (const w of workflowsFor(entry, name, wrapper, toolRepo)) {
    console.log(`  ${w.label}  [${w.repo} · ${w.workflow}]`);
    console.log(`    ${lastRun(w.repo, w.workflow)}\n`);
  }
}
