import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ACCESS_LOG,
  type BundleContext,
  BundleTrustError,
  MIN_RAW_READS,
  openBundle,
} from '../../bundle';
import { appendLogEntry } from '../../index-gen';
import { appendEvent } from '../../ledger';
import {
  type GeminiClient,
  type Usage,
  clientForRole,
  createLimiters,
  entryForRole,
} from '../../llm';
import { FileQuotaStore, usageFromLedger } from '../../llm/quota';
import type { ReactResult, ReactTool } from '../../llm/react';
import { LOG_FILE, loadWiki } from '../../load';
import { writeChangeset } from '../../patch';
import { findSecrets } from '../../redact';
import { loadSkills } from '../../skills';
import { spendEvent } from '../budget';
import type { QuotaStore } from '../runner';
import { type Ctx, type StepOutcome, ledgerEvents, stop } from './context';
import { inside } from './state';
import {
  type ExternalRole,
  type IterateOptions,
  IterationError,
  MAX_SUBMISSIONS,
  MAX_SUBMISSION_BYTES,
} from './types';

// ---- LLM roles (maintainer, proposer) ---------------------------------------------------------

interface RoleCall {
  client: GeminiClient;
  modelId: string;
  cap: number;
}

/** A client for `role` with the quota check of 06 §4.8: the model's day must hold the whole
 * request cap (steps + 2) before the call starts; otherwise the step waits for another day. */
export async function roleClient(
  c: Ctx,
  role: 'maintainer' | 'proposer',
  maxSteps: number,
): Promise<RoleCall | { short: string }> {
  const o = c.o;
  const store: QuotaStore = o.quotaStore ?? new FileQuotaStore({ root: join(c.stateDir, '..') });
  const limiters = createLimiters(c.config, { persistence: store, ...(o.throttle ?? {}) });
  for (const [id, u] of usageFromLedger(ledgerEvents(o.wikiRoot), [...limiters.keys()], {
    now: c.now(),
  }))
    store.raise(id, u.day, u.count);
  const modelId = entryForRole(c.config, role).id;
  const cap = maxSteps + 2;
  const left = (await limiters.get(modelId)?.remainingToday()) ?? 0;
  if (left < cap) {
    return {
      short: `daily quota: ${modelId} has ${left} request(s) left today and the ${role} may need ${cap}`,
    };
  }
  const client = clientForRole(c.config, role, {
    findSecrets: (t) => findSecrets(t),
    limiters,
    // Like every bench rollout (06 §4.8): never spend the other model's day; defer instead.
    allowFallback: false,
    ...(o.env ? { env: o.env } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.retryDelaysMs ? { retryDelaysMs: o.retryDelaysMs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  return { client, modelId, cap };
}

export function chargeSpend(c: Ctx, modelId: string, r: ReactResult<unknown>, label: string): void {
  if (r.requests === 0) return;
  const u: Usage = r.usage;
  appendEvent(
    c.o.wikiRoot,
    spendEvent({
      ts: c.now().toISOString(),
      usd: 0,
      rollouts: 0,
      requests: r.requests,
      tokensIn: u.promptTokens,
      tokensOut: u.candidateTokens + u.thoughtTokens,
      evaluationId: `${c.s.iterationId}/${label}`,
      model: modelId,
    }),
  );
}

/** A react error a later day can fix (quota, availability) versus one it cannot. */
export const resumable = (kind: string | undefined) =>
  kind === 'deferred' || kind === 'rate_limited' || kind === 'budget_exhausted';

/** `read_file` / `list_dir` confined to a bundle. The model addresses it as `bundle/<path>`. */
export function bundleFileTools(dir: string): ReactTool[] {
  const base = realpathSync(dir);
  const target = (p: unknown): string => {
    const raw = String(p ?? '').replace(/^\.?\/?(bundle\/?)?/, '');
    const abs = resolve(base, raw);
    if (!inside(base, abs)) throw new Error(`${String(p)} is outside the bundle`);
    if (existsSync(abs) && !inside(base, realpathSync(abs)))
      throw new Error(`${String(p)} resolves outside the bundle`);
    return abs;
  };
  return [
    {
      name: 'read_file',
      description: 'Read a file of the bundle (paths like bundle/wiki/index.md).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: (a) => {
        const f = target(a.path);
        if (!existsSync(f) || lstatSync(f).isDirectory())
          throw new Error(`no file ${String(a.path)}`);
        return readFileSync(f, 'utf8');
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory of the bundle (default: the bundle root).',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      run: (a) => {
        const d = target(a.path ?? '');
        if (!existsSync(d) || !lstatSync(d).isDirectory())
          throw new Error(`no directory ${String(a.path)}`);
        return readdirSync(d, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n');
      },
    },
  ];
}

export const zodIssue = (ctx: z.RefinementCtx, message: string) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });

export function markBundleFailed(c: Ctx, bundleId: string, why: string): void {
  const wiki = loadWiki(c.o.wikiRoot);
  const log = appendLogEntry(wiki.log, {
    ts: c.now().toISOString(),
    actor: 'harness',
    operation: `ingest failed ${bundleId}`,
    body: `maintainer bundle ${bundleId} failed after three submissions: ${why}`,
  });
  writeChangeset(c.o.wikiRoot, { writes: [{ path: LOG_FILE, content: log }] });
}

// ---- external roles (06 §2.5, §3.6) -----------------------------------------------------------

export const SUBMIT_FLAG: Record<ExternalRole, string> = {
  maintainer: '--maintainer-output',
  proposer: '--proposal',
};
const OUTPUT_NAME: Record<ExternalRole, string> = {
  maintainer: 'MaintainerOutput',
  proposer: 'ProposerOutput',
};

/** The command that hands an external role's output back to the iteration. */
const handbackCommand = (c: Ctx, role: ExternalRole): string =>
  [
    `greenlight bench iterate --resume ${c.s.iterationId}`,
    ...(c.s.settings.sandbox === 'process' ? ['--sandbox process'] : []),
    `${SUBMIT_FLAG[role]} <file>`,
    '--agent "<agent id>"',
  ].join(' ');

/** What PROMPT.md of an external role's bundle says above the verbatim prompt: the bundle belongs
 * to an iteration, so the output goes back through `bench iterate`, never through the stand-alone
 * `wiki ingest --apply` (which would write the wiki outside the iteration's state). */
export function handbackLines(c: Ctx, role: ExternalRole, bundleDir: string): string[] {
  const own =
    role === 'maintainer'
      ? [
          'Do NOT apply it yourself: never run `greenlight wiki ingest --apply` without `--dry-run`',
          '(`greenlight wiki ingest --apply <file> --dry-run` is a safe pre-check; it writes nothing).',
        ]
      : [
          'Read traces ONLY with `greenlight wiki traces --bundle <this dir>` and `greenlight wiki read',
          'raw:<id> --bundle <this dir>`, run from the directory that holds `.greenlight/`: only reads',
          `logged in ${bundleDir}/${ACCESS_LOG} count, and a change needs ${MIN_RAW_READS} distinct ones. Do not open`,
          'files outside this bundle. (`greenlight wiki propose --apply <file> --bundle <this dir>` is a',
          'safe pre-check of the proposal.)',
        ];
  return [
    `This bundle belongs to bench iteration ${c.s.iterationId}; you are its ${role}, working outside`,
    'the harness. Follow the greenlight-wiki skill. Write your output as ONE JSON object to a file',
    `(at most ${MAX_SUBMISSION_BYTES} bytes) and hand it back with:`,
    '',
    `    ${handbackCommand(c, role)}`,
    '',
    ...own,
    `A refused file comes back with its issues; a bundle takes ${MAX_SUBMISSIONS} submissions.`,
  ];
}

/** The bundle directory of an external role, which must lie inside the iteration directory: the
 * path comes from the state, and it is printed to an agent as where to work. */
export function externalBundleDir(c: Ctx, role: ExternalRole): string {
  const rel = c.s[role].bundleDir;
  const root = resolve(c.dir, 'bundles');
  const dir = resolve(c.dir, rel ?? '');
  if (!rel || dir === root || !inside(root, dir)) {
    throw new IterationError(
      `the ${role} bundle of iteration ${c.s.iterationId} (${rel ?? 'none'}) is not inside its iteration directory`,
      4,
    );
  }
  return dir;
}

/** True while `role`'s current bundle is on disk and is the one this harness issued (its
 * manifest carries the MAC of the key in `.greenlight/bundle-keys/`). */
export function bundleIssued(c: Ctx, role: ExternalRole): boolean {
  if (!c.s[role].bundleDir) return false;
  try {
    return openBundle(externalBundleDir(c, role), c.keysDir).manifest.role === role;
  } catch (e) {
    if (e instanceof BundleTrustError) return false;
    throw e;
  }
}

/** Stops the iteration as `awaiting-agent` (exit 5): the bundle is written, and a human or an
 * agent must produce the role's output and hand it back. Nothing failed and no quota is waited
 * for, so this is neither `failed` nor `deferred`. */
export function awaitAgent(
  c: Ctx,
  role: ExternalRole,
  refused?: string[],
  preface?: string,
): StepOutcome {
  const st = c.s[role];
  const bundle = externalBundleDir(c, role);
  const submissions = st.submissions ?? 0;
  const command = handbackCommand(c, role);
  st.status = 'awaiting-external';
  st.message = `awaiting an external agent's ${OUTPUT_NAME[role]} for bundle ${st.bundleId} (${submissions} of ${MAX_SUBMISSIONS} submissions refused)`;
  const reads =
    role === 'proposer'
      ? [
          `  read traces ONLY through the logged commands, run from the directory that holds .greenlight/: \`greenlight wiki traces --bundle ${bundle}\` and \`greenlight wiki read raw:<id> --bundle ${bundle}\` (also <page-id> and skill:<name>). A change needs at least ${MIN_RAW_READS} distinct logged raw reads; a file read any other way is not in the access log and does not count.`,
        ]
      : [];
  const message = [
    ...(preface ? [`${role}: ${preface}`] : []),
    ...(refused
      ? [
          `${role}: the submitted ${OUTPUT_NAME[role]} was refused (submission ${submissions} of ${MAX_SUBMISSIONS}); nothing was written:`,
          ...refused.slice(0, 10).map((e) => `  - ${e}`),
        ]
      : []),
    `${role}: awaiting an external agent (bench/models.json roles.${role} is "external"; the harness makes no model call for it).`,
    `  bundle: ${bundle}  (read PROMPT.md first)`,
    `  skill: greenlight-wiki, section "${role === 'maintainer' ? 'Maintainer' : 'Proposer'}" (.claude/skills/greenlight-wiki/SKILL.md)`,
    ...reads,
    `  write ONE ${OUTPUT_NAME[role]} JSON object to a file (at most ${MAX_SUBMISSION_BYTES} bytes), then hand it back with:`,
    `    ${command}`,
    `  ${MAX_SUBMISSIONS - submissions} submission(s) left for this bundle.`,
  ].join('\n');
  return stop(c, role, 'awaiting-agent', message, 5, {
    awaiting: { role, bundle, skill: 'greenlight-wiki', command, submissions },
    ...(refused ? { issues: refused } : {}),
  });
}

/** Reads a submitted output file as untrusted input: a regular file of at most
 * `MAX_SUBMISSION_BYTES`, parsed as JSON and nothing else (never executed, never resolved against
 * anything). A file that cannot be read at all is a missing prerequisite (exit 3) and no attempt;
 * one that is too large or is not a JSON object is an invalid submission. */
export function readSubmission(
  file: string,
  role: ExternalRole,
): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  const flag = SUBMIT_FLAG[role];
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a regular file');
    size = st.size;
  } catch (e) {
    throw new IterationError(`${flag}: cannot read ${file}: ${(e as Error).message}`, 3);
  }
  if (size > MAX_SUBMISSION_BYTES) {
    return {
      ok: false,
      issues: [`the file is ${size} bytes; a submission is at most ${MAX_SUBMISSION_BYTES}`],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, issues: [`the file is not valid JSON: ${(e as Error).message}`] };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: [`the file must hold one ${OUTPUT_NAME[role]} JSON object`] };
  }
  return { ok: true, value };
}

export const zodIssues = (e: z.ZodError): string[] =>
  e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));

/** A refused submission counts as one attempt; the third fails the bundle, as three rejected
 * `finish` calls fail a harness role (06 §2.4). */
export function refuseSubmission(c: Ctx, role: ExternalRole, issues: string[]): StepOutcome {
  const st = c.s[role];
  st.submissions = (st.submissions ?? 0) + 1;
  st.issues = issues.slice(0, 10);
  if (st.submissions < MAX_SUBMISSIONS) return awaitAgent(c, role, issues);
  const why = `finish_invalid: ${MAX_SUBMISSIONS} submissions refused (${issues.slice(0, 3).join('; ')})`;
  if (role === 'maintainer') markBundleFailed(c, st.bundleId as string, why);
  st.status = 'failed';
  st.message = why;
  return stop(
    c,
    role,
    'failed',
    [
      `${role}: ${why}`,
      ...issues.slice(0, 10).map((e) => `  - ${e}`),
      `  bundle ${st.bundleId} is failed; resume without a file for a fresh bundle.`,
    ].join('\n'),
    1,
    { issues },
  );
}

export function defaultContext(o: IterateOptions): BundleContext {
  return {
    installed: o.assets.greenlightVersion,
    cells: [],
    verifyCheckIds: [],
    skills: Object.fromEntries(
      loadSkills(o.skillsDir).map((s) => [s.name, s.version ?? 'unversioned']),
    ),
  };
}
