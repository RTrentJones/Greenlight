import { execFileSync } from 'node:child_process';

/** The environment of every host git call: no system or global config (no harness credential,
 * no helper), no terminal prompt. */
export function safeGitEnv(home?: string): Record<string, string> {
  const h = home ?? process.env.HOME;
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(h ? { HOME: h } : {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Options that keep a repository's own config from running anything on the host: no fsmonitor
 * hook, no hooks at all. */
export const SAFE_GIT_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
];

/** Host git on a harness-controlled repository (`safeGitEnv`, `SAFE_GIT_ARGS`); never in a
 * directory a candidate supplied. Ownership is not checked (`safe.directory=*`, on the command
 * line since no system or global config is read): every caller names the harness's own repo,
 * which in the outlet sandbox is owned by the host user, not uid 10000. */
export function safeGit(cwd: string, args: string[]): string {
  return execFileSync('git', [...SAFE_GIT_ARGS, '-c', 'safe.directory=*', ...args], {
    cwd,
    env: safeGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}
