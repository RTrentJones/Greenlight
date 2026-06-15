import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `greenlight secrets sync` — push the local `.greenlight/secrets.env` to the repo's
 * GitHub Actions secrets via `gh` (encrypted client-side; values never echoed). This
 * is the "init writes to provider stores" piece (greenlight-v1.md §8/§14). Prefer
 * GitHub OIDC → cloud over long-lived tokens where the target supports it.
 */

export interface SecretEntry {
  key: string;
  value: string;
}

/** Parse KEY=VALUE lines; skip blanks + `#` comments; split on the first `=`. */
export function parseSecretsEnv(text: string): SecretEntry[] {
  const out: SecretEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return out;
}

/** owner/repo from a GitHub remote URL (https, https.git, scp-style, ssh://). */
export function parseRepo(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function detectRepo(cwd: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // don't leak git's stderr
    });
    return parseRepo(url);
  } catch {
    return null;
  }
}

export interface SyncOptions {
  cwd: string;
  repo?: string;
  env?: string;
}

/**
 * Push `.greenlight/secrets.env` to the repo's GitHub Actions secrets. Returns the
 * resolved repo + count. Throws on hard errors (no repo, no secrets file, gh missing/
 * unauthenticated). Reused by the standalone command and by `greenlight init`.
 */
export function syncSecrets(opts: SyncOptions): { repo: string; count: number } {
  const repo = opts.repo ?? detectRepo(opts.cwd);
  if (!repo) {
    throw new Error(
      'could not determine the repo — pass --repo owner/repo (no github.com origin remote)',
    );
  }
  const path = resolve(opts.cwd, '.greenlight/secrets.env');
  if (!existsSync(path)) {
    throw new Error('no .greenlight/secrets.env — run `greenlight init` with tokens first');
  }
  const entries = parseSecretsEnv(readFileSync(path, 'utf8'));
  const target = opts.env ? `env "${opts.env}"` : 'repo';
  for (const { key, value } of entries) {
    // No --body: gh reads the value from stdin (portable across gh versions), so it
    // never appears in argv / the process list.
    const ghArgs = ['secret', 'set', key, '--repo', repo];
    if (opts.env) ghArgs.push('--env', opts.env);
    try {
      execFileSync('gh', ghArgs, { input: value });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
      if (err.code === 'ENOENT') {
        throw new Error('the GitHub CLI `gh` is required — install it and run `gh auth login`');
      }
      const detail = err.stderr?.toString().trim();
      throw new Error(
        `failed to set ${key}${detail ? `: ${detail}` : ' (check `gh auth status`)'}`,
      );
    }
    console.log(`✔ set ${key} → ${repo} ${target}`); // value intentionally not printed
  }
  return { repo, count: entries.length };
}

export async function secretsCommand(args: string[]): Promise<void> {
  if (args[0] !== 'sync') {
    console.log(
      'usage: greenlight secrets sync [--repo owner/repo] [--env <env>]   # push .greenlight/secrets.env to GitHub Actions secrets',
    );
    process.exit(args[0] ? 1 : 0);
  }

  const { count } = syncSecrets({
    cwd: process.cwd(),
    repo: flag(args, '--repo'),
    env: flag(args, '--env'),
  });
  if (count === 0) {
    console.log('no secrets to sync');
    return;
  }
  console.log(
    `\n${count} secret(s) synced. (Prefer GitHub OIDC over long-lived tokens where supported.)`,
  );
}
