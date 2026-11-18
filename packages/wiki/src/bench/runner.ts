import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RawRecord,
  RawRecordSchema,
  findSecrets,
  installedSkills,
  newRawId,
  redact,
  runIdentity,
  sha256,
  treeIdentity,
  truncateExcerpt,
} from '@rtrentjones/greenlight-shared';
import { z } from 'zod';
import { maintainerRolePrompt } from '../bundle';
import { appendEvent } from '../ledger';
import { FallbackDisabledError, GeminiHttpError } from '../llm/gemini';
import {
  BudgetExhaustedError,
  type DailyUsage,
  RateLimitExhaustedError,
  type RateLimitPersistence,
  RequestBudget,
} from '../llm/limits';
import {
  checkModels,
  clientForRole,
  createLimiters,
  entryForRole,
  isExternalModel,
} from '../llm/models';

/** Backoff for transient model errors (429/5xx) inside a rollout. Free-tier demand spikes
 * last minutes, and a rollout cannot resume part-way, so the client's default (~10 s in total)
 * throws away a rollout's spent requests on the first spike. Three retries reaching ~1 minute
 * in total keep a rollout well inside the shortest task timeout (10 min). Part of the
 * runner's behaviour, so it is covered by RUNNER_VERSION in the identity. */
export const ROLLOUT_RETRY_DELAYS_MS: readonly number[] = [4_000, 15_000, 45_000];
import { FileQuotaStore, usageFromLedger } from '../llm/quota';
import {
  HARNESS_VENDOR,
  HARNESS_VERSION,
  type ReactResult,
  type ReactTool,
  type Skill,
  type TranscriptEntry,
  buildSystemPrompt,
  runReact,
} from '../llm/react';
import { LEDGER_FILE, loadWiki, parseLedger } from '../load';
import { applyMaintainerOutput } from '../patch';
import {
  type BaselineIdentity,
  BaselineIdentitySchema,
  type Budget,
  BudgetSchema,
  type EvaluationRecord,
  EvaluationRecordSchema,
  type ModelsConfig,
  ModelsConfigSchema,
  type TaskSpec,
  evalEvidencePath,
  identityDiff,
  sealRecord,
} from '../schema/bench';
import {
  MAINTAINER_OUTPUT_JSON_SCHEMA,
  type MaintainerOutput,
  MaintainerOutputSchema,
} from '../schema/io';
import type { LedgerEvent } from '../schema/ledger';
import { checkBudget, estimateGateCost, spendEvent } from './budget';
import { type LoadedTask, loadTasks } from './check-graders';
import {
  DEFAULT_CLAIM_TIMEOUT_MS,
  DEFAULT_EXTERNAL_CONCURRENCY,
  DEFAULT_EXTERNAL_TIMEOUT_FACTOR,
  EXTERNAL_AGENT_ID_RE,
  EXTERNAL_VENDOR,
  RolloutServer,
  externalBudgetNote,
} from './external';
import { gradeRollout } from './grade';
import type { JudgeFn } from './grader-api';
import { computeIdentity, sameIdentity } from './identity';
import { safeGit } from './outlets';
import {
  type RunnerImage,
  type Sandbox,
  WORK_DIR,
  createDockerSandbox,
  createProcessSandbox,
  ensureRunnerImage,
  shimUid,
  shortSocketDir,
  stageRollout,
  treeDiff,
} from './sandbox';
import { Sequencer, ShimChannel, mergeTrajectory, toJsonl, toolCallEvent } from './shims';

/**
 * `greenlight bench run` (vision 06 §1.3–§1.5, §4.2, §4.8, §9; 08 §5, §8, §10; roadmap M1-05/06).
 *
 * One evaluation = the selected tasks × models × runs in one mode, under one BaselineIdentity:
 * 1. resolve the selection, compute the identity (identity.ts), and for a train run reuse a
 *    sealed train EvaluationRecord with the identical identity unless `force` (06 §1.5);
 * 2. refuse BEFORE any request when the budget (bench/budget.json, `checkBudget`) or the model
 *    check (`checkModels`) says no;
 * 3. run each rollout: a fresh sandbox (sandbox.ts) holding the fixture and the skills, the ReAct
 *    loop on the host (the model key never enters the sandbox), every tool call executed inside,
 *    the shim channel (shims.ts) recording commands; then kill every agent process, export the
 *    final tree, remove the sandbox, and grade in a separate container (grade.ts);
 * 4. write one `bench` RawRecord per rollout (`.greenlight/raw/`), a `spend` ledger event per model
 *    per invocation, and — once every rollout has an outcome — the sealed EvaluationRecord under
 *    `<wiki>/evidence/eval/<hash>.json`.
 *
 * Quota is scheduled per model (06 §4.8): before each rollout the runner checks that the model's
 * remaining daily quota covers the rollout's request cap (`harness.limits.requestsPerRollout`,
 * plus the eval judge's call on the judge model) and otherwise skips that model for today; it
 * always runs next the model with the most quota left, so the models interleave. A rollout that
 * is deferred anyway (the model stayed unavailable with fallback off, or another process spent
 * the quota) defers ONLY its model; the others keep running. Progress persists at
 * `.greenlight/bench/runs/<evaluationId>/progress.json` and the run returns `deferred` with the
 * keys left per model; `resume` continues it later under an identical identity (a changed
 * identity, the limits included, is refused). A rollout refused by the redaction guard, a harness
 * error and a model error produce NO outcome: the evaluation stays unsealed (invalid), never a
 * fake 0. A trajectory that is incomplete (an origin ref moved with no recorded command, a lost or
 * truncated shim event) is an outcome with `graderError`: invalid at the gate, never a pass.
 *
 * External rollouts (06 §4.9): when the selected models are `external` in bench/models.json, step
 * 3's ReAct loop is replaced by an agent launched from outside the harness. The runner opens up to
 * `concurrency` sandboxes at once, serves each through the rollout server (external.ts) and writes
 * a manifest for the launcher; the agent drives the SAME tools through the rollout client, and
 * everything after the agent's last step (kill, export, grading, raw record, sealing) is the same
 * code. No model client, no quota and no spend event exist for an external model; the identity
 * carries `agent.vendor: external` and the declared agent id as `agent.version`.
 */

export interface RunnerAssets {
  /** Directory of the built CLI (`greenlight.mjs` + `node_modules/`), mounted read-only. */
  cliDir: string;
  /** hashTree(cliDir): part of `depsHash`. */
  cliBuildHash: string;
  greenlightVersion: string;
  /** The grading bundle (`bench-grade.mjs`). */
  gradeBundle: string;
  /** The bench runner's lockfile (`pnpm-lock.yaml`). */
  lockfile: string;
}

export type EvalRole = 'train' | 'baseline' | 'candidate';
export type SandboxKind = 'docker' | 'process';
type Split = TaskSpec['split'];

export interface BenchRunOptions {
  repoRoot: string;
  benchDir: string;
  skillsDir: string;
  /** Wiki root (ledger + evidence/eval). */
  wikiRoot: string;
  /** Holds `raw/`, `bench/runs/`, `quota/` (default `<repoRoot>/.greenlight`). */
  stateDir?: string;
  runnerDir?: string;
  split?: Split;
  /** Globs over task ids (`*` within a segment, `**` across). */
  tasks?: string[];
  /** Role names (`frontier`, `small`) or model ids. Default both. */
  models?: string[];
  runs?: number;
  mode?: 'isolation';
  role?: EvalRole;
  proposalId?: string;
  sandbox: SandboxKind;
  resume?: string;
  force?: boolean;
  /** A baseline evaluation reuses a sealed baseline record of exactly this identity (the accepted
   * skill set's R_best, 06 §5.1 step 1) that covers every requested rollout and is at most this
   * many days old (`bench/gate.json` `maxBaselineAgeDays`). Unset: a baseline always runs. */
  reuseBaselineMaxAgeDays?: number;
  /** Max ReAct steps per rollout (default {@link DEFAULT_MAX_STEPS}; on resume, the evaluation's). */
  maxSteps?: number;
  /** Hard cap on LLM requests per rollout, retries included (default `maxSteps + 2`). Part of the
   * identity, and what the per-model quota check reserves before a rollout starts. */
  rolloutRequestCap?: number;
  /** Hard cap on LLM requests for this invocation (also capped by `perGateMaxRequests`). */
  maxRequests?: number;
  /** For the budget estimate (bench/README-models.md: 12). */
  requestsPerRollout?: number;
  /** The daily quota store (default: `FileQuotaStore` under `<stateDir>/..`); tests inject one. */
  quotaStore?: QuotaStore;
  assets: RunnerAssets;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** The free-tier rpm throttle's clock (tests pass a fake one). */
  throttle?: { now: () => number; sleep: (ms: number) => Promise<void> };
  skipModelsCheck?: boolean;
  /** Overrides each task's `timeoutMin` (tests). */
  rolloutTimeoutMs?: number;
  dockerBin?: string;
  log?: (s: string) => void;
  /** `external`: the rollouts are driven by an outside agent (06 §4.9). Unset: decided by the
   * selected models (external in bench/models.json or not); set, it must agree with them. */
  agentMode?: 'harness' | 'external';
  /** External rollouts: the declared agent id (who drives them, e.g. `claude-code/<model>`).
   * Recorded as the identity's `agent.version`; on resume, the evaluation's own by default. */
  agent?: string;
  /** External rollouts: the manifest file a launcher polls (default: next to the client). */
  manifest?: string;
  /** External rollouts: where the client is written (default: a fresh directory under the
   * system temp dir, outside the repository). */
  externalDir?: string;
  /** External rollouts: sandboxes open at once (default 4). */
  concurrency?: number;
  /** External rollouts: an open rollout nobody claims within this is deferred (default 10 min). */
  claimTimeoutMs?: number;
  /** External rollouts: the wall clock is the rollout timeout times this (default 3). Part of
   * `harness.limits`. */
  externalTimeoutFactor?: number;
}

export type RunStatus =
  | 'complete'
  | 'cached'
  | 'deferred'
  | 'incomplete'
  | 'refused'
  | 'budget-refused'
  | 'models-unavailable'
  | 'policy-refused'
  | 'usage';

export interface RolloutSummary {
  task: string;
  model: string;
  run: number;
  rawId: string;
  status: 'graded' | 'deferred' | 'refused' | 'error';
  score?: 0 | 1;
  reason?: string;
  requests: number;
  killedProcesses?: number;
}

export interface RunResult {
  status: RunStatus;
  message: string;
  evaluationId?: string;
  identity?: BaselineIdentity;
  record?: EvaluationRecord;
  recordPath?: string;
  rollouts: RolloutSummary[];
  /** Requests made by this invocation. */
  requests: number;
  /** On `deferred`: the rollout keys (`task|model|run`) still to run, per model. */
  remaining?: Record<string, string[]>;
  /** On `deferred`: why each deferred model stopped (quota, unavailable, request cap). */
  deferredModels?: Record<string, string>;
  /** External rollouts: the manifest the invocation wrote. */
  manifest?: string;
}

/** The daily quota persistence the runner reads remaining quota from and seeds from the ledger. */
export interface QuotaStore extends RateLimitPersistence {
  /** Raises today's count to at least `count` (never lowers it). */
  raise(modelId: string, day: string, count: number): DailyUsage;
}

const ROLLOUT_KEY = (t: string, m: string, r: number) => `${t}|${m}|${r}`;

export const REQUESTS_PER_ROLLOUT = 12;
/** 25: reading the first sealed baselines showed 15 steps too tight for the replay tasks (most
 * rollouts spent 6–10 of them exploring), as 10 had been before (bench/README-models.md). */
export const DEFAULT_MAX_STEPS = 25;
/** From this many steps left, every tool response says how many remain (06 §4.8). */
export const ANNOUNCE_REMAINING_STEPS = 5;
/** The per-rollout request cap for `maxSteps`: one request per step plus two retries' headroom. */
export const rolloutRequestCap = (maxSteps: number): number => maxSteps + 2;

// ---------------------------------------------------------------------------------------------
// selection

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Role names or ids → configured model ids, in models.json order (frontier, small). */
export function resolveModels(config: ModelsConfig, wanted?: readonly string[]): string[] {
  const entries = [
    ['frontier', config.roles.frontier.id],
    ['small', config.roles.small.id],
  ] as const;
  if (!wanted || wanted.length === 0) return entries.map(([, id]) => id);
  for (const w of wanted) {
    if (!entries.some(([r, id]) => r === w || id === w))
      throw new UsageError(`unknown model "${w}" (expected frontier, small or a configured id)`);
  }
  return entries.filter(([r, id]) => wanted.includes(r) || wanted.includes(id)).map(([, id]) => id);
}

const roleOf = (config: ModelsConfig, id: string): 'frontier' | 'small' =>
  config.roles.frontier.id === id ? 'frontier' : 'small';

export class UsageError extends Error {}

/** `models/x` and `x` name one model (the API's `modelVersion` may carry the prefix). */
export const normalizeModelId = (id: string): string => id.replace(/^models\//, '');

// ---------------------------------------------------------------------------------------------
// progress (resume)

const OutcomeArray = z.array(z.unknown());
export const ProgressSchema = z
  .object({
    v: z.literal(1),
    evaluationId: z.string().min(1),
    startedAt: z.string(),
    identity: BaselineIdentitySchema,
    selection: z
      .object({
        split: z.enum(['train', 'val', 'test']),
        role: z.enum(['train', 'baseline', 'candidate']),
        proposalId: z.string().optional(),
        tasks: z.array(z.string()),
        models: z.array(z.string()),
        runs: z.number().int().min(1),
        mode: z.literal('isolation'),
        sandbox: z.enum(['docker', 'process']),
      })
      .strict(),
    outcomes: OutcomeArray,
    rawIds: z.array(z.string()),
    problems: z.array(z.object({ key: z.string(), kind: z.string(), message: z.string() })),
    status: z.string(),
    /** Set with `status: complete`: the sealed EvaluationRecord, so a caller that crashed between
     * the seal and its own save finds it (`sealedRecordFor`). */
    recordHash: z.string().optional(),
  })
  .strict();
export type Progress = z.infer<typeof ProgressSchema>;
type Outcome = EvaluationRecord['outcomes'][number];

export const progressPath = (stateDir: string, evaluationId: string) =>
  join(stateDir, 'bench', 'runs', evaluationId, 'progress.json');

function saveProgress(stateDir: string, p: Progress): void {
  const file = progressPath(stateDir, p.evaluationId);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
}

/**
 * The sealed record of a COMPLETE evaluation, else undefined. A complete evaluation cannot be
 * resumed (a usage error), so a caller whose own state missed the seal (a crash between the seal
 * and its save) loads the record instead: by the progress file's `recordHash`, or, for a progress
 * file from before it, the record of the same role and proposal holding exactly its raw ids.
 */
export function sealedRecordFor(
  stateDir: string,
  wikiRoot: string,
  evaluationId: string,
): EvaluationRecord | undefined {
  const file = progressPath(stateDir, evaluationId);
  if (!existsSync(file)) return undefined;
  const parsed = ProgressSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success || parsed.data.status !== 'complete') return undefined;
  const p = parsed.data;
  const records = loadEvaluationRecords(wikiRoot);
  if (p.recordHash) return records.find((r) => r.hash === p.recordHash);
  const want = [...new Set(p.outcomes.map((x) => (x as { rawId?: string }).rawId))].sort();
  return records.find(
    (r) =>
      r.role === p.selection.role &&
      (r.proposalId ?? undefined) === p.selection.proposalId &&
      [...new Set(r.outcomes.map((x) => x.rawId))].sort().join('\n') === want.join('\n'),
  );
}

// ---------------------------------------------------------------------------------------------
// evaluation records

export function loadEvaluationRecords(wikiRoot: string): EvaluationRecord[] {
  const dir = join(wikiRoot, 'evidence', 'eval');
  if (!existsSync(dir)) return [];
  const out: EvaluationRecord[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { kind?: string };
      if (raw.kind === 'gate-input') continue;
      const r = EvaluationRecordSchema.safeParse(raw);
      if (r.success) out.push(r.data);
    } catch {
      // not a record
    }
  }
  return out;
}

/** A sealed train record with exactly this identity that covers every requested rollout. */
export function findCachedTrain(
  records: readonly EvaluationRecord[],
  identity: BaselineIdentity,
  keys: readonly string[],
): EvaluationRecord | undefined {
  return findCachedRecord(records, identity, keys, 'train');
}

/** A sealed record of `role` with exactly this identity that covers every requested rollout,
 * optionally created within a time window (epoch ms); the newest such record wins. */
export function findCachedRecord(
  records: readonly EvaluationRecord[],
  identity: BaselineIdentity,
  keys: readonly string[],
  role: EvaluationRecord['role'],
  window: { createdAfter?: number; createdBefore?: number } = {},
): EvaluationRecord | undefined {
  const at = (r: EvaluationRecord) => Date.parse(r.createdAt);
  return records
    .filter(
      (r) =>
        r.role === role &&
        sameIdentity(r.identity, identity) &&
        (window.createdAfter === undefined || at(r) >= window.createdAfter) &&
        (window.createdBefore === undefined || at(r) <= window.createdBefore) &&
        keys.every((k) => r.outcomes.some((o) => ROLLOUT_KEY(o.task, o.model, o.run) === k)),
    )
    .sort((a, b) => at(b) - at(a))[0];
}

function ledgerEvents(wikiRoot: string): LedgerEvent[] {
  const f = join(wikiRoot, LEDGER_FILE);
  return existsSync(f) ? parseLedger(readFileSync(f, 'utf8')).events : [];
}

// ---------------------------------------------------------------------------------------------
// the inference agent

export const AGENT_ROLE_PROMPT = `You are a software engineer working in a git repository checked out at the current directory
(${WORK_DIR}). Complete the task you are given the way the skills above say to.

Tools: read_file, write_file, list_dir and list_files take paths relative to the repository root
(list_files lists a whole directory tree in one call; read_file takes an optional line offset and
limit); bash runs a shell command there. git and the \`greenlight\` CLI are on PATH; where a skill
writes \`pnpm greenlight …\` or \`npx greenlight …\`, that works too and runs the same CLI (no other
package-manager command does: nothing can be installed). The network is unavailable except
localhost, and there are no provider credentials: anything that would need a real cloud account
cannot succeed here, so do not try to work around that. The repository has a local \`origin\`
remote with the branches main and develop.

When you are done, call \`finish\` with a one-paragraph summary of what you did.`;

/** The rollout's limits, stated to the model (06 §4.8): a budget it cannot see is a budget it
 * cannot plan for. Appended to every role prompt. */
export function budgetNote(limits: { maxSteps: number; requestsPerRollout: number }): string {
  return `Budget: you have at most ${limits.maxSteps} steps (one step is one of your turns; a turn may call
several tools at once) and ${limits.requestsPerRollout} model requests in all. The run ends when either runs out,
whatever state the work is in, so plan for it: explore briefly, do the work, and call \`finish\`
with steps to spare. From ${ANNOUNCE_REMAINING_STEPS} steps left, every tool response tells you how many remain.`;
}

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || v === '') throw new Error(`${name} must be a non-empty string`);
  return v;
};

/** Max files `list_files` returns in one call. */
const LIST_FILES_MAX = 2000;

/** `read_file`'s window: 1-based `offset`, `limit` lines; a note says what was left out. */
export function sliceLines(text: string, offset?: unknown, limit?: unknown): string {
  const int = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
  const from = int(offset);
  const count = int(limit);
  if (from === undefined && count === undefined) return text;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const start = (from ?? 1) - 1;
  if (start >= lines.length) return `[no line ${start + 1}: the file has ${lines.length} line(s)]`;
  const end = count === undefined ? lines.length : Math.min(lines.length, start + count);
  const body = lines.slice(start, end).join('\n');
  return `${body}\n[lines ${start + 1}–${end} of ${lines.length}]`;
}

/**
 * The agent's tools. `readOnly` (a maintainer rollout) leaves out `write_file` and `bash`: a
 * maintainer's product is its MaintainerOutput, nothing it writes to disk is read, and offering
 * the tools only invites spending steps on them.
 */
function agentTools(
  sb: Sandbox,
  onCall: (name: string, args: Record<string, unknown>) => void,
  o: { readOnly?: boolean } = {},
) {
  const wrap = (t: ReactTool): ReactTool => ({
    ...t,
    run: (args, ctx) => {
      onCall(t.name, args);
      return t.run(args, ctx);
    },
  });
  const tools: ReactTool[] = [
    {
      name: 'read_file',
      description:
        'Read a text file (path relative to the repository root). A long file is cut at the end: pass offset (first line, 1-based) and limit (number of lines) to read a part of it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: 'first line to return, 1-based' },
          limit: { type: 'integer', description: 'number of lines to return' },
        },
        required: ['path'],
      },
      keep: 'head',
      async run(args) {
        const r = await sb.exec(['cat', '--', str(args.path, 'path')]);
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot read ${String(args.path)}`);
        return sliceLines(r.stdout, args.offset, args.limit);
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content (parent dirs are created).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      async run(args) {
        const path = str(args.path, 'path');
        // A missing or non-string content used to write an EMPTY file and report success.
        if (typeof args.content !== 'string')
          throw new Error('content must be a string (the whole file); nothing was written');
        const content = args.content;
        const r = await sb.exec(
          ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path],
          { stdin: content },
        );
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot write ${path}`);
        return `wrote ${content.length} chars to ${path}`;
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory (default: the repository root).',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      keep: 'head',
      async run(args) {
        const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
        const r = await sb.exec(['ls', '-la', '--', path]);
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
        return r.stdout;
      },
    },
    {
      name: 'list_files',
      description:
        'List every file under a directory, recursively, one path per line (default: the whole repository; .git and node_modules are skipped). Use it once instead of walking the tree with list_dir.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          depth: { type: 'integer', description: 'how many directory levels to descend' },
        },
      },
      keep: 'head',
      async run(args) {
        const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
        const depth =
          typeof args.depth === 'number' && args.depth >= 1 ? Math.floor(args.depth) : undefined;
        const r = await sb.exec([
          'find',
          path,
          ...(depth !== undefined ? ['-maxdepth', String(depth)] : []),
          '(',
          '-name',
          '.git',
          '-o',
          '-name',
          'node_modules',
          ')',
          '-prune',
          '-o',
          '-type',
          'f',
          '-print',
        ]);
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
        const files = r.stdout
          .split('\n')
          .filter(Boolean)
          .map((f) => f.replace(/^\.\//, ''))
          .sort();
        const shown = files.slice(0, LIST_FILES_MAX);
        return files.length > shown.length
          ? `${shown.join('\n')}\n[${files.length - shown.length} more file(s): list a subdirectory]`
          : shown.join('\n') || '(no files)';
      },
    },
    {
      name: 'bash',
      description:
        'Run a shell command in the repository root. Returns the exit code, stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_sec: { type: 'integer', description: 'default 120, max 600' },
        },
        required: ['command'],
      },
      async run(args) {
        const secs = Math.min(600, Math.max(1, Number(args.timeout_sec ?? 120) || 120));
        const r = await sb.exec(['bash', '-c', str(args.command, 'command')], {
          timeoutMs: secs * 1000,
        });
        const parts = [`exit=${r.exit}${r.timedOut ? ' (timed out)' : ''}`];
        if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''));
        if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, '')}`);
        return parts.join('\n');
      },
    },
  ];
  const READ_ONLY = new Set(['read_file', 'list_dir', 'list_files']);
  return tools.filter((t) => !o.readOnly || READ_ONLY.has(t.name)).map(wrap);
}

const CodingFinish = {
  description: 'Finish the task: a one-paragraph summary of what you did.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  schema: z.object({ summary: z.string() }).passthrough(),
};

/**
 * The maintainer's `finish`: its arguments ARE the MaintainerOutput (08 §9.1), declared to the
 * model with the production JSON schema and enforced with the production zod schema plus the
 * production patch engine against the bundle's wiki, exactly as `greenlight bench iterate` does
 * (06 §2.4). A rejected submission goes back to the model with its issues, up to three times.
 */
export function maintainerFinish(bundleDir: string) {
  const wikiDir = join(bundleDir, 'wiki');
  const schema = MaintainerOutputSchema.superRefine((v, ctx) => {
    if (!existsSync(wikiDir)) return;
    const applied = applyMaintainerOutput(loadWiki(wikiDir), v, { actor: 'maintainer:bench' });
    if (!applied.ok)
      for (const message of applied.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });
  return {
    description:
      'Submit the MaintainerOutput (08 §9.1): the arguments of this call are the output object itself.',
    parameters: MAINTAINER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    schema: schema as unknown as z.ZodType<MaintainerOutput>,
  };
}

/** A skill a task declares that is not in the skills directory. A rollout without the skill
 * under test measures something else, so this is a harness error, never a graded 0. */
export class MissingSkillError extends Error {}

export function loadSkillsFor(skillsDir: string, names: readonly string[]): Skill[] {
  return names.map((name) => {
    const f = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(f))
      throw new MissingSkillError(
        `skill "${name}" is declared by the task but ${join(skillsDir, name, 'SKILL.md')} does not exist`,
      );
    return { name, content: readFileSync(f, 'utf8') };
  });
}

/** Every text file under `dir` (at most 1 MB each): what the task itself shows the agent. */
function fixtureTexts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && lstatSync(p).size <= 1024 * 1024) out.push(readFileSync(p, 'utf8'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * The send guard for a rollout (06 §4.8): `findSecrets`, minus values the task's own fixture
 * shows in the clear. The detector reads CONTEXT: a fixture's publishable key
 * (`sb_publishable_…_fixture_anon`) is clean as `"anonKey": "…"` in `targets.json`, but the same
 * value is flagged in the model's own `curl -H "apikey: …"`, and the next request was refused,
 * which stopped the whole evaluation over a value the harness itself had handed the model.
 *
 * A flagged value is let through only when it occurs verbatim in a fixture text (or the brief)
 * AND the detector does not flag it there. A value the detector flags in the fixture itself (a
 * real token committed to a fixture by mistake) is still refused, as is any value that is not in
 * the fixture at all.
 */
export function fixtureAwareDetector(texts: readonly string[]): (text: string) => unknown[] {
  const flaggedInFixture = new Set<string>();
  for (const t of texts)
    for (const f of findSecrets(t)) flaggedInFixture.add(t.slice(f.index, f.index + f.length));
  const shown = (value: string) =>
    value.length >= 8 &&
    !flaggedInFixture.has(value) &&
    texts.some((t) => t.includes(value)) &&
    ![...flaggedInFixture].some((bad) => bad.includes(value) || value.includes(bad));
  return (text) => findSecrets(text).filter((f) => !shown(text.slice(f.index, f.index + f.length)));
}

/** `skills.used`: the skills injected into the prompt, plus any SKILL.md the agent read. */
function usedSkills(
  transcript: readonly TranscriptEntry[],
  installed: Record<string, { version: string; contentHash: string }>,
  injected: readonly string[],
) {
  const used = new Set(injected);
  for (const e of transcript) {
    if (e.kind !== 'tool_call') continue;
    const text = JSON.stringify(e.args);
    for (const m of text.matchAll(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/g))
      used.add(m[1] as string);
  }
  return Object.fromEntries(
    [...used]
      .filter((n) => installed[n])
      .map((n) => [n, installed[n] as { version: string; contentHash: string }]),
  );
}

/** Every string leaf redacted (stored transcripts never keep a flagged value). */
function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/** Paths of every string leaf the detector flags. Scanning the parsed value, not its JSON text,
 * matters: JSON escaping turns a newline into a literal `\n`, so a line such as
 * `github_token = var.keepalive_github_token` stops looking like a code expression and is
 * flagged in the serialized form although it is clean as the string it is (2026-11-04 drill). */
export function flaggedLeaves(v: unknown, path = '$'): string[] {
  if (typeof v === 'string') return findSecrets(v).length > 0 ? [path] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => flaggedLeaves(x, `${path}[${i}]`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => flaggedLeaves(x, `${path}.${k}`));
  return [];
}

/** Replaces each flagged string leaf (by the paths `flaggedLeaves` returns) in place. */
function withholdLeaves(v: unknown, paths: Set<string>, path = '$'): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const p = `${path}[${i}]`;
      if (typeof x === 'string' && paths.has(p))
        v[i] = '[withheld: flagged by the secret detector]';
      else withholdLeaves(x, paths, p);
    });
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      const p = `${path}.${k}`;
      if (typeof x === 'string' && paths.has(p))
        o[k] = '[withheld: flagged by the secret detector]';
      else withholdLeaves(x, paths, p);
    }
  }
}

/** The rollout artifacts that hold agent-written text besides the transcript. */
export const REDACTED_ARTIFACTS = ['trajectory.jsonl', 'diff.patch', 'output.json'] as const;

/**
 * Redacts the stored copies of a rollout's trajectory, diff and maintainer output in place (08
 * §5.2: raw capture redacts). Call it only once grading is done: the grader reads the originals.
 * JSON and JSONL are redacted leaf by leaf so they stay parseable; anything else as text.
 */
export function redactArtifacts(dir: string): void {
  const json = (text: string) => JSON.stringify(redactDeep(JSON.parse(text)));
  for (const name of REDACTED_ARTIFACTS) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    let out: string;
    try {
      if (name.endsWith('.jsonl'))
        out = text
          .split('\n')
          .map((l) => (l.trim() ? json(l) : l))
          .join('\n');
      else if (name.endsWith('.json'))
        out = `${JSON.stringify(redactDeep(JSON.parse(text)), null, 2)}\n`;
      else out = redact(text);
    } catch {
      out = redact(text);
    }
    if (out !== text) writeFileSync(file, out);
  }
}

function seedFor(task: string, model: string, run: number): number {
  return Number.parseInt(sha256(`${task}|${model}|${run}`).slice(0, 8), 16) & 0x7fffffff;
}

function sourceRepo(repoRoot: string): string {
  try {
    const url = safeGit(repoRoot, ['remote', 'get-url', 'origin']);
    const m = url.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    // no remote
  }
  return 'local/greenlight';
}

// ---------------------------------------------------------------------------------------------

interface RunCtx {
  o: BenchRunOptions;
  config: ModelsConfig;
  stateDir: string;
  runnerDir: string;
  image?: RunnerImage;
  identity: BaselineIdentity;
  evaluationId: string;
  progress: Progress;
  limiters: ReturnType<typeof createLimiters>;
  budget: RequestBudget;
  limits: Limits;
  repo: { sourceRepo: string; gitSha: string | null; dirty: boolean; treeHash?: string };
  run: { runId: string; attempt: number };
  now: () => Date;
  log: (s: string) => void;
  /** Set when the rollouts are driven by an outside agent (06 §4.9). */
  external?: { server: RolloutServer; agent: string; claimTimeoutMs: number };
}

type Limits = NonNullable<BaselineIdentity['harness']['limits']>;
type Usage = { requests: number; tokensIn: number; tokensOut: number };

interface RolloutOutcome {
  summary: RolloutSummary;
  outcome?: Outcome;
  stop?: 'deferred' | 'refused';
  /** The deferral stopped the whole invocation (its request cap), not just this model. */
  stopAll?: boolean;
  /** Whether a raw record was written (never for a deferred rollout). */
  raw: boolean;
  /** The rollout model's own usage (the ReAct loop). */
  usage: Usage;
  /** The eval judge's usage, spent on the judge model. */
  judgeUsage?: Usage;
}

/** `installedSkills` of the exported tree without following anything out of it: only real
 * directories and regular SKILL.md files under 1 MB are read, through a private copy. */
function treeSkills(tree: string): ReturnType<typeof installedSkills> {
  const mirror = mkdtempSync(join(tmpdir(), 'greenlight-skills-'));
  const st = (p: string) => {
    try {
      return lstatSync(p);
    } catch {
      return undefined;
    }
  };
  try {
    for (const root of ['.agents/skills', '.claude/skills']) {
      let dir = tree;
      let ok = true;
      for (const part of root.split('/')) {
        dir = join(dir, part);
        if (!st(dir)?.isDirectory()) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const name of readdirSync(dir)) {
        if (!st(join(dir, name))?.isDirectory()) continue;
        const file = join(dir, name, 'SKILL.md');
        const f = st(file);
        if (!f?.isFile() || f.size > 1024 * 1024) continue;
        mkdirSync(join(mirror, root, name), { recursive: true });
        copyFileSync(file, join(mirror, root, name, 'SKILL.md'));
      }
    }
    return installedSkills(mirror);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

async function runRollout(
  c: RunCtx,
  task: LoadedTask,
  modelId: string,
  run: number,
): Promise<RolloutOutcome> {
  const o = c.o;
  const started = c.now();
  const rawId = newRawId(started);
  const artifacts = join(c.stateDir, 'bench', 'runs', c.evaluationId, rawId);
  mkdirSync(artifacts, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'greenlight-rollout-'));
  let channelDir: string | undefined;
  const seed = seedFor(task.id, modelId, run);
  const isMaintainer = task.spec.graders.includes('maintainer');
  const sequencer = new Sequencer(() => Date.now());
  const toolEvents: ReturnType<typeof toolCallEvent>[] = [];
  let sandbox: Sandbox | undefined;
  let channel: ShimChannel | undefined;
  let result: ReactResult<Record<string, unknown>> | undefined;
  let killed = 0;
  let diff = '';
  let invalid: string | undefined;
  let pushedTree: string | undefined;
  const tree = join(artifacts, 'tree');
  const fail = (why: string) => {
    throw new Error(why);
  };
  const base = { task, modelId, run, rawId, started, seed, artifacts };
  try {
    const stage = join(scratch, 'stage');
    stageRollout({ fixtureDir: join(task.dir, 'fixture'), skillsDir: o.skillsDir, dest: stage });
    // The socket lives in a short private dir of its own: a deep TMPDIR would overflow sun_path.
    channelDir = shortSocketDir();
    const hostUid = process.getuid?.() ?? 0;
    channel = await ShimChannel.listen(join(channelDir, 'shim.sock'), {
      sequencer,
      ...(o.sandbox === 'docker' && hostUid === 0 ? { uid: c.image?.shimUid ?? shimUid(0) } : {}),
    });
    const setup = { stageDir: stage, channelDir, cliDir: o.assets.cliDir };
    sandbox =
      o.sandbox === 'docker'
        ? await createDockerSandbox(setup, {
            image: c.image ?? fail('no runner image'),
            docker: o.dockerBin,
          })
        : await createProcessSandbox(setup, { runnerDir: c.runnerDir });
    const sb = sandbox;
    // The origin as the agent finds it: every later move must be explained by a recorded command.
    const originStart = await sb.originRefs();
    const brief = readFileSync(join(task.dir, 'brief.md'), 'utf8');
    const timeoutMs =
      c.limits.timeoutMin !== null ? c.limits.timeoutMin * 60_000 : task.spec.timeoutMin * 60_000;
    const tools = agentTools(
      sb,
      (name, args) => toolEvents.push(toolCallEvent(name, args, sb.workDir, sequencer.next())),
      { readOnly: isMaintainer },
    );
    const skills = loadSkillsFor(o.skillsDir, task.spec.skills);
    const rolePrompt = isMaintainer ? maintainerPrompt() : AGENT_ROLE_PROMPT;
    const finishSpec = isMaintainer ? maintainerFinish(join(task.dir, 'fixture')) : CodingFinish;
    const maxFinishAttempts = isMaintainer ? 3 : 1;
    if (c.external) {
      // An outside agent drives the same tools through the rollout client (06 §4.9). The session
      // resolves with the ReAct loop's result shape: an accepted finish, or `step_limit` /
      // `aborted` (graded on the tree as it stands), or `deferred` when nobody claimed it.
      const wallClockMs =
        timeoutMs * (c.limits.externalTimeoutFactor ?? DEFAULT_EXTERNAL_TIMEOUT_FACTOR);
      const budget = externalBudgetNote({
        maxSteps: c.limits.maxSteps,
        wallClockMin: wallClockMs / 60_000,
        announceRemainingSteps: ANNOUNCE_REMAINING_STEPS,
      });
      result = await c.external.server.open(ROLLOUT_KEY(task.id, modelId, run), {
        system: buildSystemPrompt(skills, `${rolePrompt}\n\n${budget}`),
        brief,
        tools,
        finish: finishSpec as never,
        maxSteps: c.limits.maxSteps,
        maxFinishAttempts,
        announceRemainingSteps: ANNOUNCE_REMAINING_STEPS,
        wallClockMs,
        claimTimeoutMs: c.external.claimTimeoutMs,
        servedBy: modelId,
      });
    } else {
      const client = clientForRole(c.config, roleOf(c.config, modelId), {
        findSecrets: fixtureAwareDetector([...fixtureTexts(join(task.dir, 'fixture')), brief]),
        limiters: c.limiters,
        // No rollout ever falls back (06 §4.8): a fallback-served gate rollout is ungateable, a
        // fallback-served train rollout is evidence about another model, and either would spend
        // the other model's quota.
        allowFallback: false,
        ...(o.env ? { env: o.env } : {}),
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        retryDelaysMs: o.retryDelaysMs ?? [...ROLLOUT_RETRY_DELAYS_MS],
        ...(o.sleep ? { sleep: o.sleep } : {}),
      });
      const abort = new AbortController();
      // A plain abort surfaces as `aborted`: the agent ran out of time, and its tree is still graded.
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const perRollout = new ScopedBudget(c.limits.requestsPerRollout, c.budget);
      try {
        result = (await runReact({
          client,
          skills,
          rolePrompt: `${rolePrompt}\n\n${budgetNote(c.limits)}`,
          task: brief,
          tools,
          finish: finishSpec as never,
          maxSteps: c.limits.maxSteps,
          announceRemainingSteps: ANNOUNCE_REMAINING_STEPS,
          budget: perRollout,
          seed,
          signal: abort.signal,
          maxFinishAttempts,
        })) as ReactResult<Record<string, unknown>>;
      } finally {
        clearTimeout(timer);
      }
    }
    if (result.transcript.some((e) => e.kind === 'tool_call' && e.name === 'finish')) {
      toolEvents.push(toolCallEvent('finish', {}, sb.workDir, sequencer.next()));
    }
    // Stop EVERY process (in-flight recorders included) before anything is read out; then the
    // origin, the tree and the diff all come from one container in which nothing runs.
    killed = (await sb.finish()).killed;
    const originEnd = await sb.originRefs();
    await channel.close();
    await sb.exportTree(tree);
    // What was really pushed to the branch a loop task targets (the grader's tree check).
    if (!isMaintainer && (await sb.exportOriginBranch(TARGET_BRANCH, join(artifacts, 'pushed'))))
      pushedTree = join(artifacts, 'pushed');
    diff = treeDiff(stage, tree);
    invalid = channel.integrity(originStart, originEnd);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    c.log(`rollout ${task.id} ${modelId} run ${run}: harness error: ${message}`);
    await sandbox?.dispose();
    await channel?.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
    if (channelDir) rmSync(channelDir, { recursive: true, force: true });
    return finishRaw(c, { ...base, result, status: 'error', reason: `harness: ${message}` });
  }
  await sandbox.dispose();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(channelDir, { recursive: true, force: true });

  const trajectory = mergeTrajectory(toolEvents, channel.events);
  const trajectoryPath = join(artifacts, 'trajectory.jsonl');
  writeFileSync(trajectoryPath, toJsonl(trajectory));
  writeFileSync(join(artifacts, 'diff.patch'), diff);

  const err = result.error;
  // The per-rollout request cap ends the rollout like the step limit (its tree is graded) only
  // when the MODEL used it up, one request per turn. A cap eaten by transient retries (429/5xx:
  // more requests than turns) says nothing about the model, so that rollout is deferred and re-run
  // like any other the provider cut short; so are the invocation's cap, a day's quota and an
  // unavailable model.
  const ownCapOnly = err?.kind === 'budget_exhausted' && c.budget.remaining > 0;
  const retried = retriedRequests(result);
  const capByRetries = ownCapOnly && retried > 0;
  if (err && (!ownCapOnly || capByRetries) && DEFERRING.includes(err.kind)) {
    return finishRaw(c, {
      ...base,
      result,
      status: 'deferred',
      reason: capByRetries
        ? `budget_exhausted: ${retried} of the rollout's ${c.limits.requestsPerRollout} requests went to transient retries (429/5xx), not to the model's turns`
        : `${err.kind}: ${err.message}`,
      stop: 'deferred',
      stopAll: err.kind === 'budget_exhausted' && !capByRetries,
      killed,
      diff,
    });
  }
  if (err?.kind === 'redaction_refused') {
    return finishRaw(c, {
      ...base,
      result,
      status: 'refused',
      reason: `redaction_refused: ${err.message}`,
      stop: 'refused',
      killed,
      diff,
    });
  }
  if (err?.kind === 'model_error') {
    return finishRaw(c, {
      ...base,
      result,
      status: 'error',
      reason: `model_error: ${err.message}`,
      killed,
      diff,
    });
  }

  // The maintainer grader's eval judge (06 §4.6) runs for EVERY role, train included: one
  // structured call on the judge model, fallback off, drawing on the invocation's request cap.
  // Train and val must be graded by the same grader, or a train pass the judge would have failed
  // tells the proposer a skill works when the gate will say it does not.
  const useJudge = isMaintainer;
  const judgeUsage = { requests: 0, tokensIn: 0, tokensOut: 0 };
  const judgeState: JudgeState = {};
  const judge = useJudge ? judgeFor(c, judgeUsage, judgeState) : undefined;
  let maintainerOutputPath: string | undefined;
  if (isMaintainer && result.result) {
    maintainerOutputPath = join(artifacts, 'output.json');
    writeFileSync(maintainerOutputPath, `${JSON.stringify(result.result, null, 2)}\n`);
  }
  const grade = await gradeRollout(
    {
      taskId: task.id,
      benchDir: o.benchDir,
      tree,
      trajectoryPath,
      ...(maintainerOutputPath ? { maintainerOutputPath } : {}),
      ...(isMaintainer ? { bundleDir: join(task.dir, 'fixture') } : { pushedKnown: true }),
      ...(pushedTree ? { pushedTree } : {}),
      ...(useJudge ? { useJudge: true } : {}),
    },
    {
      gradeBundle: o.assets.gradeBundle,
      ...(judge ? { judge } : {}),
      ...(o.sandbox === 'docker' && c.image
        ? { docker: { image: c.image, ...(o.dockerBin ? { bin: o.dockerBin } : {}) } }
        : {}),
    },
  );
  writeFileSync(join(artifacts, 'grade.json'), `${JSON.stringify(grade, null, 2)}\n`);
  // The judge could not be asked (429/503 after the retries, a quota, the request cap): the
  // rollout has no verdict yet. Deferred and re-run, never sealed as a 0 or as a grader error.
  if (judgeState.outage) {
    return finishRaw(c, {
      ...base,
      result,
      status: 'deferred',
      reason: `judge unavailable: ${judgeState.outage.kind}: ${judgeState.outage.message}`,
      stop: 'deferred',
      stopAll: judgeState.outage.kind === 'budget_exhausted',
      killed,
      diff,
      judgeUsage,
    });
  }
  // A grader crash, timeout or invalid result — and an incomplete trajectory — is recorded as
  // `graderError` (score 0, which the gate treats as invalid, reason `grader-error`), never as a
  // plain failing score, and never as a pass.
  return finishRaw(c, {
    ...base,
    result,
    status: 'graded',
    killed,
    diff,
    grade,
    judgeUsage,
    ...(invalid ? { invalid } : {}),
  });
}

/** Mirrors `JUDGE_SCHEMA` in bench/graders/_lib/maintainer.mjs (the verdict the grader expects). */
export const JUDGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'boolean' }, rationale: { type: 'string' } },
  required: ['passed', 'rationale'],
};
const JudgeVerdictSchema = z.object({ passed: z.boolean(), rationale: z.string() });

/** The branch a loop task's change must reach (`develop` → beta). */
const TARGET_BRANCH = 'develop';

const DEFERRING: readonly string[] = ['deferred', 'rate_limited', 'budget_exhausted'];

/** Requests a rollout spent on retries: every request beyond one per model turn. */
function retriedRequests(r: ReactResult<unknown>): number {
  const turns = r.transcript.filter((e) => e.kind === 'model').length;
  return Math.max(0, r.requests - turns);
}

/** Set when the judge could not be asked at all (as opposed to answering badly). */
interface JudgeState {
  outage?: { kind: string; message: string };
}

function judgeFor(
  c: RunCtx,
  usage: { requests: number; tokensIn: number; tokensOut: number },
  state: JudgeState = {},
): JudgeFn {
  const o = c.o;
  const client = clientForRole(c.config, 'judge', {
    findSecrets: (t) => findSecrets(t),
    limiters: c.limiters,
    allowFallback: false,
    ...(o.env ? { env: o.env } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    retryDelaysMs: o.retryDelaysMs ?? [...ROLLOUT_RETRY_DELAYS_MS],
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  return async (prompt) => {
    const before = c.budget.used;
    try {
      const { value, call } = await client.generateStructured({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        responseSchema: JUDGE_RESPONSE_SCHEMA,
        schema: JudgeVerdictSchema,
        budget: c.budget,
      });
      usage.tokensIn += call.usage.promptTokens;
      usage.tokensOut += call.usage.candidateTokens + call.usage.thoughtTokens;
      return value;
    } catch (e) {
      const kind = judgeErrorKind(e);
      if (DEFERRING.includes(kind))
        state.outage = { kind, message: e instanceof Error ? e.message : String(e) };
      throw e;
    } finally {
      usage.requests += c.budget.used - before;
    }
  };
}

/** How a judge call failed, in the ReAct loop's terms (`deferred`, `rate_limited` and
 * `budget_exhausted` mean it was never answered). */
function judgeErrorKind(e: unknown): string {
  if (e instanceof BudgetExhaustedError) return 'budget_exhausted';
  if (e instanceof RateLimitExhaustedError) return 'rate_limited';
  if (e instanceof FallbackDisabledError) return 'deferred';
  if (e instanceof GeminiHttpError) return e.transient ? 'deferred' : 'model_error';
  return 'model_error';
}

/** The maintainer role prompt of a bench rollout: the PRODUCTION prompt (06 §2.2), with the
 * fixture as the bundle at the working directory (`wiki/index.md`, `raw/`, `context.json`). */
export function maintainerPrompt(): string {
  return `${maintainerRolePrompt('')}
The bundle is the working directory (${WORK_DIR}). Read it with read_file, list_dir and list_files
(there is nothing to write or run: your whole product is the MaintainerOutput). Submit it as the
arguments of \`finish\`; a rejected submission comes back with its errors, and you have three.`;
}

/** A per-rollout cap that also draws on the invocation's shared cap. */
class ScopedBudget extends RequestBudget {
  constructor(
    max: number,
    private readonly parent: RequestBudget,
  ) {
    super(max);
  }
  override get remaining(): number {
    return Math.min(super.remaining, this.parent.remaining);
  }
  override take(): void {
    // Own cap first, so a refused request is never counted against the invocation.
    if (super.remaining === 0) throw new BudgetExhaustedError(this.max);
    this.parent.take();
    super.take();
  }
}

interface FinishInput {
  task: LoadedTask;
  modelId: string;
  run: number;
  rawId: string;
  started: Date;
  seed: number;
  artifacts: string;
  result?: ReactResult<Record<string, unknown>>;
  status: RolloutSummary['status'];
  reason?: string;
  stop?: 'deferred' | 'refused';
  stopAll?: boolean;
  killed?: number;
  diff?: string;
  grade?: Awaited<ReturnType<typeof gradeRollout>>;
  /** The eval judge's own calls, counted into the rollout's cost (and spent on the judge model). */
  judgeUsage?: Usage;
  /** Why the rollout's evidence is incomplete (an unexplained origin move, a truncated or lost
   * shim event): the outcome then carries it as `graderError`, whatever the grader said. */
  invalid?: string;
}

function finishRaw(c: RunCtx, f: FinishInput): RolloutOutcome {
  const r = f.result;
  const durationMs = Math.max(0, c.now().getTime() - f.started.getTime());
  const own: Usage = {
    requests: r?.requests ?? 0,
    tokensIn: r?.usage.promptTokens ?? 0,
    tokensOut: (r?.usage.candidateTokens ?? 0) + (r?.usage.thoughtTokens ?? 0),
  };
  const usage = {
    requests: own.requests + (f.judgeUsage?.requests ?? 0),
    tokensIn: own.tokensIn + (f.judgeUsage?.tokensIn ?? 0),
    tokensOut: own.tokensOut + (f.judgeUsage?.tokensOut ?? 0),
  };
  const served = [...new Set((r?.servedBy ?? []).map(normalizeModelId))];
  const servedBy = served.length === 0 ? 'none' : served.join(',');
  const transcript = r ? redactDeep(r.transcript) : [];
  const transcriptText = JSON.stringify(transcript);
  writeFileSync(join(f.artifacts, 'transcript.json'), transcriptText);
  // Grading is over (or never happens for this rollout): what stays in the state dir is redacted
  // like the transcript, so no artifact of a rollout keeps a flagged value in the clear.
  redactArtifacts(f.artifacts);

  const summary: RolloutSummary = {
    task: f.task.id,
    model: f.modelId,
    run: f.run,
    rawId: f.rawId,
    status: f.status,
    requests: usage.requests,
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.killed !== undefined ? { killedProcesses: f.killed } : {}),
  };
  const usages = {
    usage: own,
    ...(f.judgeUsage && f.judgeUsage.requests > 0 ? { judgeUsage: f.judgeUsage } : {}),
  };
  // A deferred rollout is not evidence of anything: it re-runs later, so it leaves no raw record
  // (its transcript stays in the run's artifacts).
  if (f.status === 'deferred') {
    return {
      summary,
      raw: false,
      ...usages,
      stop: 'deferred',
      ...(f.stopAll ? { stopAll: true } : {}),
    };
  }

  const graderError = f.invalid
    ? f.invalid.slice(0, 2000)
    : f.grade?.verdict === 'error'
      ? (f.grade.error ?? 'grader error').slice(0, 2000)
      : undefined;
  const passed = f.grade?.verdict === 'pass' && graderError === undefined;
  // `unknown` whenever no trustworthy verdict exists: a harness error, a model error, a grader
  // error or an incomplete trajectory. Only a real pass or fail is `passed`/`failed`.
  const verdict =
    f.status === 'graded' && f.grade && graderError === undefined
      ? passed
        ? 'passed'
        : f.grade.verdict === 'fail'
          ? 'failed'
          : 'unknown'
      : 'unknown';
  const lines: string[] = [
    `bench ${f.task.id} [${f.task.spec.split}] model ${f.modelId} run ${f.run} seed ${f.seed}`,
    `sandbox ${c.progress.selection.sandbox} (imageDigest ${c.identity.harness.imageDigest}); evaluation ${c.evaluationId}`,
    `agent: ${r?.ok ? 'finished' : `ended with ${r?.error?.kind ?? 'no run'}${r?.error ? `: ${r.error.message}` : ''}`}; steps ${r?.steps ?? 0}, requests ${usage.requests}, servedBy ${servedBy}${r?.fallbackUsed ? ' (fallback)' : ''}${c.external ? ` (declared: external agent ${c.external.agent}, not verified by the harness)` : ''}`,
    `status ${f.status}${f.reason ? `: ${f.reason}` : ''}; agent processes killed before grading: ${f.killed ?? 0}`,
  ];
  if (f.invalid) lines.push(`invalid: ${f.invalid}`);
  if (f.grade) {
    lines.push(`grader: ${f.grade.verdict}${f.grade.error ? ` (${f.grade.error})` : ''}`);
    for (const ch of f.grade.checks)
      lines.push(`  ${ch.passed ? '✔' : '✘'} ${ch.name}${ch.detail ? ` — ${ch.detail}` : ''}`);
  }
  lines.push('tool calls:');
  for (const e of r?.transcript ?? []) {
    if (e.kind === 'tool_call')
      lines.push(`  [${e.step}] ${e.name} ${JSON.stringify(e.args).slice(0, 300)}`);
    if (e.kind === 'tool_result')
      lines.push(`    -> ${e.ok ? 'ok' : 'error'} ${String(e.result).slice(0, 400)}`);
  }
  // Redact before AND after truncating: cutting a line in the middle can leave a fragment that
  // looks like `key=value` only once its start is gone.
  const excerpt = truncateExcerpt(redact(truncateExcerpt(redact(lines.join('\n')))));
  const treeDir = join(f.artifacts, 'tree');
  const installed = existsSync(treeDir) ? treeSkills(treeDir) : {};
  const injected = f.task.spec.skills;
  const stamps = Object.keys(installed).length > 0 ? installed : {};
  const record: RawRecord = {
    tool: f.task.id,
    env: 'bench',
    sourceRepo: c.repo.sourceRepo,
    gitSha: c.repo.gitSha,
    dirty: c.repo.dirty,
    ...(c.repo.treeHash ? { treeHash: c.repo.treeHash } : {}),
    wrapperRev: { sha: null, verifyConfigHash: null },
    runId: c.run.runId,
    attempt: c.run.attempt,
    skills: {
      installed: stamps,
      used: r ? usedSkills(r.transcript, stamps, injected) : 'unknown',
    },
    rawId: f.rawId,
    kind: 'bench',
    passed,
    startedAt: f.started.toISOString(),
    durationMs,
    agent: {
      // The harness loop, or `external` + the declared agent id (06 §4.9): as in the identity.
      vendor: c.external ? EXTERNAL_VENDOR : HARNESS_VENDOR,
      version: c.external ? c.external.agent : HARNESS_VERSION,
      model: f.modelId,
      // The raw served-by values as the API reported them (`modelVersion`), unnormalized. For an
      // external rollout: the model label and the agent id, both DECLARED by the launcher.
      ...(r && r.servedBy.length > 0
        ? {
            servedBy: c.external
              ? `${r.servedBy.join(',')}@${c.external.agent}`
              : r.servedBy.join(','),
          }
        : {}),
    },
    bench: {
      task: f.task.id,
      split: f.task.spec.split,
      model: f.modelId,
      mode: c.progress.selection.mode,
      skillSetHash: c.identity.skillSetHash,
      evaluationId: c.evaluationId,
      run: f.run,
      seed: String(f.seed),
    },
    refs: [],
    retained: {
      verdict,
      excerpt,
      hashes: {
        excerpt: sha256(excerpt),
        transcript: sha256(transcriptText),
        ...(f.diff !== undefined ? { diff: sha256(f.diff) } : {}),
      },
      fetchedAt: c.now().toISOString(),
    },
  };
  const parsed = RawRecordSchema.parse(record);
  // Raw capture redacts (08 §5.2); it does not refuse. Anything still flagged after redaction is
  // withheld outright, and the record says where, so a detector disagreement never crashes a run
  // or discards a graded rollout.
  const flagged = flaggedLeaves(parsed);
  if (flagged.length > 0) {
    c.log(
      `raw record ${f.rawId}: withholding flagged value(s) at ${flagged.slice(0, 5).join(', ')}`,
    );
    withholdLeaves(parsed, new Set(flagged));
  }
  const text = `${JSON.stringify(parsed, null, 2)}\n`;
  const rawDir = join(c.stateDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, `${f.rawId}.json`), text);

  if (f.status !== 'graded' || !f.grade)
    return { summary, raw: true, ...usages, ...(f.stop ? { stop: f.stop } : {}) };
  if (graderError) summary.reason = `grader error: ${graderError}`;
  const failed = f.grade.checks.filter((x) => !x.passed).map((x) => x.name);
  const detail = f.invalid
    ? f.invalid.slice(0, 2000)
    : failed.length > 0
      ? `failed: ${failed.join('; ')}`.slice(0, 2000)
      : `${f.grade.checks.length} checks passed`;
  const graders = f.task.spec.graders.map((kind) => ({ kind, passed, detail }));
  const priced = c.config.roles[roleOf(c.config, f.modelId)].priceUsdPerMTok;
  const outcome: Outcome = {
    task: f.task.id,
    run: f.run,
    model: f.modelId,
    mode: c.progress.selection.mode,
    score: passed ? 1 : 0,
    graders,
    seed: String(f.seed),
    rawId: f.rawId,
    durationMs,
    servedBy,
    ...(graderError ? { graderError } : {}),
    cost: {
      usd: priced
        ? (usage.tokensIn * priced.input + usage.tokensOut * priced.output) / 1_000_000
        : 0,
      requests: usage.requests,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
    },
  };
  summary.score = outcome.score;
  return { summary, outcome, raw: true, ...usages };
}

// ---------------------------------------------------------------------------------------------

function readJson<T>(path: string, schema: z.ZodType<T>, what: string): T {
  if (!existsSync(path)) throw new PrerequisiteError(`missing ${what} at ${path}`);
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export class PrerequisiteError extends Error {}

export async function runBench(o: BenchRunOptions): Promise<RunResult> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const stateDir = o.stateDir ?? join(o.repoRoot, '.greenlight');
  const runnerDir = o.runnerDir ?? join(o.benchDir, 'runner');
  const config = readJson(join(o.benchDir, 'models.json'), ModelsConfigSchema, 'bench/models.json');
  const budgetCfg: Budget = readJson(
    join(o.benchDir, 'budget.json'),
    BudgetSchema,
    'bench/budget.json',
  );
  const gateCfg = existsSync(join(o.benchDir, 'gate.json'))
    ? (JSON.parse(readFileSync(join(o.benchDir, 'gate.json'), 'utf8')) as { runs?: number })
    : {};
  const loaded = loadTasks(o.benchDir);
  if (loaded.problems.length > 0) throw new PrerequisiteError(loaded.problems.join('\n'));
  const done = (status: RunStatus, message: string, extra: Partial<RunResult> = {}): RunResult => ({
    status,
    message,
    rollouts: [],
    requests: 0,
    ...extra,
  });

  // 1. Selection: from the progress file on resume, else from the options.
  let previous: Progress | undefined;
  if (o.resume) {
    const file = progressPath(stateDir, o.resume);
    if (!existsSync(file))
      return done('usage', `no progress for evaluation ${o.resume} at ${file}`);
    previous = ProgressSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (previous.status === 'complete')
      return done('usage', `evaluation ${o.resume} is already complete`);
    if (previous.selection.sandbox !== o.sandbox)
      return done(
        'policy-refused',
        `evaluation ${o.resume} ran in the ${previous.selection.sandbox} sandbox; resume it there`,
      );
  }
  const split: Split = previous?.selection.split ?? o.split ?? 'train';
  const role: EvalRole =
    previous?.selection.role ?? o.role ?? (split === 'train' ? 'train' : 'baseline');
  if (role === 'train' && split !== 'train')
    return done('usage', 'a train evaluation runs the train split');
  if (role !== 'train' && split === 'train')
    return done('usage', `a ${role} evaluation runs the val or test split, never train`);
  if (role === 'candidate' && !(previous?.selection.proposalId ?? o.proposalId))
    return done('usage', 'a candidate evaluation names its proposal');
  if (o.sandbox === 'process' && role !== 'train') {
    return done(
      'policy-refused',
      `the process sandbox is for local development only and cannot produce ${role} evidence (06 §4.2): use --sandbox docker`,
    );
  }
  const splitTasks = loaded.tasks.filter((t) => t.spec.split === split);
  let models: string[];
  let selected: LoadedTask[];
  let runs: number;
  try {
    models = previous?.selection.models ?? resolveModels(config, o.models);
    if (previous) {
      selected = previous.selection.tasks.map((id) => {
        const t = splitTasks.find((x) => x.id === id);
        if (!t) throw new UsageError(`task ${id} of evaluation ${o.resume} no longer exists`);
        return t;
      });
    } else {
      const res = (o.tasks ?? []).map(globToRegExp);
      selected = splitTasks.filter(
        (t) =>
          t.spec.state !== 'quarantined' && (res.length === 0 || res.some((r) => r.test(t.id))),
      );
    }
    runs = previous?.selection.runs ?? o.runs ?? (role === 'train' ? 1 : (gateCfg.runs ?? 3));
  } catch (e) {
    if (e instanceof UsageError) return done('usage', e.message);
    throw e;
  }
  if (selected.length === 0)
    return done('usage', `no ${split} task matches ${o.tasks?.join(', ') ?? '(all)'}`);
  // External rollouts (06 §4.9): decided by the selected models. One evaluation has one agent
  // (`identity.agent`), so a selection that mixes external and harness-driven models is refused.
  const extModels = models.filter((m) => isExternalModel(config, m));
  if (extModels.length > 0 && extModels.length < models.length) {
    return done(
      'usage',
      `the selected models mix external (${extModels.join(', ')}) and harness-driven (${models.filter((m) => !extModels.includes(m)).join(', ')}) ones: one evaluation has one agent (06 §4.9). Run them as separate evaluations with --models, or make both gate models external`,
    );
  }
  const external = extModels.length > 0;
  if (o.agentMode === 'external' && !external) {
    return done(
      'usage',
      `--agent-mode external needs the selected models (${models.join(', ')}) to be external in bench/models.json ({ "id": "<label>", "external": true })`,
    );
  }
  if (o.agentMode === 'harness' && external) {
    return done(
      'usage',
      `the selected models (${models.join(', ')}) are external in bench/models.json: the harness has no client for them (--agent-mode external)`,
    );
  }
  let agentId: string | undefined;
  if (external) {
    agentId =
      o.agent ??
      (previous?.identity.agent.vendor === EXTERNAL_VENDOR
        ? previous.identity.agent.version
        : undefined);
    if (!agentId) {
      return done(
        'usage',
        'external rollouts need --agent "<agent id>": who drives them (e.g. claude-code/<model>); it is recorded in the identity as declared',
      );
    }
    if (!EXTERNAL_AGENT_ID_RE.test(agentId) || findSecrets(agentId).length > 0) {
      return done(
        'usage',
        '--agent needs an id of letters, digits and . _ : @ / + - (at most 100 characters)',
      );
    }
  }
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? DEFAULT_EXTERNAL_CONCURRENCY));
  const claimTimeoutMs = o.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  // A declared skill that is missing fails the RUN, loudly and before any request: a rollout
  // without the skill under test would be graded as if the skill had been there.
  const missingSkills = selected.flatMap((t) =>
    t.spec.skills
      .filter((s) => !existsSync(join(o.skillsDir, s, 'SKILL.md')))
      .map((s) => `task ${t.id} declares skill "${s}", which is not in ${o.skillsDir}`),
  );
  if (missingSkills.length > 0) throw new PrerequisiteError(missingSkills.join('\n'));
  for (const t of selected) {
    if (!t.spec.modes.includes('isolation'))
      return done('usage', `task ${t.id} declares no isolation mode`);
  }

  // The rollout limits are part of the identity (06 §1.5). On resume an unset limit is the
  // evaluation's own, so only an explicitly different one is refused below.
  const was = previous?.identity.harness.limits;
  const maxSteps = o.maxSteps ?? was?.maxSteps ?? DEFAULT_MAX_STEPS;
  const limits: Limits = {
    maxSteps,
    requestsPerRollout:
      o.rolloutRequestCap ??
      (was && o.maxSteps === undefined ? was.requestsPerRollout : rolloutRequestCap(maxSteps)),
    timeoutMin:
      o.rolloutTimeoutMs !== undefined ? o.rolloutTimeoutMs / 60_000 : (was?.timeoutMin ?? null),
    // External rollouts only: how much longer than the task's timeout an outside agent gets.
    ...(external
      ? {
          externalTimeoutFactor:
            o.externalTimeoutFactor ??
            was?.externalTimeoutFactor ??
            DEFAULT_EXTERNAL_TIMEOUT_FACTOR,
        }
      : {}),
  };

  // 2. Identity (with the image built first, since its digest is part of it).
  let image: RunnerImage | undefined;
  if (o.sandbox === 'docker') image = ensureRunnerImage(runnerDir, { docker: o.dockerBin, log });
  const identity = computeIdentity({
    benchDir: o.benchDir,
    tasks: splitTasks.map((t) => t.spec),
    skillsDir: o.skillsDir,
    lockfile: o.assets.lockfile,
    greenlightVersion: o.assets.greenlightVersion,
    cliBuildHash: o.assets.cliBuildHash,
    imageDigest: image?.digest ?? 'process',
    // An external evaluation is never comparable with a harness-driven one, nor with one whose
    // launcher declared another agent.
    agent: agentId
      ? { vendor: EXTERNAL_VENDOR, version: agentId }
      : { vendor: HARNESS_VENDOR, version: HARNESS_VERSION },
    models,
    mode: 'isolation',
    limits,
  });
  if (previous) {
    const diff = identityDiff(previous.identity, identity);
    if (diff.length > 0) {
      const lim =
        diff.includes('harness') &&
        JSON.stringify(previous.identity.harness.limits) !== JSON.stringify(limits)
          ? ` (rollout limits ${JSON.stringify(previous.identity.harness.limits ?? null)} → ${JSON.stringify(limits)})`
          : '';
      return done(
        'policy-refused',
        `refusing to resume ${o.resume}: the baseline identity changed (${diff.join(', ')})${lim}; start a new evaluation`,
        { identity },
      );
    }
  }
  const keys = selected.flatMap((t) =>
    models.flatMap((m) => Array.from({ length: runs }, (_, i) => ROLLOUT_KEY(t.id, m, i + 1))),
  );
  if (role === 'train' && !o.force && !previous) {
    const hit = findCachedTrain(loadEvaluationRecords(o.wikiRoot), identity, keys);
    if (hit) {
      return done(
        'cached',
        `reusing train evaluation ${hit.hash}: the identity is unchanged (06 §1.5); pass --force to re-run`,
        { identity, record: hit, recordPath: join(o.wikiRoot, evalEvidencePath(hit.hash)) },
      );
    }
  }
  if (role === 'baseline' && o.reuseBaselineMaxAgeDays !== undefined && !o.force && !previous) {
    const maxMs = o.reuseBaselineMaxAgeDays * 86_400_000;
    const hit = findCachedRecord(loadEvaluationRecords(o.wikiRoot), identity, keys, 'baseline', {
      createdAfter: now().getTime() - maxMs,
      createdBefore: now().getTime(),
    });
    if (hit) {
      return done(
        'cached',
        `reusing baseline evaluation ${hit.hash}: the identity is unchanged and it is at most ${o.reuseBaselineMaxAgeDays} days old (06 §5.1)`,
        { identity, record: hit, recordPath: join(o.wikiRoot, evalEvidencePath(hit.hash)) },
      );
    }
  }

  const doneKeys = new Set(
    (previous?.outcomes as Outcome[] | undefined)?.map((x) =>
      ROLLOUT_KEY(x.task, x.model, x.run),
    ) ?? [],
  );
  const pending = keys.filter((k) => !doneKeys.has(k));

  // 3. Budget and models, before any request.
  const events = ledgerEvents(o.wikiRoot);
  // FileQuotaStore keeps `.greenlight/quota/` under its root: the state dir's parent.
  const store: QuotaStore = o.quotaStore ?? new FileQuotaStore({ root: join(stateDir, '..') });
  const limiters = createLimiters(config, { persistence: store, ...(o.throttle ?? {}) });
  for (const [id, u] of usageFromLedger(events, [...limiters.keys()], { now: now() }))
    store.raise(id, u.day, u.count);
  const rpr = o.requestsPerRollout ?? REQUESTS_PER_ROLLOUT;
  const estimate = estimateGateCost({
    tasks: selected.length,
    runs,
    models: models.length,
    modes: 1,
    requestsPerRollout: rpr,
  });
  const isMaintainerKey = (key: string) =>
    selected.find((t) => t.id === key.split('|')[0])?.spec.graders.includes('maintainer') === true;
  // The harness's only requests in an external evaluation are the eval judge's (one per
  // maintainer rollout): an external model has no quota to reserve and nothing to spend.
  const judgeCalls = pending.filter(isMaintainerKey).length;
  const pendingEstimate = {
    ...estimate,
    rollouts: pending.length,
    requests: external ? judgeCalls : Math.ceil(pending.length * rpr),
  };
  const check = checkBudget(budgetCfg, pendingEstimate, events, now());
  const refusals = [...check.refusals];
  for (const m of external ? [] : models) {
    const perModel = pending.filter((k) => k.split('|')[1] === m).length;
    const remaining = (await limiters.get(m)?.remainingToday()) ?? 0;
    const daily = checkBudget(
      budgetCfg,
      { rollouts: perModel, requests: Math.ceil(perModel * rpr), usd: 0 },
      [],
      now(),
      { dailyRequestsRemaining: remaining },
    ).refusals.filter((x) => x.code === 'daily-requests');
    refusals.push(...daily);
  }
  if (refusals.length > 0) {
    return done(
      'budget-refused',
      `refused before any request: ${refusals
        .map((r) => `${r.code} (expected ${r.expected} > ${r.limit})`)
        .join('; ')}`,
      { identity },
    );
  }
  // An external evaluation with no maintainer rollout makes no model call at all: nothing to check.
  if (!o.skipModelsCheck && !(external && judgeCalls === 0)) {
    let mc: Awaited<ReturnType<typeof checkModels>>;
    try {
      mc = await checkModels(config, o.fetchImpl, o.env ? { env: o.env } : {});
    } catch (e) {
      return done('models-unavailable', `models.list failed: ${(e as Error).message}`, {
        identity,
      });
    }
    const missing = mc.missing.filter(
      (m) => models.includes(m) || role !== 'train' || (external && judgeCalls > 0),
    );
    if (missing.length > 0) {
      return done(
        'models-unavailable',
        `models not available for generateContent: ${missing.join(', ')}`,
        {
          identity,
        },
      );
    }
  }

  // 4. Rollouts.
  const evaluationId = previous?.evaluationId ?? `eval-${newRawId(now())}`;
  const progress: Progress = previous ?? {
    v: 1,
    evaluationId,
    startedAt: now().toISOString(),
    identity,
    selection: {
      split,
      role,
      ...(o.proposalId ? { proposalId: o.proposalId } : {}),
      tasks: selected.map((t) => t.id),
      models,
      runs,
      mode: 'isolation',
      sandbox: o.sandbox,
    },
    outcomes: [],
    rawIds: [],
    problems: [],
    status: 'running',
  };
  progress.problems = [];
  const cap = Math.min(budgetCfg.perGateMaxRequests, o.maxRequests ?? Number.POSITIVE_INFINITY);
  const ti = treeIdentity(o.repoRoot);
  const ctx: RunCtx = {
    o,
    config,
    stateDir,
    runnerDir,
    image,
    identity,
    evaluationId,
    progress,
    limiters,
    budget: new RequestBudget(cap),
    limits,
    repo: { sourceRepo: sourceRepo(o.repoRoot), ...ti },
    run: runIdentity(o.env ?? process.env),
    now,
    log,
  };
  saveProgress(stateDir, progress);
  log(
    `evaluation ${evaluationId}: ${role} on ${split}, ${selected.length} task(s) × ${models.length} model(s) × ${runs} run(s), ${pending.length} pending, ${o.sandbox} sandbox; limits ${limits.maxSteps} steps / ${limits.requestsPerRollout} requests per rollout; request cap ${cap}`,
  );
  const spend = new Map<string, Usage & { rollouts: number }>();
  const charge = (model: string, u: Usage, rollouts: number) => {
    const s = spend.get(model) ?? { rollouts: 0, requests: 0, tokensIn: 0, tokensOut: 0 };
    s.rollouts += rollouts;
    s.requests += u.requests;
    s.tokensIn += u.tokensIn;
    s.tokensOut += u.tokensOut;
    spend.set(model, s);
  };
  const rollouts: RolloutSummary[] = [];
  let stop: 'refused' | undefined;
  // Per-model queues (task-major within a model); a deferred model keeps its queue for resume.
  const queue = new Map(models.map((m) => [m, pending.filter((k) => k.split('|')[1] === m)]));
  const deferred = new Map<string, string>();
  const judgeModel = entryForRole(config, 'judge').id;
  const remainingOf = async (m: string) => (await limiters.get(m)?.remainingToday()) ?? 0;
  /** What a rollout may spend, per model: its cap on its own model, +1 judge call on the judge
   * model for a maintainer rollout (every role: train is graded like val). */
  const needOf = (key: string) => {
    const [taskId, m] = key.split('|') as [string, string];
    const need = new Map([[m, limits.requestsPerRollout]]);
    const task = selected.find((t) => t.id === taskId);
    if (task?.spec.graders.includes('maintainer'))
      need.set(judgeModel, (need.get(judgeModel) ?? 0) + 1);
    return need;
  };
  let manifestPath: string | undefined;
  /** Everything a rollout's result changes, for both schedulers. */
  const settle = (key: string, m: string, r: RolloutOutcome, all: readonly string[]) => {
    rollouts.push(r.summary);
    if (r.raw) progress.rawIds.push(r.summary.rawId);
    // An external model has no requests of the harness's to account for: no spend event.
    if (!external) charge(m, r.usage, 1);
    if (r.judgeUsage) charge(judgeModel, r.judgeUsage, 0);
    if (r.stop === 'deferred') {
      // Only this model waits for another day; the key stays queued.
      if (r.stopAll) for (const x of all) deferred.set(x, r.summary.reason ?? 'deferred');
      else deferred.set(m, r.summary.reason ?? 'deferred');
    } else {
      queue.set(
        m,
        (queue.get(m) as string[]).filter((k) => k !== key),
      );
      if (r.outcome) progress.outcomes.push(r.outcome);
      else progress.problems.push({ key, kind: r.summary.status, message: r.summary.reason ?? '' });
    }
    log(
      `  ${external ? `${key}: ` : ''}${r.summary.status}${r.summary.score !== undefined ? ` score ${r.summary.score}` : ''}${r.summary.reason ? ` (${r.summary.reason})` : ''}; ${r.summary.requests} request(s); ${r.raw ? `raw ${r.summary.rawId}` : 'no raw record'}`,
    );
    saveProgress(stateDir, progress);
  };
  try {
    if (external) {
      // 4b. External rollouts (06 §4.9): up to `concurrency` sandboxes open at once, each served
      // to its outside agent through the rollout server; the manifest tells the launcher which.
      const server = await RolloutServer.start({
        dir: o.externalDir ?? mkdtempSync(join(tmpdir(), 'greenlight-rollouts-')),
        ...(o.manifest ? { manifestPath: o.manifest } : {}),
        evaluationId,
        agent: agentId as string,
        concurrency,
        claimTimeoutMs,
        now,
      });
      ctx.external = { server, agent: agentId as string, claimTimeoutMs };
      for (const key of pending) server.add(key);
      server.writeManifest();
      manifestPath = server.manifestPath;
      log(
        `external rollouts (agent ${agentId}): manifest ${server.manifestPath} — ${pending.length} rollout(s), ${concurrency} open at once; dispatch one agent per rollout whose state is "open" with: <command> prompt (claim within ${Math.round(claimTimeoutMs / 1000)} s)`,
      );
      let next = 0;
      const worker = async () => {
        for (;;) {
          const key = pending[next++];
          if (key === undefined) return;
          const [taskId, m, runStr] = key.split('|') as [string, string, string];
          const task = selected.find((t) => t.id === taskId) as LoadedTask;
          if (isMaintainerKey(key)) {
            // The eval judge is the one request of this rollout: its model's day and this
            // invocation's cap must hold it, or the rollout waits (never an unjudged grade).
            const left = await remainingOf(judgeModel);
            const short =
              left < 1
                ? `daily quota: the judge model ${judgeModel} has no request left today`
                : ctx.budget.remaining < 1
                  ? `request cap: none of this invocation's ${cap} requests left for the judge`
                  : undefined;
            if (short) {
              deferred.set(m, short);
              server.settle(key, 'deferred', short);
              continue;
            }
          }
          log(`rollout ${taskId} · ${m} · run ${runStr}: open for agent ${agentId} …`);
          let r: RolloutOutcome;
          try {
            r = await runRollout(ctx, task, m, Number(runStr));
          } catch (e) {
            const message = `harness: ${e instanceof Error ? e.message : String(e)}`;
            queue.set(
              m,
              (queue.get(m) as string[]).filter((k) => k !== key),
            );
            progress.problems.push({ key, kind: 'error', message });
            saveProgress(stateDir, progress);
            server.settle(key, 'error', message);
            log(`  ${key}: error (${message})`);
            continue;
          }
          settle(key, m, r, [m]);
          server.settle(
            key,
            r.stop === 'deferred' ? 'deferred' : r.outcome ? 'done' : 'error',
            r.outcome
              ? `graded: score ${r.outcome.score}${r.outcome.graderError ? ' (grader error)' : ''}`
              : r.summary.reason,
          );
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
      } finally {
        await server.close();
      }
    }
    while (!external) {
      const live = models.filter((m) => (queue.get(m)?.length ?? 0) > 0 && !deferred.has(m));
      if (live.length === 0) break;
      // The model with the most quota left goes next (ties: models.json order), so the models
      // interleave and neither one's day is spent while the other waits.
      const left = new Map<string, number>();
      for (const m of live) left.set(m, await remainingOf(m));
      const m = [...live].sort((a, b) => (left.get(b) ?? 0) - (left.get(a) ?? 0))[0] as string;
      const key = (queue.get(m) as string[])[0] as string;
      const need = needOf(key);
      let short: string | undefined;
      for (const [nm, n] of need) {
        const r = nm === m ? (left.get(m) ?? 0) : await remainingOf(nm);
        if (r < n)
          short = `daily quota: ${nm} has ${r} request(s) left today and a rollout may need ${n}`;
      }
      if (short) {
        deferred.set(m, short);
        log(`  ${m}: skipped for today (${short})`);
        continue;
      }
      const total = [...need.values()].reduce((a, b) => a + b, 0);
      if (ctx.budget.remaining < total) {
        for (const x of live)
          deferred.set(
            x,
            `request cap: ${ctx.budget.remaining} of this invocation's ${cap} requests left, a rollout may need ${total}`,
          );
        break;
      }
      const [taskId, , runStr] = key.split('|') as [string, string, string];
      const task = selected.find((t) => t.id === taskId) as LoadedTask;
      log(`rollout ${taskId} · ${m} · run ${runStr} (${left.get(m)} request(s) left today) …`);
      const r = await runRollout(ctx, task, m, Number(runStr));
      settle(key, m, r, live);
      if (r.stop === 'refused') {
        stop = 'refused';
        break;
      }
    }
  } finally {
    mkdirSync(o.wikiRoot, { recursive: true });
    // One spend event per model per invocation (08 §8), with the model named for quota seeding:
    // the judge's calls are charged to the judge model, not to the rollout's.
    for (const [model, s] of spend) {
      if (s.requests === 0 && s.rollouts === 0) continue;
      appendEvent(
        o.wikiRoot,
        spendEvent({ ts: now().toISOString(), usd: 0, ...s, evaluationId, model }),
      );
    }
  }
  const requests = rollouts.reduce((n, r) => n + r.requests, 0);
  const allOutcomes = progress.outcomes as Outcome[];
  const complete = keys.every((k) =>
    allOutcomes.some((x) => ROLLOUT_KEY(x.task, x.model, x.run) === k),
  );
  if (stop === 'refused') {
    progress.status = 'refused';
    saveProgress(stateDir, progress);
    return done(
      'refused',
      'a rollout was refused by the redaction guard (06 §4.8): nothing flagged was sent, and the evaluation is not sealed. Fix the fixture or capture.',
      { evaluationId, identity, rollouts, requests },
    );
  }
  const remaining = Object.fromEntries(
    [...queue].filter(([, ks]) => ks.length > 0).map(([m, ks]) => [m, [...ks]]),
  );
  if (Object.keys(remaining).length > 0) {
    progress.status = 'deferred';
    saveProgress(stateDir, progress);
    const deferredModels = Object.fromEntries(
      Object.keys(remaining).map((m) => [m, deferred.get(m) ?? 'deferred']),
    );
    const per = Object.entries(remaining)
      .map(([m, ks]) => `${m}: ${ks.length} rollout(s) left (${deferredModels[m]})`)
      .join('; ');
    return done(
      'deferred',
      `deferred after ${allOutcomes.length}/${keys.length} rollouts — ${per}; resume later with \`greenlight bench run --resume ${evaluationId}\``,
      {
        evaluationId,
        identity,
        rollouts,
        requests,
        remaining,
        deferredModels,
        ...(manifestPath ? { manifest: manifestPath } : {}),
      },
    );
  }
  if (!complete) {
    progress.status = 'incomplete';
    saveProgress(stateDir, progress);
    return done(
      'incomplete',
      `${progress.problems.length} rollout(s) produced no outcome (${progress.problems.map((p) => `${p.key}: ${p.kind}`).join('; ')}); the evaluation is not sealed — resume with --resume ${evaluationId}`,
      { evaluationId, identity, rollouts, requests },
    );
  }
  const record = sealRecord({
    identity,
    role,
    ...(progress.selection.proposalId ? { proposalId: progress.selection.proposalId } : {}),
    createdAt: now().toISOString(),
    outcomes: [...allOutcomes].sort((a, b) =>
      ROLLOUT_KEY(a.task, a.model, a.run) < ROLLOUT_KEY(b.task, b.model, b.run) ? -1 : 1,
    ),
  });
  EvaluationRecordSchema.parse(record);
  const recordPath = join(o.wikiRoot, evalEvidencePath(record.hash));
  mkdirSync(join(recordPath, '..'), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  progress.status = 'complete';
  progress.recordHash = record.hash;
  saveProgress(stateDir, progress);
  const passing = allOutcomes.filter((x) => x.score === 1).length;
  return done(
    'complete',
    `sealed ${role} evaluation ${record.hash}: ${passing}/${allOutcomes.length} rollouts passed`,
    {
      evaluationId,
      identity,
      record,
      recordPath,
      rollouts,
      requests,
      ...(manifestPath ? { manifest: manifestPath } : {}),
    },
  );
}

/** Activates pending tasks (06 §4.1): a task joins gating only once a recorded baseline covers it
 * on every gate model. Flips `"state": "pending"` to `"active"` in task.json, nothing else. */
export function activateTasks(o: {
  benchDir: string;
  wikiRoot: string;
  taskIds: readonly string[];
}): { activated: string[]; refused: { task: string; reason: string }[] } {
  const config = ModelsConfigSchema.parse(
    JSON.parse(readFileSync(join(o.benchDir, 'models.json'), 'utf8')),
  );
  const gateModels = [config.roles.frontier.id, config.roles.small.id];
  const baselines = loadEvaluationRecords(o.wikiRoot).filter((r) => r.role === 'baseline');
  const activated: string[] = [];
  const refused: { task: string; reason: string }[] = [];
  for (const id of o.taskIds) {
    const file = join(o.benchDir, 'tasks', id, 'task.json');
    if (!existsSync(file)) {
      refused.push({ task: id, reason: 'no such task' });
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const spec = JSON.parse(text) as TaskSpec;
    if (spec.state !== 'pending') {
      refused.push({ task: id, reason: `state is ${spec.state}, not pending` });
      continue;
    }
    const missing = gateModels.filter(
      (m) => !baselines.some((r) => r.outcomes.some((x) => x.task === id && x.model === m)),
    );
    if (missing.length > 0) {
      refused.push({ task: id, reason: `no recorded baseline on ${missing.join(', ')}` });
      continue;
    }
    const next = text.replace(/"state":\s*"pending"/, '"state": "active"');
    writeFileSync(file, next);
    activated.push(id);
  }
  return { activated, refused };
}
