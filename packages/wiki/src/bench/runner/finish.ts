import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type RawRecord,
  RawRecordSchema,
  findSecrets,
  redact,
  sha256,
  truncateExcerpt,
} from '@rtrentjones/greenlight-shared';
import { z } from 'zod';
import { maintainerRolePrompt } from '../../bundle';
import { FallbackDisabledError, GeminiHttpError } from '../../llm/gemini';
import { BudgetExhaustedError, RateLimitExhaustedError, RequestBudget } from '../../llm/limits';
import { clientForRole } from '../../llm/models';
import { HARNESS_VENDOR, HARNESS_VERSION, type ReactResult } from '../../llm/react';
import type { LoadedTask } from '../check-graders';
import { EXTERNAL_VENDOR } from '../external';
import type { gradeRollout } from '../grade';
import type { JudgeFn } from '../grader-api';
import { WORK_DIR } from '../sandbox';
import type { RolloutOutcome, RunCtx, Usage } from './context';
import type { Outcome } from './progress';
import { flaggedLeaves, redactArtifacts, redactDeep, withholdLeaves } from './redact';
import { normalizeModelId, roleOf } from './selection';
import { treeSkills, usedSkills } from './skills';
import { ROLLOUT_RETRY_DELAYS_MS, type RolloutSummary } from './types';

/** Mirrors `JUDGE_SCHEMA` in bench/graders/_lib/maintainer.mjs (the verdict the grader expects). */
export const JUDGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'boolean' }, rationale: { type: 'string' } },
  required: ['passed', 'rationale'],
};
const JudgeVerdictSchema = z.object({ passed: z.boolean(), rationale: z.string() });

/** The branch a loop task's change must reach (`develop` → beta). */
export const TARGET_BRANCH = 'develop';

export const DEFERRING: readonly string[] = ['deferred', 'rate_limited', 'budget_exhausted'];

/** Requests a rollout spent on retries: every request beyond one per model turn. */
export function retriedRequests(r: ReactResult<unknown>): number {
  const turns = r.transcript.filter((e) => e.kind === 'model').length;
  return Math.max(0, r.requests - turns);
}

/** Set when the judge could not be asked at all (as opposed to answering badly). */
export interface JudgeState {
  outage?: { kind: string; message: string };
}

export function judgeFor(
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
export class ScopedBudget extends RequestBudget {
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

export function finishRaw(c: RunCtx, f: FinishInput): RolloutOutcome {
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
