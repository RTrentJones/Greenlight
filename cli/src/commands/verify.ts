import { type DeployEnv, type Lane, resolveUrl } from '@rtrentjones/greenlight-shared';
import { type VerifyReport, type VerifySpec, verify } from '@rtrentjones/greenlight-verify';
import { loadExternalVerifySpec, loadManifest, loadVerifySpec, resolveEntry } from '../manifest';

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
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function verifyCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error('usage: greenlight verify <name> [--env <beta|prod> | --url <url>]');
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

  // Prefer a per-tool verify spec; otherwise a lane default smoke spec. An external
  // (registry) tool's spec lives in the wrapper at verify/<name>.config.ts; a local
  // tool's at <dir>/verify.config.ts.
  const spec =
    (entry.external ? await loadExternalVerifySpec(name) : await loadVerifySpec(entry.dir)) ??
    defaultSpec(entry.lane);

  // Absorb the first-deploy TLS/DNS window: a remote env waits ~90s for the URL to
  // become reachable (retry on connection error only); --url (local) waits 0. `--wait <sec>` overrides.
  const waitFlag = flag(args, '--wait');
  const reachableTimeoutMs = (waitFlag !== undefined ? Number(waitFlag) : override ? 0 : 90) * 1000;
  if (reachableTimeoutMs > 0) {
    console.log(`waiting up to ${reachableTimeoutMs / 1000}s for ${url} to become reachable…`);
  }

  const report = await verify(url, spec, { reachableTimeoutMs });
  printReport(report);
  process.exit(report.pass ? 0 : 1);
}
