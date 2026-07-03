#!/usr/bin/env node
import { describeMatrix } from '@rtrentjones/greenlight-shared';
import { addCommand } from './commands/add';
import { adoptCommand } from './commands/adopt';
import { agentCommand } from './commands/agent';
import { bumpCommand } from './commands/bump';
import { configCommand } from './commands/config';
import { deployCommand } from './commands/deploy';
import { doctorCommand } from './commands/doctor';
import { initCommand } from './commands/init';
import { migrationsCommand } from './commands/migrations';
import { previewCommand } from './commands/preview';
import { promoteCommand } from './commands/promote';
import { secretsCommand } from './commands/secrets';
import { shipCommand } from './commands/ship';
import { statusCommand } from './commands/status';
import { verifyCommand } from './commands/verify';

const HELP = `greenlight <command>

  init --domain <d> [--cf-token ..] [--force]   scaffold manifest + secrets, push to GitHub Actions
  add <name> --lane <l> --target <t> [..]       scaffold a tool from a lane template + manifest entry
  lanes                                         list the valid lane × target × data combinations
  config                                        load & validate the manifest, then print it
  deploy <name> --env <env>                     build + deploy an entry via its target adapter
  ship <name> --env <beta|prod> [--expect-sha <sha>] [--events <f>] [--no-rollback]
                                                one loop turn: build -> deploy -> SHA-gated verify
                                                -> rollback on failure (+ stage events)
  preview <name> [--port <n>]                   build + serve locally + verify (one command)
  verify <name> [--env <env> | --url <url>] [--json] [--expect-sha <sha>]  run the verify harness
  promote <name> [--perform] [--push] [--commit <sha>]  gated develop -> main fast-forward
                                                (--commit pins to the verified sha)
  status <name>                                 last ship/deploy/verify run for a tool (via gh)
  secrets gather <name> [--repo o/r] [--env e]  guided, link-first token prompts -> GitHub secrets (no disk/logs)
  secrets check [<name>] [--repo o/r]           list the GitHub secrets a tool's deploy needs + flag missing
  agent sync [<name>]                           write the loop kit (named → tool-aware, into its dir)
  adopt <name> --repo <path> --lane --target    onboard an existing tool repo as a thin consumer
  migrations scan [<dir>] [--strict]            dangerous-SQL gate for migrations (pre-apply)
  bump                                          re-pin a consumer's infra ?ref + dep to the installed version
  doctor [--live] [--strict]                    consistency checks (--live: probes; --strict: fail on warnings)
  help                                          show this message

Real cloud deploys need the target's creds (e.g. CLOUDFLARE_API_TOKEN); see docs/archive/greenlight-v1.md §16.`;

/** Every command returns its exit code; this switch just routes. The ONLY process.exit lives
 * below — commands stay composable in-process (ship runs deploy→verify→rollback as one flow). */
async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case 'init':
      return initCommand(args);
    case 'add':
      return addCommand(args);
    case 'lanes':
      console.log(`Valid lane × target × data combinations:\n${describeMatrix()}`);
      return 0;
    case 'config':
      return configCommand();
    case 'deploy':
      return deployCommand(args);
    case 'ship':
      return shipCommand(args);
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
    case 'bump':
      return bumpCommand(args);
    case 'doctor':
      return doctorCommand(args);
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

// process.exit (not just exitCode) — preview leaves detached child handles that would
// otherwise keep the event loop alive after the command has decided its outcome.
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
