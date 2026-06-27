import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type GreenlightConfig, type ToolConfig, resolveUrl } from '@rtrentjones/greenlight-shared';
import { loadManifest } from '../manifest';
import { infraRefs, installedVersion } from '../refs';
import { resolveMigrationsDir } from './migrations';

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

  // The verify config's location is matrix-aware: oci external → wrapper `verify/<name>.config.ts`;
  // vercel external → the tool repo (`<dir>/verify/<name>.config.ts`, run by its own CI); local →
  // `<dir>/verify.config.ts`. Accept any that exists.
  const toolDir = t.dir ?? join('tools', t.name);
  const specCandidates = t.external
    ? [
        `verify/${t.name}.config.ts`,
        join(toolDir, `verify/${t.name}.config.ts`),
        join(toolDir, 'verify.config.ts'),
      ]
    : [join(toolDir, 'verify.config.ts')];
  const found = specCandidates.find((p) => existsSync(join(root, p)));
  out.push({
    name: `${t.name}: in the verify loop`,
    status: found ? 'ok' : 'warn',
    detail:
      found ??
      `no verify spec (looked: ${specCandidates.join(', ')}) — falls back to the lane default`,
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

  // Token scoping (docs/tokens-reference.md): every project-scoped secret a tool declares — its
  // `tokens` list + any `tokenOverrides` targets — must carry the tool name, else a second tool's
  // same-provider secret would collide on the shared wrapper. Pure name check; warn, don't fail.
  const declared = [...(t.tokens ?? []), ...Object.values(t.tokenOverrides ?? {})];
  if (declared.length) {
    const tag = t.name.toUpperCase().replace(/-/g, '_');
    const generic = declared.filter((s) => !s.toUpperCase().includes(tag));
    out.push({
      name: `${t.name}: token scoping`,
      status: generic.length ? 'warn' : 'ok',
      detail: generic.length
        ? `not tool-scoped (should contain ${tag}): ${generic.join(', ')}`
        : `${declared.length} scoped secret name(s)`,
    });
  }

  // A local next/vercel tool builds as a monorepo subdir on Vercel, which needs two things the
  // first such tool's bring-up exposed: (1) it must be a pnpm workspace member, or the root install
  // skips its deps (`Cannot find package 'pg'`); (2) a vercel.json framework preset, or Vercel
  // treats the Next output as a static site (`No Output Directory named "public"`).
  if (!t.external && t.lane === 'next' && t.target === 'vercel') {
    const wsPath = join(root, 'pnpm-workspace.yaml');
    const ws = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : '';
    const member = ws.includes(toolDir) || /^\s*-\s*["']?tools\/\*/m.test(ws);
    out.push({
      name: `${t.name}: pnpm workspace member`,
      status: member ? 'ok' : 'warn',
      detail: member
        ? undefined
        : `add "${toolDir}" to pnpm-workspace.yaml — else Vercel's root install skips its deps`,
    });
    const hasVercelJson = existsSync(join(root, toolDir, 'vercel.json'));
    out.push({
      name: `${t.name}: vercel.json framework`,
      status: hasVercelJson ? 'ok' : 'warn',
      detail: hasVercelJson
        ? undefined
        : `no ${join(toolDir, 'vercel.json')} (framework: "nextjs") — Vercel may treat the build as static`,
    });
  }

  // Dangerous-SQL gate conformance (docs/security.md): a data tool that owns migrations must run
  // `greenlight migrations scan` before the step that applies them, else a data-destroying migration
  // can ship ungated. The gate is "wired" if the scan runs either (a) in a workflow — the tool's own
  // or the wrapper's, where a workflow-deployed tool applies — OR (b) in the tool's package.json
  // build/migrate scripts, where a Vercel-git tool's migrate runs (its build IS the apply). Warn when
  // a migrations dir exists but neither references the scan. Skipped for tools without migrations.
  if (t.data === 'supabase' || t.data === 'neon') {
    const migBase = join(root, toolDir);
    const migDir = resolveMigrationsDir(undefined, migBase);
    if (existsSync(join(migBase, migDir))) {
      const inWorkflow = [join(migBase, '.github/workflows'), join(root, '.github/workflows')].some(
        (d) => {
          try {
            return readdirSync(d)
              .filter((f) => /\.ya?ml$/.test(f))
              .some((f) => readFileSync(join(d, f), 'utf8').includes('migrations scan'));
          } catch {
            return false;
          }
        },
      );
      const inScripts = (() => {
        try {
          const pkg = JSON.parse(readFileSync(join(migBase, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
          };
          return Object.values(pkg.scripts ?? {}).some((s) => s.includes('migrations scan'));
        } catch {
          return false;
        }
      })();
      const wired = inWorkflow || inScripts;
      out.push({
        name: `${t.name}: migrations gate`,
        status: wired ? 'ok' : 'warn',
        detail: wired
          ? `${migDir} scanned before apply (${inWorkflow ? 'CI workflow' : 'build script'})`
          : `${migDir} present but no workflow or build script runs \`greenlight migrations scan\` — wire the dangerous-SQL gate before the apply step`,
      });
    }
  }

  return out;
}

/** Lockstep drift: the consumer's infra `?ref=` pins should equal the installed
 * `@rtrentjones/greenlight` version (CLAUDE.md: "?ref lockstep with the npm dep"). Reads the
 * installed package version + every `?ref=` in `infra/*.tf`; warns on a mismatch (or non-uniform
 * pins when the installed version can't be read). No-ops in the framework repo itself (neither
 * present). This is the check that would have caught the scattered v0.2.3/v0.2.5/v0.2.19 pins. */
export function versionDriftCheck(root: string): DoctorCheck {
  const name = 'framework version drift';
  const installed = installedVersion(root);
  const refList = infraRefs(root);

  if (!installed && refList.length === 0) {
    return {
      name,
      status: 'skip',
      detail: 'no installed @rtrentjones/greenlight or infra pins here',
    };
  }
  if (installed) {
    const want = `v${installed}`;
    const bad = refList.filter((r) => r !== want);
    return bad.length === 0
      ? { name, status: 'ok', detail: `infra pins == installed ${want}` }
      : {
          name,
          status: 'warn',
          detail: `installed ${want}, but infra pins ${bad.join(', ')} — run \`greenlight bump\``,
        };
  }
  // No installed version to compare against — at least require the pins to be uniform.
  return refList.length <= 1
    ? { name, status: 'ok', detail: `infra pins uniform (${refList[0] ?? 'none'})` }
    : { name, status: 'warn', detail: `infra ?ref pins not uniform: ${refList.join(', ')}` };
}

/** Submodule drift: `git submodule status` prefixes a line with `+` (checked-out ≠ recorded),
 * `-` (uninitialized), or `U` (conflicts). Any of those means a `git status`-dirty pointer that
 * can pin an unexpected revision in a commit / CI checkout. Warn (don't fail) — a drifted submodule
 * is sometimes intentional WIP; the point is to make it visible. */
export function submoduleDriftCheck(root: string): DoctorCheck {
  const name = 'submodule drift';
  let out: string;
  try {
    // stderr ignored so a "not a git repository" never leaks to the doctor output.
    out = execFileSync('git', ['submodule', 'status'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return { name, status: 'skip', detail: 'no git / not a repo' };
  }
  if (!out) return { name, status: 'skip', detail: 'no submodules' };
  const dirty = out.split('\n').filter((l) => /^[+\-U]/.test(l));
  return dirty.length === 0
    ? { name, status: 'ok', detail: 'all submodules match their recorded commit' }
    : { name, status: 'warn', detail: dirty.map((l) => l.trim()).join('; ') };
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
      // If an external tool declares a local `dir` (e.g. a submodule), it should actually be there —
      // a missing dir means an uninitialized submodule, which breaks preview/verify run from here.
      if (t.dir) {
        checks.push(
          existsSync(join(root, t.dir))
            ? { name: `${t.name}: dir present`, status: 'ok', detail: t.dir }
            : {
                name: `${t.name}: dir present`,
                status: 'warn',
                detail: `declared dir "${t.dir}" missing — run \`git submodule update --init\``,
              },
        );
      }
    } else {
      checks.push(dirCheck(t.name, join(root, t.dir ?? join('tools', t.name))));
    }
    // Same conformance checks for EVERY tool — one model, enforced.
    checks.push(...conformanceChecks(t, root));
  }

  // Keepalive coverage (pure): which tools need a keepalive target — data:supabase (the
  // 7-day pause) or a container target (oci/docker: a health ping; oci also self-heals via
  // remediate). The wrapper wires these into the keepalive Worker's KEEPALIVE_TARGETS
  // (infra/modules/keepalive).
  const needsKeepalive = config.tools.filter(
    (t) => t.data === 'supabase' || t.target === 'oci' || t.target === 'docker',
  );
  checks.push({
    name: 'keepalive coverage',
    status: needsKeepalive.length > 0 ? 'ok' : 'skip',
    detail:
      needsKeepalive.length > 0
        ? needsKeepalive
            .map((t) => `${t.name} (${t.data === 'supabase' ? 'supabase' : t.target})`)
            .join(', ')
        : 'no data:supabase / target:oci|docker tools',
  });

  // Local consistency (no creds): lockstep + submodule drift.
  checks.push(versionDriftCheck(root));
  checks.push(submoduleDriftCheck(root));
  // Live operational health (DNS + reachability + the cred-bound checks) runs under `--live` —
  // see runDoctorLive. Kept out of the default so a transient outage never gates CI.
  return checks;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Does the prod URL respond? Any HTTP status < 500 = reachable (a 401 from an auth-gated MCP is
 * "up"); 5xx = degraded; a connection error / timeout = down. */
async function livenessCheck(name: string, url: string): Promise<DoctorCheck> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return res.status >= 500
      ? { name: `${name}: live`, status: 'warn', detail: `${url} → ${res.status} (degraded)` }
      : { name: `${name}: live`, status: 'ok', detail: `${url} → ${res.status}` };
  } catch (e) {
    return { name: `${name}: live`, status: 'fail', detail: `${url} unreachable: ${errMsg(e)}` };
  }
}

/** Does the tool's hostname resolve in DNS? */
async function dnsCheck(name: string, url: string): Promise<DoctorCheck> {
  const host = new URL(url).hostname;
  try {
    await lookup(host);
    return { name: `${name}: DNS`, status: 'ok', detail: host };
  } catch {
    return { name: `${name}: DNS`, status: 'fail', detail: `${host} does not resolve` };
  }
}

/** Live operational health (network) — behind `greenlight doctor --live` so a transient outage
 * never gates the pure CI-wired `doctor`. Probes each prod URL (DNS resolves? reachable?). The
 * cred-bound checks (terraform drift, Vercel free-tier cap, OCI PAYG status) stay honest skips
 * until each provider's API client is wired. */
export async function runDoctorLive(config: GreenlightConfig): Promise<DoctorCheck[]> {
  const targets: Array<{ name: string; url: string }> = [];
  if (config.blog) targets.push({ name: 'blog', url: `https://${config.domain}` });
  for (const t of config.tools) {
    if (!t.envs?.includes('prod')) continue;
    targets.push({
      name: t.name,
      url: resolveUrl({ domain: config.domain, name: t.name, env: 'prod', mcp: t.lane === 'mcp' }),
    });
  }
  const checks: DoctorCheck[] = [];
  for (const tg of targets) {
    checks.push(await dnsCheck(tg.name, tg.url));
    checks.push(await livenessCheck(tg.name, tg.url));
  }
  for (const name of ['terraform drift', 'Vercel cap headroom', 'OCI PAYG status']) {
    checks.push({
      name,
      status: 'skip',
      detail: 'not yet implemented — needs the provider API + creds',
    });
  }
  return checks;
}

const ICON = { ok: '✔', warn: '!', fail: '✘', skip: '·' } as const;

export async function doctorCommand(args: string[] = []): Promise<void> {
  let config: GreenlightConfig;
  try {
    ({ config } = await loadManifest());
    console.log('✔ manifest: loaded & valid\n');
  } catch (e) {
    console.error(`✘ manifest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const live = args.includes('--live');
  const strict = args.includes('--strict');
  const checks = runDoctor(config, process.cwd());
  if (live) {
    console.log('  (probing live prod URLs…)');
    checks.push(...(await runDoctorLive(config)));
  }
  for (const c of checks) {
    console.log(`  ${ICON[c.status]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log(
    `\n${failed === 0 ? '✔ no failures' : `✘ ${failed} failure(s)`}${warned ? ` · ${warned} warning(s)` : ''}`,
  );
  if (!live) console.log('· run `greenlight doctor --live` for DNS + reachability probes');
  if (!strict && warned) console.log('· run `greenlight doctor --strict` to fail on warnings (CI)');
  // Failures always gate; --strict makes warnings (drift) gate too — the CI-enforceable mode.
  process.exit(failed > 0 || (strict && warned > 0) ? 1 : 0);
}
