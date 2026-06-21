import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type GreenlightConfig, type ToolConfig, resolveUrl } from '@rtrentjones/greenlight-shared';
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

/** Conformance to the uniform tool model: every tool must be (a) in the verify loop — a verify spec
 * exists (external → the wrapper's `verify/<name>.config.ts`; local → `<dir>/verify.config.ts`) —
 * and (b) locally gateable — `greenlight preview <name>` can run it (a built-in node serve for a
 * local workers tool, else a `preview` descriptor). Warnings, not failures: they flag a consumer
 * drifting from the shape without breaking the run. */
function conformanceChecks(t: ToolConfig, root: string): DoctorCheck[] {
  const out: DoctorCheck[] = [];

  const specRel = t.external
    ? `verify/${t.name}.config.ts`
    : join(t.dir ?? join('tools', t.name), 'verify.config.ts');
  const hasSpec = existsSync(join(root, specRel));
  out.push({
    name: `${t.name}: in the verify loop`,
    status: hasSpec ? 'ok' : 'warn',
    detail: hasSpec ? specRel : `no ${specRel} — verify falls back to the lane default`,
  });

  // A pre-prod gate exists if: a `preview` descriptor (any target), a built-in local serve (a local
  // node/workers tool), OR the platform supplies per-PR previews (vercel → the deployment_status
  // verify is the gate). Only oci/other tools with no descriptor lack one.
  const builtIn = !t.external && t.target === 'workers';
  const platformPreview = t.target === 'vercel';
  const gateable = Boolean(t.preview) || builtIn || platformPreview;
  out.push({
    name: `${t.name}: local preview gate`,
    status: gateable ? 'ok' : 'warn',
    detail: platformPreview
      ? 'vercel per-PR preview + deployment_status verify'
      : gateable
        ? undefined
        : `no built-in serve for ${t.external ? 'an external ' : ''}${t.target} tool — add preview:{ command, … } so \`greenlight preview ${t.name}\` works`,
  });

  return out;
}

/** Pure consistency checks (no network). Cred-dependent checks are reported as skipped. */
export function runDoctor(config: GreenlightConfig, root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (config.blog) checks.push(dirCheck('blog', join(root, 'apps/blog')));

  for (const t of config.tools) {
    // External tools live in another repo — this manifest is a registry pointer. We can't check the
    // app dir locally; report the subdomain `verify` should target. Local tools get a dir check.
    if (t.external) {
      const url = resolveUrl({
        domain: config.domain,
        name: t.name,
        env: 'prod',
        mcp: t.lane === 'mcp',
      });
      checks.push({ name: `${t.name}: external (registry)`, status: 'ok', detail: url });
    } else {
      checks.push(dirCheck(t.name, join(root, t.dir ?? join('tools', t.name))));
    }
    // Same conformance checks for EVERY tool — one model, enforced.
    checks.push(...conformanceChecks(t, root));
  }

  // Keepalive coverage (pure): which tools need a keepalive target — data:supabase (the
  // 7-day pause) or target:oci (health ping). The wrapper wires these into the keepalive
  // Worker's KEEPALIVE_TARGETS (infra/modules/keepalive).
  const needsKeepalive = config.tools.filter((t) => t.data === 'supabase' || t.target === 'oci');
  checks.push({
    name: 'keepalive coverage',
    status: needsKeepalive.length > 0 ? 'ok' : 'skip',
    detail:
      needsKeepalive.length > 0
        ? needsKeepalive
            .map((t) => `${t.name} (${t.data === 'supabase' ? 'supabase' : 'oci'})`)
            .join(', ')
        : 'no data:supabase / target:oci tools',
  });

  // Cred / infra-dependent — wired in later phases.
  for (const name of [
    'DNS propagation',
    'terraform drift',
    'Vercel cap headroom',
    'keepalive health (live)',
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
