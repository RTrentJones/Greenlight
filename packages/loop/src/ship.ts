import type { Adapter, DeployResult, RollbackResult } from '@rtrentjones/greenlight-adapters';
import type { DeployEnv } from '@rtrentjones/greenlight-shared';
import { type VerifyReport, allPass } from '@rtrentjones/greenlight-verify';

/**
 * `ship` — one in-process turn of the delivery loop: build → deploy → verify → react.
 *
 * This replaces the `greenlight deploy X && greenlight verify X` shell pairs that every
 * consumer workflow duplicated. Two things only an in-process composition can do:
 *  - REACT to a failed post-deploy verify: the deploy result (with the previously-live
 *    version) is still in scope, so `rollback` can restore it. Across two processes that
 *    context is gone by the time verify fails.
 *  - MEASURE the loop: every stage emits a StageEvent (stage, duration, sha, outcome) — the
 *    raw feed for push→healthy-in-prod latency, first-pass gate rate, and rollback MTTR.
 */

export type ShipStage = 'build' | 'deploy' | 'verify' | 'rollback';

export interface StageEvent {
  stage: ShipStage;
  tool: string;
  env: DeployEnv;
  /** The commit being shipped (the identity the verify gates), null when unknown. */
  gitSha: string | null;
  durationMs: number;
  passed: boolean;
  detail?: string;
  /** The deploy-verify-promote skill version driving this run, when known — lets skill-text
   * changes be A/B'd against gate outcomes. */
  skillVersion?: string;
}

export interface ShipInput {
  adapter: Adapter;
  toolDir: string;
  tool: string;
  env: DeployEnv;
  /** Run the verify harness against the deployed URL — the caller's closure (the CLI passes its
   * runVerify with failure-log attach + expectedSha + reachable wait already bound). */
  verify: (url: string) => Promise<VerifyReport[]>;
  /** Appended to the deploy URL before verifying (e.g. `/mcp` for the mcp lane). */
  connectPath?: string;
  /** The commit being shipped — stamped on every StageEvent. */
  gitSha?: string;
  /** Roll back to the previously-live version when the post-deploy verify fails (default true).
   * Only meaningful for adapters that implement `rollback`. */
  rollbackOnFailure?: boolean;
  skillVersion?: string;
  /** Called after each stage completes (event emission — logging, files, ingest POSTs). */
  onStage?: (e: StageEvent) => void | Promise<void>;
}

export interface ShipResult {
  ok: boolean;
  url?: string;
  reports: VerifyReport[];
  stages: StageEvent[];
  rollback?: RollbackResult;
}

export async function runShip(input: ShipInput): Promise<ShipResult> {
  const stages: StageEvent[] = [];
  const emit = async (
    stage: ShipStage,
    startedAt: number,
    passed: boolean,
    detail?: string,
  ): Promise<void> => {
    const event: StageEvent = {
      stage,
      tool: input.tool,
      env: input.env,
      gitSha: input.gitSha ?? null,
      durationMs: Date.now() - startedAt,
      passed,
      detail,
      skillVersion: input.skillVersion,
    };
    stages.push(event);
    await input.onStage?.(event);
  };
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let deployResult: DeployResult | undefined;
  if (input.adapter.deployStyle === 'git') {
    // The platform's git integration owns build+deploy — record the skip so the stage stream
    // stays complete, then verify the deterministic URL.
    await emit(
      'deploy',
      Date.now(),
      true,
      `skipped: ${input.adapter.target} deploys via its git integration`,
    );
  } else {
    let start = Date.now();
    try {
      await input.adapter.build(input.toolDir, input.env);
      await emit('build', start, true);
    } catch (e) {
      await emit('build', start, false, errMsg(e));
      return { ok: false, reports: [], stages };
    }
    start = Date.now();
    try {
      deployResult = await input.adapter.deploy(input.toolDir, input.env);
      await emit('deploy', start, true);
    } catch (e) {
      await emit('deploy', start, false, errMsg(e));
      return { ok: false, reports: [], stages };
    }
  }

  const baseUrl = deployResult?.url ?? input.adapter.url(input.env);
  const url = baseUrl + (input.connectPath ?? '');
  const verifyStart = Date.now();
  let reports: VerifyReport[];
  try {
    reports = await input.verify(url);
  } catch (e) {
    // A throwing harness is a failed gate, not a crashed ship — the rollback reaction still runs.
    await emit('verify', verifyStart, false, errMsg(e));
    reports = [];
  }
  const ok = reports.length > 0 && allPass(reports);
  if (reports.length > 0) {
    const failed = reports.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => c.name));
    await emit('verify', verifyStart, ok, ok ? undefined : `failed: ${failed.join(', ')}`);
  }

  let rollback: RollbackResult | undefined;
  if (!ok && input.rollbackOnFailure !== false && input.adapter.rollback) {
    const start = Date.now();
    rollback = await input.adapter.rollback(input.toolDir, input.env, deployResult?.previous);
    await emit('rollback', start, rollback.ok, rollback.detail);
  }

  return { ok, url, reports, stages, rollback };
}
