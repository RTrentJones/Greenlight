import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { infraRefs, installedVersion, rewriteInfraRefs } from '../refs';

/** `greenlight bump` — re-pin a consumer wrapper's infra `?ref=` (and the `package.json` dep range)
 * to the installed `@rtrentjones/greenlight` version, restoring lockstep in one command. Idempotent:
 * a no-op once aligned. The cure for the "framework version drift" doctor warning (which it then
 * clears). Run after `pnpm update @rtrentjones/greenlight`. */
export function bumpCommand(_args: string[]): void {
  const root = process.cwd();
  const version = installedVersion(root);
  if (!version) {
    throw new Error(
      'no installed @rtrentjones/greenlight here — run from a consumer wrapper after `pnpm install`',
    );
  }
  const want = `v${version}`;

  const before = infraRefs(root);
  const changed = rewriteInfraRefs(root, version);
  if (changed.length) {
    console.log(`✔ re-pinned ${changed.length} infra file(s) → ${want}: ${changed.join(', ')}`);
  } else {
    console.log(`· infra ?ref already ${want}${before.length ? '' : ' (no infra pins)'}`);
  }

  // Align the npm side of lockstep too — the dep range to ^<version>.
  const pkgPath = resolve(root, 'package.json');
  if (existsSync(pkgPath)) {
    const raw = readFileSync(pkgPath, 'utf8');
    const next = raw.replace(/("@rtrentjones\/greenlight":\s*")[^"]+(")/, `$1^${version}$2`);
    if (next !== raw) {
      writeFileSync(pkgPath, next);
      console.log(`✔ package.json dep → ^${version}`);
    }
  }
  console.log('\nNext: pnpm install && pnpm greenlight doctor --strict, then commit + push.');
}
