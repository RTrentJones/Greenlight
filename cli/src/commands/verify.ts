import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type DeployEnv, type Lane, resolveUrl } from '@rtrentjones/greenlight-shared';
import {
  type VerifyReport,
  type VerifySpec,
  allPass,
  verifyAll,
} from '@rtrentjones/greenlight-verify';
import {
  loadExternalVerifySpec,
  loadManifest,
  loadVerifySpec,
  loadVerifySpecAt,
  resolveEntry,
} from '../manifest';

/** Default smoke spec by lane. Real per-tool specs come from a verify.config (Phase 9 adopt). */
export function defaultSpec(lane: Lane): VerifySpec {
  switch (lane) {
    case 'astro':
      // Generic web smoke. Content sites (blog) add rss/sitemap via a verify.config.ts.
      return { mode: 'api', checks: [{ path: '/', status: 200 }], noBrokenInternalLinks: true };
    case 'next':
      return { mode: 'api', checks: [{ path: '/', status: 200 }] };
    case 'mcp':
      return { mode: 'mcp', expectTools: [] };
  }
}

export function printReport(report: VerifyReport): void {
  console.log(`verify ${report.mode} ${report.url}\n`);
  for (const c of report.checks) {
    console.log(`  ${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${report.pass ? '✔ PASS' : '✘ FAIL'}`);
  // Telemetry-into-verify: surface the platform logs under a failed report so the agent/CI sees
  // the "why" right next to the red gate (no separate dashboard trip).
  if (!report.pass && report.logs) {
    console.log(`\n--- recent logs (${report.mode}) ---\n${report.logs}\n--- end logs ---`);
  }
}

const LOG_TAIL_LINES = 50;

/** Telemetry-into-verify: for every FAILED report whose spec set `logsOnFailure`, run that shell
 * command in the tool dir and attach the last ~50 lines to `report.logs`. Best-effort — a missing
 * CLI, a non-zero exit, or a timeout NEVER fails the verify (mirrors verifyTest's never-throw
 * contract); it only annotates. Reports are index-aligned with specs (verifyAll preserves order).
 *
 * The failed report's URL is exported as `GREENLIGHT_VERIFY_URL` so a command can probe the exact
 * deployment without the URL being hard-coded — e.g. `curl -i "$GREENLIGHT_VERIFY_URL"` or
 * `vercel logs "$GREENLIGHT_VERIFY_URL"`.
 *
 * Seam note: a future `adapter.logs(env, lines)` (typed on the Adapter contract, like `teardown`)
 * can be the fallback when a spec sets no `logsOnFailure`; for now the spec command is the source. */
export function attachFailureLogs(
  reports: VerifyReport[],
  specs: VerifySpec[],
  toolDir: string,
): void {
  reports.forEach((report, i) => {
    if (report.pass) return;
    const cmd = specs[i]?.logsOnFailure;
    if (!cmd) {
      report.logs = '(no logsOnFailure configured for this spec)';
      return;
    }
    try {
      const res = spawnSync(cmd, {
        shell: true,
        cwd: toolDir,
        timeout: 30_000,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        // Let the command target the exact failing URL without hard-coding it.
        env: { ...process.env, GREENLIGHT_VERIFY_URL: report.url },
      });
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trimEnd();
      const tail = out.split('\n').slice(-LOG_TAIL_LINES).join('\n');
      report.logs =
        tail || `(logsOnFailure produced no output${res.error ? `: ${res.error.message}` : ''})`;
    } catch (e) {
      report.logs = `(log fetch failed: ${e instanceof Error ? e.message : String(e)})`;
    }
  });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function verifyCommand(args: string[]): Promise<void> {
  // Manifest-free mode: `verify --url <url> --spec <path>` loads the spec directly and skips the
  // manifest entirely. This is how a tool's OWN CI verifies a deployment (e.g. a Vercel tool's
  // greenlight-verify.yml on deployment_status) without carrying the wrapper's greenlight.config.ts.
  const specPath = flag(args, '--spec');
  if (specPath) {
    const url = flag(args, '--url');
    if (!url) throw new Error('verify --spec needs --url <deployed-url>');
    const loaded = await loadVerifySpecAt(specPath);
    if (!loaded) throw new Error(`no verify spec at ${specPath}`);
    const specs = Array.isArray(loaded) ? loaded : [loaded];
    const waitMs = (flag(args, '--wait') !== undefined ? Number(flag(args, '--wait')) : 0) * 1000;
    const reports = await verifyAll(url, specs, {
      reachableTimeoutMs: waitMs,
      toolDir: process.cwd(),
    });
    attachFailureLogs(reports, specs, process.cwd());
    for (const report of reports) printReport(report);
    const pass = allPass(reports);
    if (reports.length > 1)
      console.log(`\n${pass ? '✔ ALL PASS' : '✘ FAIL'} (${reports.length} specs)`);
    process.exit(pass ? 0 : 1);
  }

  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: greenlight verify <name> [--env <beta|prod> | --url <url>] | verify --url <url> --spec <path>',
    );
  }

  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);

  // --url points at a local/preview server (skips manifest URL resolution).
  const override = flag(args, '--url');
  let url: string;
  if (override) {
    url = entry.lane === 'mcp' && !override.endsWith('/mcp') ? `${override}/mcp` : override;
  } else {
    const env = flag(args, '--env') as DeployEnv | undefined;
    if (env !== 'beta' && env !== 'prod') {
      throw new Error(
        'verify needs --env beta|prod (or --url <url>). preview URLs come from the adapter deploy.',
      );
    }
    url = resolveUrl({ domain: config.domain, name: entry.name, env, mcp: entry.lane === 'mcp' });
  }

  // Prefer a per-tool verify spec — which may be a single spec OR an array (combine modes,
  // e.g. [test, api, agent-web]); otherwise a lane default smoke spec. An external (registry)
  // tool's spec lives in the wrapper at verify/<name>.config.ts; a local tool's at <dir>/verify.config.ts.
  const loaded =
    (entry.external ? await loadExternalVerifySpec(name) : await loadVerifySpec(entry.dir)) ??
    defaultSpec(entry.lane);
  const specs = Array.isArray(loaded) ? loaded : [loaded];

  // Absorb the first-deploy TLS/DNS window: a remote env waits ~90s for the URL to
  // become reachable (retry on connection error only); --url (local) waits 0. `--wait <sec>` overrides.
  const waitFlag = flag(args, '--wait');
  const reachableTimeoutMs = (waitFlag !== undefined ? Number(waitFlag) : override ? 0 : 90) * 1000;
  if (reachableTimeoutMs > 0) {
    console.log(`waiting up to ${reachableTimeoutMs / 1000}s for ${url} to become reachable…`);
  }

  // `test` mode runs in the tool's dir; resolve it for the harness.
  const toolDir = resolve(process.cwd(), entry.dir ?? '.');
  const reports = await verifyAll(url, specs, { reachableTimeoutMs, toolDir });
  attachFailureLogs(reports, specs, toolDir);
  for (const report of reports) printReport(report);
  const pass = allPass(reports);
  if (reports.length > 1)
    console.log(`\n${pass ? '✔ ALL PASS' : '✘ FAIL'} (${reports.length} specs)`);
  process.exit(pass ? 0 : 1);
}
