#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadConfig } from '@rtrentjones/greenlight-shared';

const HELP = `greenlight <command>

  config    load & validate the manifest, then print it
  doctor    validate the manifest (full checks arrive in Phase 6)
  help      show this message

Phase 0 ships manifest loading + validation only. Deploy / verify / promote
land in later phases (see greenlight-v1.md §16).`;

function findManifest(): string | null {
  for (const name of ['greenlight.config.ts', 'greenlight.config.example.ts']) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  return null;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  if (cmd === 'config' || cmd === 'doctor') {
    const manifest = findManifest();
    if (!manifest) {
      throw new Error(
        'No greenlight.config.ts (or greenlight.config.example.ts) found in this directory.',
      );
    }
    const config = await loadConfig(manifest);
    console.log(`✔ Loaded & validated ${relative(process.cwd(), manifest)}\n`);
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
