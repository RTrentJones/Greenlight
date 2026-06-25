import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A greenlight Terraform module source pin, e.g.
//   git::https://github.com/RTrentJones/greenlight.git//infra/modules/neon?ref=v0.4.1
const REF_RE = /greenlight\.git\/\/infra\/modules\/[^?"]+\?ref=(v[0-9.]+)/g;

/** The installed `@rtrentjones/greenlight` version in a consumer wrapper — undefined in the framework
 * repo itself or before `pnpm install`. The lockstep anchor for `doctor` + `bump`. */
export function installedVersion(root: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, 'node_modules/@rtrentjones/greenlight/package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** The distinct greenlight module `?ref=` pins across `infra/*.tf` (empty when there's no infra). */
export function infraRefs(root: string): string[] {
  const refs = new Set<string>();
  try {
    for (const f of readdirSync(join(root, 'infra')).filter((f) => f.endsWith('.tf'))) {
      for (const m of readFileSync(join(root, 'infra', f), 'utf8').matchAll(REF_RE)) {
        if (m[1]) refs.add(m[1]);
      }
    }
  } catch {
    /* no infra dir */
  }
  return [...refs];
}

/** Rewrite every greenlight module `?ref=` in `infra/*.tf` to `target` (with or without a leading
 * `v`). Returns the filenames changed (empty = already aligned). Idempotent. */
export function rewriteInfraRefs(root: string, target: string): string[] {
  const want = target.startsWith('v') ? target : `v${target}`;
  const changed: string[] = [];
  let files: string[];
  try {
    files = readdirSync(join(root, 'infra')).filter((f) => f.endsWith('.tf'));
  } catch {
    return changed;
  }
  for (const f of files) {
    const p = join(root, 'infra', f);
    const body = readFileSync(p, 'utf8');
    const next = body.replace(
      /(greenlight\.git\/\/infra\/modules\/[^?"]+\?ref=)v[0-9.]+/g,
      `$1${want}`,
    );
    if (next !== body) {
      writeFileSync(p, next);
      changed.push(f);
    }
  }
  return changed;
}
