import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { type DeployEnv, type Lane, resolveUrl } from '@rtrentjones/greenlight-shared';
import {
  type ExportContext,
  type VerifyReport,
  type VerifySpec,
  allPass,
  toExportResult,
  verifyAll,
} from '@rtrentjones/greenlight-verify';
import { parseFlags } from '../args';
import {
  loadExternalVerifySpec,
  loadManifest,
  loadVerifySpec,
  loadVerifySpecAt,
  resolveEntry,
} from '../manifest';
import { REMOTE_REACHABLE_MS, readyTimeout } from '../timeouts';

/** Default smoke spec by lane. Real per-tool specs come from a verify.config (Phase 9 adopt). */
export function defaultSpec(lane: Lane): VerifySpec {
  switch (lane) {
    case 'astro':
      // Generic web smoke. Content sites (blog) add rss/sitemap via a verify.config.ts. The settle
      // retries absorb Cloudflare Workers Static Assets propagation lag right after a deploy.
      return {
        mode: 'api',
        checks: [{ path: '/', status: 200 }],
        noBrokenInternalLinks: true,
        settleRetries: 8,
        settleMs: 5000,
      };
    case 'next':
      return { mode: 'api', checks: [{ path: '/', status: 200 }] };
    case 'mcp':
      return { mode: 'mcp', expectTools: [] };
    case 'agent':
      // An agent exposes GET /status (last-run metadata). The default just smoke-checks it's up;
      // the tool's verify.config.ts asserts ok:true + a recent run. settle absorbs deploy lag.
      return {
        mode: 'api',
        checks: [{ path: '/status', status: 200 }],
        settleRetries: 6,
        settleMs: 5000,
      };
  }
}

export function printReport(report: VerifyReport, log: (s: string) => void = console.log): void {
  log(`verify ${report.mode} ${report.url}\n`);
  for (const c of report.checks) {
    log(`  ${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  log(`\n${report.pass ? '✔ PASS' : '✘ FAIL'}`);
  // Telemetry-into-verify: surface the platform logs under a failed report so the agent/CI sees
  // the "why" right next to the red gate (no separate dashboard trip).
  if (!report.pass && report.logs) {
    log(`\n--- recent logs (${report.mode}) ---\n${report.logs}\n--- end logs ---`);
  }
}

/** Emit the reports + return the gate decision as an exit code. `--json` (or
 * GREENLIGHT_VERIFY_JSON=1) prints the standards-shaped export to STDOUT and routes the human
 * report to STDERR, so `verify … --json | jq` is clean; otherwise the human report goes to
 * stdout as before. */
function emitReports(reports: VerifyReport[], json: boolean, ctx: ExportContext): number {
  const log = json ? console.error : console.log;
  for (const report of reports) printReport(report, log);
  const pass = allPass(reports);
  if (reports.length > 1) log(`\n${pass ? '✔ ALL PASS' : '✘ FAIL'} (${reports.length} specs)`);
  if (json) process.stdout.write(`${JSON.stringify(toExportResult(reports, ctx))}\n`);
  return pass ? 0 : 1;
}

/** The deploy's commit, for the export's `git_sha` (CI provides one; null locally). */
function gitSha(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null;
}

const LOG_TAIL_LINES = 50;

/** Defense-in-depth: a `logsOnFailure` command runs with the full process env (it may legitimately
 * need a token — e.g. `vercel logs --token "$VERCEL_API_TOKEN"`), and its captured output is printed
 * to CI. Scrub any secret-looking env VALUE out of the text before it can leak into a log. Keys
 * matching TOKEN/KEY/SECRET/PASSWORD with a non-trivial value are replaced wherever they appear. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 6) continue; // skip empty / trivial values to avoid over-redaction
    if (!/TOKEN|KEY|SECRET|PASSWORD|PWD/i.test(k)) continue;
    out = out.split(v).join('***'); // literal replace-all (no regex escaping needed)
  }
  return out;
}

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
      const out = redactSecrets(`${res.stdout ?? ''}${res.stderr ?? ''}`.trimEnd());
      const tail = out.split('\n').slice(-LOG_TAIL_LINES).join('\n');
      report.logs =
        tail || `(logsOnFailure produced no output${res.error ? `: ${res.error.message}` : ''})`;
    } catch (e) {
      report.logs = `(log fetch failed: ${e instanceof Error ? e.message : String(e)})`;
    }
  });
}

const VERIFY_FLAGS = {
  value: ['--spec', '--url', '--wait', '--tool', '--env', '--expect-sha'],
  boolean: ['--json'],
};

/** The one verify tail both command paths (and `preview`) share: run the harness, then attach
 * failure logs. Printing/exit stay with the callers. `expectedSha` is deliberately explicit
 * (--expect-sha, or ship's default) — NOT inferred from GITHUB_SHA here, because standalone
 * verify often gates a DIFFERENT commit than the workflow's (promote verifies beta=develop
 * while dispatched from main). */
export async function runVerify(
  specs: VerifySpec[],
  url: string,
  opts: { toolDir: string; reachableTimeoutMs: number; expectedSha?: string },
): Promise<VerifyReport[]> {
  const reports = await verifyAll(url, specs, {
    reachableTimeoutMs: opts.reachableTimeoutMs,
    toolDir: opts.toolDir,
    expectedSha: opts.expectedSha,
  });
  attachFailureLogs(reports, specs, opts.toolDir);
  return reports;
}

/** E5: a missing verify config silently weakening the gate to a smoke spec was the finding —
 * fall back loudly so "verify passed" can't quietly mean "the default smoke test passed". */
export function warnDefaultSpec(name: string, lane: Lane): void {
  console.warn(
    `⚠ ${name}: no verify config found — using the ${lane} lane default smoke spec. Add a verify.config.ts so the gate asserts this tool's real contract.`,
  );
}

export async function verifyCommand(args: string[]): Promise<number> {
  const parsed = parseFlags('verify', args, VERIFY_FLAGS);
  const json = parsed.flags.has('--json') || process.env.GREENLIGHT_VERIFY_JSON === '1';

  // Manifest-free mode: `verify --url <url> --spec <path>` loads the spec directly and skips the
  // manifest entirely. This is how a tool's OWN CI verifies a deployment (e.g. a Vercel tool's
  // greenlight-verify.yml on deployment_status) without carrying the wrapper's greenlight.config.ts.
  const specPath = parsed.values['--spec'];
  if (specPath) {
    const url = parsed.values['--url'];
    if (!url) throw new Error('verify --spec needs --url <deployed-url>');
    const loaded = await loadVerifySpecAt(specPath);
    if (!loaded) throw new Error(`no verify spec at ${specPath}`);
    const specs = Array.isArray(loaded) ? loaded : [loaded];
    const waitFlag = parsed.values['--wait'];
    const waitMs = (waitFlag !== undefined ? Number(waitFlag) : 0) * 1000;
    const reports = await runVerify(specs, url, {
      reachableTimeoutMs: waitMs,
      toolDir: process.cwd(),
      expectedSha: parsed.values['--expect-sha'],
    });
    // Manifest-free: tool name from --tool, else the spec basename (`<name>.config.ts` → `<name>`).
    const tool = parsed.values['--tool'] ?? basename(specPath).replace(/\.config\.[tj]s$/, '');
    return emitReports(reports, json, {
      tool,
      env: parsed.values['--env'] ?? 'preview',
      gitSha: gitSha(),
    });
  }

  const name = parsed.positional[0];
  if (!name) {
    throw new Error(
      'usage: greenlight verify <name> [--env <beta|prod> | --url <url>] | verify --url <url> --spec <path>',
    );
  }

  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);

  // --url points at a local/preview server (skips manifest URL resolution).
  const override = parsed.values['--url'];
  let url: string;
  if (override) {
    url = entry.lane === 'mcp' && !override.endsWith('/mcp') ? `${override}/mcp` : override;
  } else {
    const env = parsed.values['--env'] as DeployEnv | undefined;
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
  const loaded = entry.external
    ? await loadExternalVerifySpec(name)
    : await loadVerifySpec(entry.dir);
  if (!loaded) warnDefaultSpec(name, entry.lane);
  const resolved = loaded ?? defaultSpec(entry.lane);
  const specs = Array.isArray(resolved) ? resolved : [resolved];

  // Absorb the first-deploy TLS/DNS window: a remote env waits for the URL to become reachable
  // (retry on connection error only); --url (local) waits 0. `--wait <sec>` overrides; the tool's
  // manifest `readyTimeoutMs` overrides the built-in default.
  const waitFlag = parsed.values['--wait'];
  const reachableTimeoutMs =
    waitFlag !== undefined
      ? Number(waitFlag) * 1000
      : override
        ? 0
        : readyTimeout(entry.readyTimeoutMs, REMOTE_REACHABLE_MS);
  if (reachableTimeoutMs > 0) {
    console.log(`waiting up to ${reachableTimeoutMs / 1000}s for ${url} to become reachable…`);
  }

  // `test` mode runs in the tool's dir; resolve it for the harness.
  const toolDir = resolve(process.cwd(), entry.dir ?? '.');
  const reports = await runVerify(specs, url, {
    reachableTimeoutMs,
    toolDir,
    expectedSha: parsed.values['--expect-sha'],
  });
  return emitReports(reports, json, {
    tool: entry.name ?? name,
    env: override ? 'preview' : (parsed.values['--env'] ?? 'preview'),
    gitSha: gitSha(),
  });
}
