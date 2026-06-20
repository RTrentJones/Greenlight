import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { loadManifest, resolveEntry } from '../manifest';
import { packsForTool } from '../providers';

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

/** A hidden-input prompter over ONE readline interface (creating one per prompt loses piped
 * input between prompts). On a real TTY, readline's echo is suppressed so pasted values never
 * show; piped input (tests/CI) reads lines without echoing anyway. Close it when done. */
function hiddenPrompter(): { ask: (query: string) => Promise<string>; close: () => void } {
  const tty = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  if (tty) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return {
    ask: (query) =>
      new Promise((resolve) => {
        process.stdout.write(query);
        rl.question('', (val) => {
          process.stdout.write('\n');
          resolve(val.trim());
        });
      }),
    close: () => rl.close(),
  };
}

/** Push one secret straight to GitHub Actions via `gh` — value on STDIN, never argv/file/log. */
export function setGitHubSecret(
  repo: string,
  env: string | undefined,
  key: string,
  value: string,
): void {
  const ghArgs = ['secret', 'set', key, '--repo', repo];
  if (env) ghArgs.push('--env', env);
  try {
    execFileSync('gh', ghArgs, { input: value });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
    if (err.code === 'ENOENT') {
      throw new Error('the GitHub CLI `gh` is required — install it and run `gh auth login`');
    }
    const detail = err.stderr?.toString().trim();
    throw new Error(`failed to set ${key}${detail ? `: ${detail}` : ' (check `gh auth status`)'}`);
  }
}

/**
 * `greenlight secrets gather <name>` — guided, link-first secret onboarding straight to a repo's
 * GitHub Actions secrets. For each provider pack the tool uses: print where to create the token +
 * its scopes, hidden-prompt for the value (no echo), fail-fast `verify()`, then push via `gh`
 * (stdin). Nothing touches disk; no value is echoed or logged. Blank input skips a token.
 */
async function gatherSecrets(name: string, repo: string, env: string | undefined): Promise<void> {
  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  const packs = packsForTool({ target: entry.target, data: entry.data });
  const dest = env ? `env "${env}" of ${repo}` : repo;
  console.log(`Gathering secrets for "${name}" → GitHub ${dest}`);
  console.log(
    'Paste each value (hidden); Enter to skip. Values go straight to GitHub — never to disk.\n',
  );

  const prompt = hiddenPrompter();
  let pushed = 0;
  try {
    for (const pack of packs) {
      console.log(`── ${pack.name}${pack.setupUrl ? `  →  ${pack.setupUrl}` : ''}`);
      for (const tok of pack.tokens) {
        const key = tok.envVar.toUpperCase(); // GitHub secret convention (matches infra.yml refs)
        if (key === 'GITHUB_TOKEN') {
          console.log('   · GITHUB_TOKEN — provided automatically by Actions; skipping');
          continue;
        }
        if (tok.scopes?.length) console.log(`   scopes: ${tok.scopes.join(', ')}`);
        if (tok.setupUrl) console.log(`   link: ${tok.setupUrl}`);
        const value = await prompt.ask(`   ${key} — ${tok.label}\n   value: `);
        if (!value) {
          console.log('   · skipped');
          continue;
        }
        if (tok.verify) {
          const check = await tok
            .verify(value, {})
            .catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
          if (!check.ok) {
            console.log(
              `   ✖ verify failed${check.detail ? ` (${check.detail})` : ''} — not pushed`,
            );
            continue;
          }
          console.log('   ✔ verified');
        }
        setGitHubSecret(repo, env, key, value);
        console.log(`   ✔ pushed ${key} → ${repo}`); // name only — never the value
        pushed++;
      }
    }
  } finally {
    prompt.close();
  }
  console.log(`\n${pushed} secret(s) pushed to ${repo}. (None written to disk.)`);
}

export async function secretsCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'gather') {
    const name = args[1];
    if (!name || name.startsWith('-')) {
      throw new Error('usage: greenlight secrets gather <name> [--repo owner/repo] [--env <env>]');
    }
    const repo = flag(args, '--repo') ?? detectRepo(process.cwd());
    if (!repo) throw new Error('could not determine the repo — pass --repo owner/repo');
    await gatherSecrets(name, repo, flag(args, '--env'));
    return;
  }

  if (sub !== 'sync') {
    console.log(
      'usage:\n' +
        '  greenlight secrets sync [--repo owner/repo] [--env <env>]            # push .greenlight/secrets.env\n' +
        '  greenlight secrets gather <name> [--repo owner/repo] [--env <env>]   # guided, link-first, straight to GitHub (no disk/logs)',
    );
    process.exit(sub ? 1 : 0);
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
