import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawRecord } from '@rtrentjones/greenlight-shared';
import { parse as parseYaml } from 'yaml';
import { LedgerReadError, readLedgerEvents } from '../../ledger';
import { type SplitIndex, parseSplits } from '../../sample';
import {
  type EvaluationRecord,
  type LedgerEvent,
  type ModelsConfig,
  ModelsConfigSchema,
} from '../../schema';
import type { LoadedTask } from '../check-graders';
import { depsHash, graderSetHash, splitsHash, taskSetHash } from '../identity';
import type { BlastRadius } from '../policy';
import {
  type BenchRunOptions,
  type RunResult,
  loadEvaluationRecords,
  readGateConfigFile,
  resolveModels,
  rolloutRequestCap,
  runBench,
  sealedRecordFor,
} from '../runner';
import { ensureRunnerImage } from '../sandbox';
import {
  type EvalStep,
  type IterateOptions,
  type IterateResult,
  IterationError,
  type IterationState,
  type IterationStatus,
  type IterationStep,
} from './types';

/** Skills whose PURPOSE.md, when missing, defaults to high blast radius (06 §5.4 table). */
const HIGH_RADIUS: ReadonlySet<string> = new Set([
  'deploy-verify-promote',
  'portfolio',
  'provider-cloudflare',
  'provider-github',
  'provider-hcp',
  'provider-oci',
]);

// ---- small readers ----------------------------------------------------------------------------

export function readModels(benchDir: string): ModelsConfig {
  return ModelsConfigSchema.parse(JSON.parse(readFileSync(join(benchDir, 'models.json'), 'utf8')));
}

export function readGateCfg(benchDir: string) {
  return readGateConfigFile(benchDir);
}

export function readSplits(benchDir: string): SplitIndex | undefined {
  const f = join(benchDir, 'splits.json');
  return existsSync(f) ? parseSplits(readFileSync(f, 'utf8')) : undefined;
}

export function ledgerEvents(wikiRoot: string): LedgerEvent[] {
  try {
    return readLedgerEvents(wikiRoot);
  } catch (e) {
    if (e instanceof LedgerReadError) throw new IterationError(e.message, 3);
    throw e;
  }
}

export function recordByHash(wikiRoot: string, hash: string): EvaluationRecord {
  const r = loadEvaluationRecords(wikiRoot).find((x) => x.hash === hash);
  if (!r) throw new IterationError(`evaluation record ${hash} is missing from ${wikiRoot}`, 3);
  return r;
}

function frontmatterOf(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  try {
    const v = parseYaml(m[1] as string) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const RADIUS_ORDER: readonly BlastRadius[] = ['low', 'medium', 'high'];

/**
 * A skill's blast radius (08 §2.2 `blast-radius`, 06 §5.4): the larger of the table's (high for
 * the skills it names) and the ACCEPTED skill's `PURPOSE.md` (default medium). `acceptedPurposeMd`
 * is read from the accepted skill set, never from a candidate copy and never from a create's own
 * `purpose_md`: the proposer cannot lower the thresholds its candidate is gated by. A create has
 * no accepted PURPOSE.md, so it is at least medium.
 */
export function blastRadius(skill: string, acceptedPurposeMd: string | undefined): BlastRadius {
  const r =
    acceptedPurposeMd === undefined ? undefined : frontmatterOf(acceptedPurposeMd)['blast-radius'];
  const declared: BlastRadius = r === 'low' || r === 'medium' || r === 'high' ? r : 'medium';
  const table: BlastRadius = HIGH_RADIUS.has(skill) ? 'high' : 'low';
  return RADIUS_ORDER[
    Math.max(RADIUS_ORDER.indexOf(declared), RADIUS_ORDER.indexOf(table))
  ] as BlastRadius;
}

export const readIf = (f: string): string | undefined =>
  existsSync(f) ? readFileSync(f, 'utf8') : undefined;

/** Val and test task ids from `splits.json`, plus held-out raw ids, for the bundle leak scan. */
export function heldOut(splits: SplitIndex | undefined, records: readonly RawRecord[]): string[] {
  const ids = [...(splits ?? [])].filter(([, s]) => s !== 'train').map(([id]) => id);
  for (const r of records) {
    const s = r.bench ? splits?.get(r.bench.task) : undefined;
    if (r.kind === 'bench' && s !== 'train') ids.push(r.rawId);
  }
  return ids;
}

/** A proposal id the ledger has not seen: the content id, suffixed by the iteration on reuse. */
export function uniqueProposalId(
  base: string,
  events: readonly LedgerEvent[],
  iterationId: string,
) {
  return events.some((e) => e.proposalId === base) ? `${base}-${iterationId.slice(-8)}` : base;
}

// ---- the iteration context --------------------------------------------------------------------

export interface Ctx {
  o: IterateOptions;
  s: IterationState;
  stateDir: string;
  dir: string;
  keysDir: string;
  templatesDir: string;
  config: ModelsConfig;
  splits?: SplitIndex;
  tasks: LoadedTask[];
  now: () => Date;
  log: (s: string) => void;
  save: () => void;
  /** The runner image's identity digest, resolved once (`identityExpectation`). */
  imageDigest?: string;
}

export type StepOutcome = { ok: true } | { ok: false; result: IterateResult };

export function stop(
  c: Ctx,
  step: IterationStep,
  status: Exclude<IterationStatus, 'running' | 'complete'>,
  message: string,
  exitCode: IterateResult['exitCode'],
  extra: Partial<IterateResult> = {},
): StepOutcome {
  c.s.status = status;
  c.s.step = step;
  c.s.message = message;
  c.save();
  return {
    ok: false,
    result: {
      status,
      iterationId: c.s.iterationId,
      step,
      message,
      state: c.s,
      exitCode,
      ...extra,
    },
  };
}

function runOptions(c: Ctx, over: Partial<BenchRunOptions>): BenchRunOptions {
  const o = c.o;
  const st = c.s.settings;
  return {
    repoRoot: o.repoRoot,
    benchDir: o.benchDir,
    skillsDir: o.skillsDir,
    wikiRoot: o.wikiRoot,
    stateDir: c.stateDir,
    sandbox: st.sandbox,
    assets: o.assets,
    ...(st.models ? { models: st.models } : {}),
    ...(st.maxSteps !== undefined ? { maxSteps: st.maxSteps } : {}),
    ...(st.rolloutRequestCap !== undefined ? { rolloutRequestCap: st.rolloutRequestCap } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.retryDelaysMs ? { retryDelaysMs: o.retryDelaysMs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.throttle ? { throttle: o.throttle } : {}),
    ...(o.quotaStore ? { quotaStore: o.quotaStore } : {}),
    ...(o.skipModelsCheck ? { skipModelsCheck: true } : {}),
    ...(o.rolloutTimeoutMs !== undefined ? { rolloutTimeoutMs: o.rolloutTimeoutMs } : {}),
    ...(o.dockerBin ? { dockerBin: o.dockerBin } : {}),
    // External rollouts (06 §4.9): runBench serves them from inside this process.
    ...(st.rolloutAgent ? { agent: st.rolloutAgent } : {}),
    ...(o.rolloutManifest ? { manifest: o.rolloutManifest } : {}),
    ...(o.rolloutConcurrency !== undefined ? { concurrency: o.rolloutConcurrency } : {}),
    ...(o.rolloutClaimTimeoutMs !== undefined ? { claimTimeoutMs: o.rolloutClaimTimeoutMs } : {}),
    ...(o.externalTimeoutFactor !== undefined
      ? { externalTimeoutFactor: o.externalTimeoutFactor }
      : {}),
    log: c.log,
    ...over,
  };
}

/**
 * Runs (or resumes) one evaluation for a rollout step and maps its status onto the step: sealed or
 * cached → done; deferred / incomplete → resumable, exit 1; budget or policy refusal → exit 4.
 */
/** What a step's evaluation record must be: a record found by hash or restored with the state is
 * used only when it is the record of THIS step. */
export interface RecordBinding {
  role: EvaluationRecord['role'];
  split: 'train' | 'val';
  /** The candidate's proposal; absent for train and baseline (a record naming one is refused). */
  proposalId?: string;
  /** The skill set the rollouts must have run under. */
  skillSetHash: string;
}

/** What the rest of a record's identity must be for THIS iteration (06 §1.5): the models its
 * settings resolve to in bench/models.json, the rollout limits its settings fix, isolation mode,
 * the runner's dependencies, and the sandbox image. A field left out is not checked. */
export interface IdentityExpectation {
  models?: readonly string[];
  limits?: Partial<NonNullable<EvaluationRecord['identity']['harness']['limits']>>;
  mode?: EvaluationRecord['identity']['mode'];
  depsHash?: string;
  imageDigest?: string;
}

/**
 * Why `rec` is not the record of a step bound by `b`, or null when it is: its role, proposal,
 * skill set, task split (every task of the split, as the runner's identity lists them), the
 * identity's pins over the bench inputs on disk now (task set, splits, graders), and `expect`
 * (models, limits, mode, deps, image).
 */
export function recordBindingProblem(
  rec: EvaluationRecord,
  b: RecordBinding,
  benchDir: string,
  tasks: readonly LoadedTask[],
  expect: IdentityExpectation = {},
): string | null {
  if (rec.role !== b.role) return `it is a ${rec.role} record, not ${b.role}`;
  if ((rec.proposalId ?? undefined) !== b.proposalId) {
    return `it names proposal ${rec.proposalId ?? '(none)'}, not ${b.proposalId ?? '(none)'}`;
  }
  if (rec.identity.skillSetHash !== b.skillSetHash) {
    return `it ran under skill set ${rec.identity.skillSetHash.slice(0, 12)}, not ${b.skillSetHash.slice(0, 12)}`;
  }
  const split = tasks.filter((t) => t.spec.split === b.split).map((t) => t.spec);
  const ids = split.map((t) => t.id).sort();
  const have = rec.identity.tasks.map((t) => t.id).sort();
  if (ids.join('\n') !== have.join('\n')) {
    return `its tasks are not the ${b.split} split`;
  }
  if (rec.identity.taskSetHash !== taskSetHash(benchDir, ids, rec.identity.tasks)) {
    return 'its task set is not the one on disk';
  }
  if (rec.identity.splitsHash !== splitsHash(benchDir, split)) {
    return 'its splits are not the ones on disk';
  }
  if (rec.identity.graderSetHash !== graderSetHash(benchDir, ids)) {
    return 'its graders are not the ones on disk';
  }
  const id = rec.identity;
  if (expect.models && id.models.join('\n') !== expect.models.join('\n')) {
    return `it ran models ${id.models.join(', ')}, not ${expect.models.join(', ')} (bench/models.json)`;
  }
  if (expect.mode && id.mode !== expect.mode)
    return `it ran in ${id.mode} mode, not ${expect.mode}`;
  for (const [k, v] of Object.entries(expect.limits ?? {})) {
    const have = (id.harness.limits as Record<string, unknown> | undefined)?.[k];
    if (v !== undefined && have !== v) {
      return `its rollout limit ${k} is ${JSON.stringify(have ?? null)}, not ${JSON.stringify(v)}`;
    }
  }
  if (expect.depsHash && id.depsHash !== expect.depsHash) {
    return "its runner dependencies (depsHash) are not this run's";
  }
  if (expect.imageDigest && id.harness.imageDigest !== expect.imageDigest) {
    return `it ran in image ${id.harness.imageDigest}, not ${expect.imageDigest}`;
  }
  return null;
}

/** The identity fields a reused record must carry in this run (`IdentityExpectation`). The
 * image is resolved (built if needed) once, only for the docker sandbox. */
function identityExpectation(c: Ctx): IdentityExpectation | string {
  const st = c.s.settings;
  let models: string[];
  try {
    models = resolveModels(c.config, st.models);
  } catch (e) {
    return (e as Error).message;
  }
  const limits: IdentityExpectation['limits'] = {
    ...(st.maxSteps !== undefined ? { maxSteps: st.maxSteps } : {}),
    ...(st.rolloutRequestCap !== undefined
      ? { requestsPerRollout: st.rolloutRequestCap }
      : st.maxSteps !== undefined
        ? { requestsPerRollout: rolloutRequestCap(st.maxSteps) }
        : {}),
    ...(c.o.rolloutTimeoutMs !== undefined ? { timeoutMin: c.o.rolloutTimeoutMs / 60_000 } : {}),
  };
  if (st.sandbox === 'process') c.imageDigest = 'process';
  if (c.imageDigest === undefined) {
    try {
      c.imageDigest = ensureRunnerImage(join(c.o.benchDir, 'runner'), {
        ...(c.o.dockerBin ? { docker: c.o.dockerBin } : {}),
        log: c.log,
      }).digest;
    } catch (e) {
      return `the runner image could not be resolved to check the record: ${(e as Error).message}`;
    }
  }
  return {
    models,
    limits,
    mode: 'isolation',
    depsHash: depsHash(c.o.assets),
    imageDigest: c.imageDigest,
  };
}

/** `recordBindingProblem` with this run's `identityExpectation`. */
export function bindingProblem(c: Ctx, rec: EvaluationRecord, b: RecordBinding): string | null {
  const expect = identityExpectation(c);
  if (typeof expect === 'string') return expect;
  return recordBindingProblem(rec, b, c.o.benchDir, c.tasks, expect);
}

export async function evaluation(
  c: Ctx,
  step: IterationStep,
  st: EvalStep,
  over: Partial<BenchRunOptions>,
  bind: RecordBinding,
): Promise<{ ok: true; record: EvaluationRecord } | { ok: false; out: StepOutcome }> {
  const unbound = (rec: EvaluationRecord) => {
    const why = bindingProblem(c, rec, bind);
    if (!why) return null;
    st.status = 'failed';
    st.message = `evaluation record ${rec.hash} is not this step's record: ${why}`;
    return stop(c, step, 'failed', `${step}: ${st.message}`, 4);
  };
  // A sealed evaluation is loaded, never resumed (the runner refuses to resume a complete one):
  // after a crash between the runner's seal and this state's save, or a failed decision after
  // the seal, the step continues from the record without a rollout.
  const sealed =
    (st.record
      ? loadEvaluationRecords(c.o.wikiRoot).find((r) => r.hash === st.record)
      : undefined) ??
    (st.evaluationId ? sealedRecordFor(c.stateDir, c.o.wikiRoot, st.evaluationId) : undefined);
  if (sealed) {
    const refused = unbound(sealed);
    if (refused) return { ok: false, out: refused };
    st.status = 'done';
    st.record = sealed.hash;
    st.remaining = undefined;
    c.save();
    return { ok: true, record: sealed };
  }
  const resume = st.evaluationId ? st.evaluationId : undefined;
  let r: RunResult;
  try {
    r = await runBench(
      runOptions(c, {
        ...over,
        ...(resume ? { resume } : {}),
        // Recorded as soon as the evaluation exists: a killed process must resume it, not start
        // a fresh one that discards the rollouts already graded.
        onEvaluationStarted: (id) => {
          if (st.evaluationId === id) return;
          st.evaluationId = id;
          c.save();
        },
      }),
    );
  } catch (e) {
    st.status = 'failed';
    st.message = (e as Error).message;
    return { ok: false, out: stop(c, step, 'failed', `${step}: ${st.message}`, 1) };
  }
  if (r.evaluationId) st.evaluationId = r.evaluationId;
  st.message = r.message;
  if ((r.status === 'complete' || r.status === 'cached') && r.record) {
    const refused = unbound(r.record);
    if (refused) return { ok: false, out: refused };
    st.status = 'done';
    st.record = r.record.hash;
    st.remaining = undefined;
    c.save();
    return { ok: true, record: r.record };
  }
  const msg = `${step}: ${r.message}`;
  switch (r.status) {
    case 'deferred':
      st.status = 'deferred';
      if (r.remaining) st.remaining = r.remaining;
      return {
        ok: false,
        out: stop(c, step, 'deferred', msg, 1, r.remaining ? { remaining: r.remaining } : {}),
      };
    case 'incomplete':
      st.status = 'deferred';
      return { ok: false, out: stop(c, step, 'deferred', msg, 1) };
    case 'budget-refused':
    case 'policy-refused':
      st.status = 'blocked';
      return { ok: false, out: stop(c, step, 'blocked', msg, 4) };
    case 'models-unavailable':
      st.status = 'blocked';
      return { ok: false, out: stop(c, step, 'blocked', msg, 3) };
    default:
      st.status = 'failed';
      return { ok: false, out: stop(c, step, 'failed', msg, r.status === 'usage' ? 2 : 1) };
  }
}
