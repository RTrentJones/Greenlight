#!/usr/bin/env tsx
import { configCommand } from './commands/config';
import { promoteCommand } from './commands/promote';
import { verifyCommand } from './commands/verify';

const HELP = `greenlight <command>

  config                     load & validate the manifest, then print it
  verify <name> --env <env>  run the verify harness against the deterministic URL
  promote [name]             check promote eligibility (develop -> main fast-forward)
  doctor                     validate the manifest (full checks arrive in Phase 6)
  help                       show this message

Phase 1 ships the verify harness + the loop. Real deploys land per-target in
later phases (see greenlight-v1.md §16).`;

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
