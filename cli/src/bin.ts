#!/usr/bin/env node
import { addCommand } from './commands/add';
import { adoptCommand } from './commands/adopt';
import { agentCommand } from './commands/agent';
import { configCommand } from './commands/config';
import { deployCommand } from './commands/deploy';
import { doctorCommand } from './commands/doctor';
import { initCommand } from './commands/init';
import { migrationsCommand } from './commands/migrations';
import { previewCommand } from './commands/preview';
import { promoteCommand } from './commands/promote';
import { secretsCommand } from './commands/secrets';
import { statusCommand } from './commands/status';
import { verifyCommand } from './commands/verify';

const HELP = `greenlight <command>

  init --domain <d> [--cf-token ..] [--force]   scaffold manifest + secrets, push to GitHub Actions
  add <name> --lane <l> --target <t> [..]       scaffold a tool from a lane template + manifest entry
  config                                        load & validate the manifest, then print it
  deploy <name> --env <env>                     build + deploy an entry via its target adapter
  preview <name> [--port <n>]                   build + serve locally + verify (one command)
  verify <name> [--env <env> | --url <url>]     run the verify harness against the URL
  promote <name> [--perform] [--push]           gated develop -> main fast-forward
  status <name>                                 last ship/deploy/verify run for a tool (via gh)
  secrets gather <name> [--repo o/r] [--env e]  guided, link-first token prompts -> GitHub secrets (no disk/logs)
  secrets sync [--repo o/r] [--env <env>]       push .greenlight/secrets.env -> GitHub Actions secrets
  agent sync [<name>]                           write the loop kit (named → tool-aware, into its dir)
  adopt <name> --repo <path> --lane --target    onboard an existing tool repo as a thin consumer
  migrations scan [<dir>] [--strict]            dangerous-SQL gate for migrations (pre-apply)
  doctor [--live]                               consistency checks (--live: DNS + reachability probes)
  help                                          show this message

Real cloud deploys need the target's creds (e.g. CLOUDFLARE_API_TOKEN); see docs/archive/greenlight-v1.md §16.`;

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
    case 'preview':
      return previewCommand(args);
    case 'verify':
      return verifyCommand(args);
    case 'promote':
      return promoteCommand(args);
    case 'status':
      return statusCommand(args);
    case 'secrets':
      return secretsCommand(args);
    case 'agent':
      return agentCommand(args);
    case 'adopt':
      return adoptCommand(args);
    case 'migrations':
      return migrationsCommand(args);
    case 'doctor':
      return doctorCommand(args);
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
