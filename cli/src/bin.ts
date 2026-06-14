#!/usr/bin/env tsx
import { configCommand } from './commands/config';
import { deployCommand } from './commands/deploy';
import { promoteCommand } from './commands/promote';
import { verifyCommand } from './commands/verify';

const HELP = `greenlight <command>

  config                       load & validate the manifest, then print it
  deploy <name> --env <env>    build + deploy an entry via its target adapter
  verify <name> --env <env>    run the verify harness against the deterministic URL
  promote <name> [--perform]   gated develop -> main fast-forward (--push to push)
  doctor                       validate the manifest (full checks arrive in Phase 6)
  help                         show this message

Real cloud deploys need the target's creds (e.g. CLOUDFLARE_API_TOKEN); they land
per-target in later phases (see greenlight-v1.md §16).`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'config':
    case 'doctor':
      return configCommand();
    case 'deploy':
      return deployCommand(args);
    case 'verify':
      return verifyCommand(args);
    case 'promote':
      return promoteCommand(args);
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
