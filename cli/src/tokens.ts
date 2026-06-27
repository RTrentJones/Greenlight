/**
 * Base-token onboarding + fail-fast verification, driven by the provider-pack registry. `init`
 * uses this to set the always-on providers' tokens (Cloudflare / HCP Terraform) as the wrapper's
 * GitHub Actions secrets before pointing the user at CI — and to catch a wrong-scope / dead token
 * immediately (the `verify()` curl-style checks), not on the first failed `terraform apply`.
 *
 * Secrets go STRAIGHT to GitHub Actions (via `gh`, value on stdin) — Greenlight keeps no local
 * secret file. The whole local loop (preview/verify/config/doctor/promote/build) needs no secrets;
 * `deploy` + `terraform apply` run in CI with those GitHub Actions secrets.
 */

import { hiddenPrompter, listGitHubSecrets, setGitHubSecret } from './commands/secrets';
import {
  type ProviderToolInfo,
  type TokenCheck,
  type TokenSpec,
  secretKeyFor,
  tokensForTool,
} from './providers';

/** Token names available to THIS process from the environment (CI exports them; locally, an
 * explicit `export`). Greenlight no longer reads a local secrets file — the store is GitHub
 * Actions, written via `secrets gather` / `init`. */
export function presentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface TokenStatus {
  spec: TokenSpec;
  present: boolean;
}

/** Which of a tool's required/optional tokens are present in THIS process's environment. The GitHub
 * Actions store is authoritative — query it with `gh secret list` / `greenlight doctor`. */
export function tokenStatus(tool: ProviderToolInfo): TokenStatus[] {
  const env = presentEnv();
  return tokensForTool(tool).map((spec) => ({ spec, present: Boolean(env[spec.envVar]) }));
}

export interface EnsureResult {
  envVar: string;
  outcome: 'present' | 'entered' | 'skipped' | 'missing';
  verify?: TokenCheck;
}

/**
 * Ensure a tool's provider tokens are set as the repo's GitHub Actions secrets: hidden-prompt (TTY
 * only) for the ones not already set, run each provider's fail-fast `verify()`, then push via `gh`.
 * Entered values go STRAIGHT to GitHub — never to disk, never echoed. Throws if a REQUIRED token's
 * verify() fails (wrong scope / dead token). Non-fatal for optional tokens; in a non-TTY it reports
 * what is missing instead of prompting.
 */
export async function ensureTokensForTool(
  repo: string,
  tool: ProviderToolInfo,
  opts: { verify?: boolean; env?: string } = {},
): Promise<EnsureResult[]> {
  const doVerify = opts.verify !== false;
  const env = presentEnv();
  const already = listGitHubSecrets(repo, opts.env); // GitHub secret names; null if gh can't list
  const results: EnsureResult[] = [];
  const prompt = process.stdin.isTTY ? hiddenPrompter() : null;

  try {
    for (const spec of tokensForTool(tool)) {
      const key = secretKeyFor(spec, '', undefined);
      // Actions injects GITHUB_TOKEN automatically — never prompt for or store it.
      if (key === 'GITHUB_TOKEN') {
        results.push({ envVar: spec.envVar, outcome: 'skipped' });
        continue;
      }
      if (env[spec.envVar] || already?.has(key)) {
        results.push({ envVar: spec.envVar, outcome: 'present' });
        continue;
      }
      if (!prompt) {
        results.push({ envVar: spec.envVar, outcome: spec.optional ? 'skipped' : 'missing' });
        continue;
      }
      console.log(`\n${key} — ${spec.label}`);
      if (spec.scopes?.length) console.log(`  scopes: ${spec.scopes.join(', ')}`);
      const entered = await prompt.ask(
        `  value${spec.optional ? ' (optional, Enter to skip)' : ''}: `,
      );
      if (!entered) {
        results.push({ envVar: spec.envVar, outcome: spec.optional ? 'skipped' : 'missing' });
        continue;
      }
      env[spec.envVar] = entered; // visible to a later token's verify(value, env)

      let check: TokenCheck | undefined;
      if (doVerify && spec.verify) {
        try {
          check = await spec.verify(entered, env);
        } catch (e) {
          check = { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
        if (!check.ok && !spec.optional) {
          throw new Error(
            `${key} failed verification${check.detail ? ` (${check.detail})` : ''} — check the token's scopes (${spec.label}).`,
          );
        }
        // An OPTIONAL token whose verify failed (a required one already threw above): don't push a
        // known-bad value to the secret store — skip it the same way an unverified `gather` does.
        if (!check.ok) {
          console.log(
            `  · ${key} not pushed (verify failed${check.detail ? `: ${check.detail}` : ''})`,
          );
          results.push({ envVar: spec.envVar, outcome: 'skipped', verify: check });
          continue;
        }
      }
      setGitHubSecret(repo, opts.env, key, entered);
      results.push({ envVar: spec.envVar, outcome: 'entered', verify: check });
    }
  } finally {
    prompt?.close();
  }
  return results;
}
