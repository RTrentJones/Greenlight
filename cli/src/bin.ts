#!/usr/bin/env node
import { addCommand } from './commands/add';
import { adoptCommand } from './commands/adopt';
import { agentCommand } from './commands/agent';
import { configCommand } from './commands/config';
import { deployCommand } from './commands/deploy';
import { doctorCommand } from './commands/doctor';
import { initCommand } from './commands/init';
import { promoteCommand } from './commands/promote';
import { secretsCommand } from './commands/secrets';
import { verifyCommand } from './commands/verify';

const HELP = `greenlight <command>

  init --domain <d> [--cf-token ..] [--force]   scaffold greenlight.config.ts + secrets
  add <name> --lane <l> --target <t> [..]       scaffold a tool from a lane template + manifest entry
  config                                        load & validate the manifest, then print it
  deploy <name> --env <env>                     build + deploy an entry via its target adapter
  verify <name> [--env <env> | --url <url>]     run the verify harness against the URL
  promote <name> [--perform] [--push]           gated develop -> main fast-forward
  secrets sync [--repo o/r] [--env <env>]       push .greenlight/secrets.env -> GitHub Actions secrets
  agent sync                                    write the loop skill + CLAUDE.md block into this repo
  adopt                                         (Phase 9) onboard an existing tool
  doctor                                        manifest + repo consistency checks
  help                                          show this message

Real cloud deploys need the target's creds (e.g. CLOUDFLARE_API_TOKEN); see greenlight-v1.md §16.`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'init':
      return initCommand(args);
    case 'add':
      return addCommand(args);
    case 'config':
      return configCommand();
    case 'deploy':
      return deployCommand(args);
    case 'verify':
      return verifyCommand(args);
    case 'promote':
      return promoteCommand(args);
    case 'secrets':
      return secretsCommand(args);
    case 'agent':
      return agentCommand(args);
    case 'adopt':
      return adoptCommand();
    case 'doctor':
      return doctorCommand();
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
