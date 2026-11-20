import { sha256 } from '@rtrentjones/greenlight-shared';
import type { RequestBudget } from '../../llm/limits';
import type { createLimiters } from '../../llm/models';
import type { BaselineIdentity, ModelsConfig } from '../../schema/bench';
import type { RolloutServer } from '../external';
import { safeGit } from '../outlets';
import type { RunnerImage } from '../sandbox';
import type { Outcome, Progress } from './progress';
import type { BenchRunOptions, RolloutSummary } from './types';

export function seedFor(task: string, model: string, run: number): number {
  return Number.parseInt(sha256(`${task}|${model}|${run}`).slice(0, 8), 16) & 0x7fffffff;
}

export function sourceRepo(repoRoot: string): string {
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

export interface RunCtx {
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

export type Limits = NonNullable<BaselineIdentity['harness']['limits']>;
export type Usage = { requests: number; tokensIn: number; tokensOut: number };

export interface RolloutOutcome {
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
