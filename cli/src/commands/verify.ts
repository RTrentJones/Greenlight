import { type DeployEnv, type Lane, resolveUrl } from '@rtrentjones/greenlight-shared';
import { type VerifyReport, type VerifySpec, verify } from '@rtrentjones/greenlight-verify';
import { loadManifest, resolveEntry } from '../manifest';

/** Minimal default smoke spec by lane. Real specs come from a per-tool verify.config (Phase 9). */
function defaultSpec(lane: Lane): VerifySpec {
  if (lane === 'mcp') return { mode: 'mcp', expectTools: [] };
  return { mode: 'api', checks: [{ path: '/', status: 200 }] };
}

function printReport(report: VerifyReport): void {
  console.log(`verify ${report.mode} ${report.url}\n`);
  for (const c of report.checks) {
    console.log(`  ${c.pass ? '✔' : '✘'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${report.pass ? '✔ PASS' : '✘ FAIL'}`);
}

export async function verifyCommand(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new Error('usage: greenlight verify <name> --env <beta|prod>');
  }
  const envIdx = args.indexOf('--env');
  const env = (envIdx >= 0 ? args[envIdx + 1] : undefined) as DeployEnv | undefined;
  if (env !== 'beta' && env !== 'prod') {
    throw new Error(
      'verify needs --env beta|prod (preview URLs come from the adapter deploy, not resolvable standalone yet).',
    );
  }

  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  const url = resolveUrl({
    domain: config.domain,
    name: entry.name,
    env,
    mcp: entry.lane === 'mcp',
  });

  const report = await verify(url, defaultSpec(entry.lane));
  printReport(report);
  process.exit(report.pass ? 0 : 1);
}
