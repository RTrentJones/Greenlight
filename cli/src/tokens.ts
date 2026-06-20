/**
 * Token gathering + fail-fast verification, driven by the provider-pack registry. `init`
 * and `add` use this to make sure a tool's providers have their tokens in the local
 * gitignored store (`.greenlight/secrets.env`) before pointing the user at CI — and to
 * catch a wrong-scope / dead token immediately (the `verify()` curl-style checks), not on
 * the first failed `terraform apply`. Tokens live ONLY in the gitignored file (+ provider
 * stores via `secrets sync`); never committed or echoed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseSecretsEnv } from './commands/secrets';
import { type ProviderToolInfo, type TokenCheck, type TokenSpec, tokensForTool } from './providers';

const SECRETS_DIR = '.greenlight';
const SECRETS_FILE = 'secrets.env';

/** Tokens already available to a wrapper: `.greenlight/secrets.env` first, then process.env. */
export function presentEnv(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const p = resolve(cwd, SECRETS_DIR, SECRETS_FILE);
  if (existsSync(p)) {
    for (const { key, value } of parseSecretsEnv(readFileSync(p, 'utf8'))) out[key] = value;
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(k in out)) out[k] = v;
  }
  return out;
}

/** Upsert a KEY=VALUE into `.greenlight/secrets.env` (created 0600), preserving other lines
 * and comments. The value is never logged. */
export function upsertSecret(cwd: string, key: string, value: string): void {
  const dir = resolve(cwd, SECRETS_DIR);
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, SECRETS_FILE);
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else {
    while (lines.length && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    lines.push(`${key}=${value}`);
  }
  writeFileSync(p, `${lines.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
}

export interface TokenStatus {
  spec: TokenSpec;
  present: boolean;
}

/** Which of a tool's required/optional tokens are already present (pure; for reporting). */
export function tokenStatus(cwd: string, tool: ProviderToolInfo): TokenStatus[] {
  const env = presentEnv(cwd);
  return tokensForTool(tool).map((spec) => ({ spec, present: Boolean(env[spec.envVar]) }));
}

export interface EnsureResult {
  envVar: string;
  outcome: 'present' | 'entered' | 'skipped' | 'missing';
  verify?: TokenCheck;
}

/**
 * Ensure a tool's provider tokens are set, prompting (when a TTY exists) for missing ones
 * and running each provider's fail-fast `verify()`. Throws if a REQUIRED token's verify()
 * fails (wrong scope / dead token). Returns a per-token report. Non-fatal for optional
 * tokens; in a non-TTY it reports what to set instead of prompting.
 */
export async function ensureTokensForTool(
  cwd: string,
  tool: ProviderToolInfo,
  opts: { verify?: boolean } = {},
): Promise<EnsureResult[]> {
  const doVerify = opts.verify !== false;
  const interactive = Boolean(process.stdin.isTTY);
  const env = presentEnv(cwd);
  const results: EnsureResult[] = [];
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    for (const spec of tokensForTool(tool)) {
      let value = env[spec.envVar];
      if (value) {
        results.push({ envVar: spec.envVar, outcome: 'present' });
      } else if (rl) {
        console.log(`\n${spec.envVar} — ${spec.label}`);
        if (spec.scopes?.length) console.log(`  scopes: ${spec.scopes.join(', ')}`);
        const entered = (
          await rl.question(`  paste value${spec.optional ? ' (optional, Enter to skip)' : ''}: `)
        ).trim();
        if (!entered) {
          results.push({ envVar: spec.envVar, outcome: spec.optional ? 'skipped' : 'missing' });
          continue;
        }
        upsertSecret(cwd, spec.envVar, entered);
        env[spec.envVar] = entered;
        value = entered;
        results.push({ envVar: spec.envVar, outcome: 'entered' });
      } else {
        results.push({ envVar: spec.envVar, outcome: spec.optional ? 'skipped' : 'missing' });
        continue;
      }

      // fail-fast scope/auth check (only when we have a value + a checker)
      if (value && doVerify && spec.verify) {
        let check: TokenCheck;
        try {
          check = await spec.verify(value, env);
        } catch (e) {
          check = { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
        const last = results[results.length - 1];
        if (last) last.verify = check;
        if (!check.ok && !spec.optional) {
          throw new Error(
            `${spec.envVar} failed verification${check.detail ? ` (${check.detail})` : ''} — check the token's scopes (${spec.label}).`,
          );
        }
      }
    }
  } finally {
    rl?.close();
  }
  return results;
}
