import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { loadManifest, resolveEntry } from '../manifest';
import { packsForTool, secretKeyFor } from '../providers';

/**
 * `greenlight secrets gather <name>` — guided, link-first token onboarding straight to a repo's
 * GitHub Actions secrets via `gh` (value on stdin; never echoed, never written to disk). GitHub
 * Actions is the single secret store: the local loop needs no secrets, and CI reads them at
 * deploy/apply time. Prefer GitHub OIDC → cloud over long-lived tokens where the target supports it.
 */

/**
 * Parse an OCI CLI config (the "Configuration file preview" OCI shows after *Add API key*).
 * INI-ish `key=value` lines under a `[PROFILE]` header; the first profile's values win. Keys
 * are lowercased; values kept verbatim (paths/OCIDs). We only care about user/fingerprint/
 * tenancy/region/key_file.
 */
export function parseOciConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!(key in out)) out[key] = line.slice(eq + 1).trim(); // first profile wins
  }
  return out;
}

/**
 * Build a name→value prefill from an OCI config preview (+ its PEM): the 5 auth secrets that
 * `secrets gather` can set without prompting (incl. the multi-line private key, read from the
 * file so it never has to be pasted). `keyPath` overrides the config's `key_file` (e.g. when the
 * .pem was downloaded somewhere else). Throws if the config is unreadable; warns + skips the key
 * if the PEM can't be found (the rest still prefill).
 */
export function ociPrefill(configPath: string, keyPath?: string): Map<string, string> {
  const cfg = parseOciConfig(readFileSync(configPath, 'utf8'));
  const map = new Map<string, string>();
  const set = (k: string, v?: string) => {
    if (v) map.set(k, v);
  };
  set('TF_VAR_OCI_USER_OCID', cfg.user);
  set('TF_VAR_OCI_FINGERPRINT', cfg.fingerprint);
  set('TF_VAR_OCI_TENANCY_OCID', cfg.tenancy);
  set('TF_VAR_OCI_REGION', cfg.region);
  const pem = keyPath ?? cfg.key_file;
  if (pem && existsSync(pem)) {
    map.set('TF_VAR_OCI_PRIVATE_KEY', readFileSync(pem, 'utf8'));
  } else if (pem) {
    console.log(`   ! PEM not found at ${pem} — set TF_VAR_OCI_PRIVATE_KEY manually (--oci-key)`);
  }
  return map;
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

export function detectRepo(cwd: string): string | null {
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

/** A hidden-input prompter over ONE readline interface (creating one per prompt loses piped
 * input between prompts). On a real TTY, readline's echo is suppressed so pasted values never
 * show; piped input (tests/CI) reads lines without echoing anyway. Close it when done. Exported
 * so `init`'s base-token onboarding can reuse the same no-echo prompt. */
export function hiddenPrompter(): { ask: (query: string) => Promise<string>; close: () => void } {
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

/** Names of secrets already set on the repo (or env) — so `gather` can flag overrides before
 * prompting. Best-effort: returns `null` if `gh` can't list (missing/unauth/no access) so the
 * caller can distinguish "couldn't read" from "repo has no secrets". Never blocks the gather. */
export function listGitHubSecrets(repo: string, env: string | undefined): Set<string> | null {
  const ghArgs = ['secret', 'list', '--repo', repo, '--json', 'name'];
  if (env) ghArgs.push('--env', env);
  try {
    const out = execFileSync('gh', ghArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // don't leak gh's stderr into the guided flow
    });
    const parsed = JSON.parse(out) as Array<{ name: string }>;
    return new Set(parsed.map((s) => s.name));
  } catch {
    return null;
  }
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
export async function gatherSecrets(
  name: string,
  repo: string,
  env: string | undefined,
  prefill?: Map<string, string>,
): Promise<void> {
  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  const packs = packsForTool({ lane: entry.lane, target: entry.target, data: entry.data });
  const dest = env ? `env "${env}" of ${repo}` : repo;
  const existing = listGitHubSecrets(repo, env); // flag which paste would override
  console.log(`Gathering secrets for "${name}" → GitHub ${dest}`);
  console.log(
    'Paste each value (hidden); Enter to skip. Values go straight to GitHub — never to disk.',
  );
  console.log(
    `[already set] = a value exists (paste to override, Enter to keep) · [not set] = new.${
      existing ? '' : ' (could not read existing secrets — annotations omitted)'
    }`,
  );
  if (prefill?.size) console.log(`Auto-filling ${prefill.size} value(s) from the OCI config.`);
  console.log('');

  const prompt = hiddenPrompter();
  let pushed = 0;
  try {
    for (const pack of packs) {
      console.log(`── ${pack.name}${pack.setupUrl ? `  →  ${pack.setupUrl}` : ''}`);
      for (const tok of pack.tokens) {
        // GitHub secret name (matches infra.yml refs) — the convention lives in secretKeyFor:
        // perTool tokens get a `_<TOOL>` suffix; a manifest tokenOverride (multi-account) wins.
        const key = secretKeyFor(tok, name, entry.tokenOverrides);
        if (key === 'GITHUB_TOKEN') {
          console.log('   · GITHUB_TOKEN — provided automatically by Actions; skipping');
          continue;
        }
        // Auto-fill from a provided source (e.g. the OCI config + PEM) — no prompt, no echo.
        const pre = prefill?.get(key);
        if (pre) {
          setGitHubSecret(repo, env, key, pre);
          console.log(`   ✔ ${existing?.has(key) ? 'overrode' : 'pushed'} ${key} ← OCI config`);
          pushed++;
          continue;
        }
        if (tok.scopes?.length) console.log(`   scopes: ${tok.scopes.join(', ')}`);
        if (tok.setupUrl) console.log(`   link: ${tok.setupUrl}`);
        const state = existing ? (existing.has(key) ? '  [already set]' : '  [not set]') : '';
        const value = await prompt.ask(`   ${key} — ${tok.label}${state}\n   value: `);
        if (!value) {
          console.log(existing?.has(key) ? '   · kept existing' : '   · skipped');
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
        const verb = existing?.has(key) ? 'overrode' : 'pushed';
        console.log(`   ✔ ${verb} ${key} → ${repo}`); // name only — never the value
        pushed++;
      }
    }
  } finally {
    prompt.close();
  }
  console.log(`\n${pushed} secret(s) pushed to ${repo}. (None written to disk.)`);
}

/** `greenlight secrets check [<name>]` — list the GitHub Actions secrets each tool's deploy/apply
 * needs (the required tokens from its provider packs + the agent RUN_TOKEN + its manifest `tokens`)
 * and flag any that are MISSING. Best-effort: it can't see secret VALUES, so it catches the
 * missing-secret class (the most common deploy footgun); expiry/scope stay a `verify()` concern. */
async function secretsCheck(name: string | undefined, repo: string): Promise<void> {
  const { config } = await loadManifest();
  const tools = name ? config.tools.filter((t) => t.name === name) : config.tools;
  if (name && tools.length === 0) throw new Error(`no tool "${name}" in the manifest`);
  const present = listGitHubSecrets(repo, undefined);
  console.log(`Secrets check → ${repo}`);
  if (!present) console.log('! could not list secrets (gh unauth/no access) — names only\n');
  else console.log('');

  let missing = 0;
  for (const t of tools) {
    const expected = new Set<string>();
    for (const pack of packsForTool({ lane: t.lane, target: t.target, data: t.data })) {
      for (const tok of pack.tokens) {
        if (!tok.optional) expected.add(secretKeyFor(tok, t.name, t.tokenOverrides));
      }
    }
    if (t.lane === 'agent') {
      expected.add('GEMINI_API_KEY');
      expected.add('RUN_TOKEN');
    }
    for (const s of t.tokens ?? []) expected.add(s);

    console.log(
      `── ${t.name} (${t.lane}/${t.target}${t.data && t.data !== 'none' ? `/${t.data}` : ''})`,
    );
    for (const key of [...expected].sort()) {
      const have = present ? present.has(key) : undefined;
      if (have === false) missing++;
      console.log(`   ${have === undefined ? '?' : have ? '✔' : '✘'} ${key}`);
    }
  }
  if (present)
    console.log(`\n${missing === 0 ? '✔ all required secrets present' : `✘ ${missing} missing`}`);
  process.exit(missing > 0 ? 1 : 0);
}

export async function secretsCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'check') {
    const name = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
    const repo = flag(args, '--repo') ?? detectRepo(process.cwd());
    if (!repo) throw new Error('could not determine the repo — pass --repo owner/repo');
    await secretsCheck(name, repo);
    return;
  }

  if (sub === 'gather') {
    const name = args[1];
    if (!name || name.startsWith('-')) {
      throw new Error('usage: greenlight secrets gather <name> [--repo owner/repo] [--env <env>]');
    }
    const repo = flag(args, '--repo') ?? detectRepo(process.cwd());
    if (!repo) throw new Error('could not determine the repo — pass --repo owner/repo');
    const ociConfig = flag(args, '--oci-config');
    const ociKey = flag(args, '--oci-key');
    const prefill = ociConfig
      ? ociPrefill(resolve(process.cwd(), ociConfig), ociKey && resolve(process.cwd(), ociKey))
      : undefined;
    await gatherSecrets(name, repo, flag(args, '--env'), prefill);
    return;
  }

  console.log(
    'usage:\n' +
      '  greenlight secrets gather <name> [--repo owner/repo] [--env <env>]   # guided, link-first, straight to GitHub (no disk/logs)\n' +
      '    [--oci-config <path>] [--oci-key <path>]                           # auto-fill OCI auth from the API-key config preview + .pem',
  );
  process.exit(sub ? 1 : 0);
}
