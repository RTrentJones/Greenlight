import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type GreenlightConfig, resolveUrl } from '@rtrentjones/greenlight-shared';
import { loadManifest } from '../manifest';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail?: string;
}

function dirCheck(label: string, dir: string): DoctorCheck {
  return existsSync(dir)
    ? { name: `${label}: directory`, status: 'ok' }
    : { name: `${label}: directory`, status: 'fail', detail: `missing ${dir}` };
}

/** Pure consistency checks (no network). Cred-dependent checks are reported as skipped. */
export function runDoctor(config: GreenlightConfig, root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (config.blog) checks.push(dirCheck('blog', join(root, 'apps/blog')));

  for (const t of config.tools) {
    // External tools live in another repo — this manifest is a registry pointer.
    // We can't check files locally; report the subdomain `verify` should target.
    if (t.external) {
      const url = resolveUrl({
        domain: config.domain,
        name: t.name,
        env: 'prod',
        mcp: t.lane === 'mcp',
      });
      checks.push({ name: `${t.name}: external (registry)`, status: 'ok', detail: url });
      continue;
    }
    const dir = join(root, t.dir ?? join('tools', t.name));
    checks.push(dirCheck(t.name, dir));
    if (t.lane === 'mcp') {
      const vc = join(dir, 'verify.config.ts');
      checks.push({
        name: `${t.name}: verify.config.ts`,
        status: existsSync(vc) ? 'ok' : 'warn',
        detail: existsSync(vc) ? undefined : 'missing — verify will use the lane default',
      });
    }
  }

  // Cred / infra-dependent — wired in later phases.
  for (const name of [
    'DNS propagation',
    'terraform drift',
    'Vercel cap headroom',
    'keepalive health',
    'OCI PAYG status',
    'framework version drift',
  ]) {
    checks.push({ name, status: 'skip', detail: 'needs provider creds / packages (Phase 5/7/8)' });
  }
  return checks;
}

const ICON = { ok: '✔', warn: '!', fail: '✘', skip: '·' } as const;

export async function doctorCommand(): Promise<void> {
  let config: GreenlightConfig;
  try {
    ({ config } = await loadManifest());
    console.log('✔ manifest: loaded & valid\n');
  } catch (e) {
    console.error(`✘ manifest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const checks = runDoctor(config, process.cwd());
  for (const c of checks) {
    console.log(`  ${ICON[c.status]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  console.log(`\n${failed === 0 ? '✔ no failures' : `✘ ${failed} failure(s)`}`);
  process.exit(failed === 0 ? 0 : 1);
}
