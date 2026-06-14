import { relative } from 'node:path';
import { loadManifest } from '../manifest';

/** Load, validate, and print the manifest. (`doctor` aliases this until Phase 6.) */
export async function configCommand(): Promise<void> {
  const { path, config } = await loadManifest();
  console.log(`✔ Loaded & validated ${relative(process.cwd(), path)}\n`);
  console.log(JSON.stringify(config, null, 2));
}
