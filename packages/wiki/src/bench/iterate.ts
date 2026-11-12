import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type RawRecord, newRawId } from '@rtrentjones/greenlight-shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  type BundleContext,
  MAINTAINER_PROMPT,
  PROPOSAL_FILE,
  PROPOSER_PROMPT,
  acceptedSkillSet,
  buildMaintainerBundle,
  buildProposerBundle,
  checkProposal,
  checkProposalContent,
  listTraces,
  loadRawStore,
  openBundle,
  proposalIdOf,
  readGateInput,
  readTarget,
  recordAccess,
  skillSetHash,
  writeBundle,
} from '../bundle';
import { appendLogEntry } from '../index-gen';
import {
  appendEvent,
  appendEvents,
  proposalHistory,
  renderSkillImpact,
  withFileLock,
} from '../ledger';
import { type LintContext, introducedErrors, lint } from '../lint';
import { type GeminiClient, type Usage, clientForRole, createLimiters, entryForRole } from '../llm';
import { RequestBudget } from '../llm/limits';
import { FileQuotaStore, usageFromLedger } from '../llm/quota';
import { type ReactResult, type ReactTool, runReact } from '../llm/react';
import {
  LEDGER_FILE,
  LOG_FILE,
  SKILL_IMPACT_FILE,
  type Wiki,
  loadWiki,
  parseLedger,
  withWrites,
} from '../load';
import { applyFilePatches, applyMaintainerOutput, writeChangeset } from '../patch';
import { findSecrets, redact } from '../redact';
import { type SplitIndex, parseSplits } from '../sample';
import {
  type EvaluationRecord,
  type GateInputRecord,
  GateInputRecordSchema,
  type GateResult,
  type LedgerEvent,
  LedgerEventSchema,
  MAINTAINER_OUTPUT_JSON_SCHEMA,
  type MaintainerOutput,
  MaintainerOutputSchema,
  type ModelsConfig,
  ModelsConfigSchema,
  PROPOSER_OUTPUT_JSON_SCHEMA,
  type ProposerOutput,
  ProposerOutputSchema,
  SKILL_NAME_RE,
  evalEvidencePath,
  normalizeProposerOutput,
  sealEvent,
} from '../schema';
import { canonicalJson } from '../schema/common';
import { loadSkills } from '../skills';
import { spendEvent } from './budget';
import { type LoadedTask, loadTasks } from './check-graders';
import {
  type GateDecision,
  GateHarnessError,
  decide,
  earlyStopEvent,
  loadGateConfig,
  rejectedForReplayRegression,
} from './gate';
import { graderSetHash, hashTree, skillSetHashOf, splitsHash, taskSetHash } from './identity';
import {
  type ControlArm,
  type OutletContext,
  type OutletResult,
  type OutletTreeRef,
  cleanHead,
  evaluateOutlet as defaultEvaluateOutlet,
  loadControlArm,
} from './outlets';
import type { BlastRadius, PolicyReason, PolicyTask } from './policy';
import {
  type BenchRunOptions,
  type QuotaStore,
  type RunResult,
  type RunnerAssets,
  type SandboxKind,
  loadEvaluationRecords,
  runBench,
  sealedRecordFor,
} from './runner';
import { treeDiff } from './sandbox';

/**
 * `greenlight bench iterate` (vision 06 §1.3 steps 1–5, §10; roadmap M2-01, M2-04): one complete
 * WikiSkill iteration as a RESUMABLE STATE MACHINE. On the Gemini free tier one iteration spans
 * many days (06 §4.8: about one rollout per model per day), so every step persists its progress in
 * `.greenlight/bench/iterations/<iterationId>/state.json` before and after it acts, and a later
 * `--resume <iterationId>` continues at the first unfinished step. Steps, in order:
 *
 * 1. `train`      — training evidence under the accepted skill set: the sealed train
 *                    EvaluationRecord with this identity, else `bench run --split train` (resumed
 *                    across days).
 * 2. `maintainer` — the maintainer bundle (train records + field raw, ≤5 failing / ≤3 passing, the
 *                    incidents), the §2.2 prompt through `runReact`, `finish(MaintainerOutput)`
 *                    validated by `applyMaintainerOutput` + lint (rejections are fed back, three
 *                    submissions), applied atomically, log appended.
 * 3. `baseline`   — `bench run --split val --role baseline` under the accepted skill set (a sealed
 *                    baseline of the same identity, at most `maxBaselineAgeDays` old, is reused);
 *                    then the early stop (06 §1.3).
 * 4. `proposer`   — the proposer bundle, the §3.3 prompt with read-only tools (`read_file` over the
 *                    bundle; `wiki_read` / `wiki_traces` through the access-logged interface), and
 *                    `finish(ProposerOutput)` validated by `checkProposal` (≥4 logged raw reads).
 * 5. `evaluate`   — by outlet (06 §5.6): a skill patch is applied to a SCRATCH copy of the skill
 *                    set (never the repo's skills), `bench run --split val --role candidate` with it,
 *                    then `decide()`; every other outlet goes to `evaluateOutlet` (outlets.ts).
 * 6. `control`    — every `bench/controls/*.json` is evaluated exactly like a skill candidate and
 *                    labelled `control: true` (06 §10.2 step 4).
 * 7. `record`     — the gate input records under `wiki/evidence/eval/`, the sealed ledger events
 *                    (06 §6.1), the log entries and a re-rendered `skill-impact.md`.
 * 8. `handoff`    — `handoff.md` / `handoff.json`: a PR for skill/template outlets, an issue for
 *                    mechanism/doctor/verify, a review note for `no_action` (M2-04). The CLI never
 *                    calls GitHub here; the orchestrator posts it.
 *
 * Every step is idempotent: a rollout step stores its evaluation id and resumes it; a model call
 * stores its validated output before applying it, and applying checks what is already on disk; a
 * ledger event is appended only when its eventId is not in the ledger yet. A quota deferral (a
 * model's day is spent or it stays unavailable) persists the step as `deferred` and returns exit 1
 * with what remains. `reviewIteration` records the owner's review (06 §0 condition 4).
 */

export const ITERATION_STEPS = [
  'train',
  'maintainer',
  'baseline',
  'proposer',
  'evaluate',
  'control',
  'record',
  'handoff',
] as const;
export type IterationStep = (typeof ITERATION_STEPS)[number];

export type StepStatus = 'pending' | 'deferred' | 'blocked' | 'failed' | 'done' | 'skipped';
export type IterationStatus = 'running' | 'deferred' | 'blocked' | 'failed' | 'complete';

/** The default step caps for the two LLM roles: each needs its whole cap (steps + 2) left in the
 * model's day before it starts, so both fit one free-tier day (20 RPD) on their own. */
export const DEFAULT_AGENT_MAX_STEPS = { maintainer: 12, proposer: 16 } as const;

/** Skills whose PURPOSE.md, when missing, defaults to high blast radius (06 §5.4 table). */
const HIGH_RADIUS: ReadonlySet<string> = new Set([
  'deploy-verify-promote',
  'portfolio',
  'provider-cloudflare',
  'provider-github',
  'provider-hcp',
  'provider-oci',
]);

interface EvalStep {
  status: StepStatus;
  message?: string;
  evaluationId?: string;
  record?: string;
  remaining?: Record<string, string[]>;
}

/** What a decision needs to be shown and recorded; the sealed event is appended at `record`. */
export interface DecisionSummary {
  decision: GateDecision['decision'];
  path: GateDecision['path'];
  reasons: PolicyReason[];
  results: GateResult[];
  seed: string;
  baselineRecords: string[];
  candidateRecords: string[];
}

export interface CandidateState extends EvalStep {
  proposalId: string;
  skill: string;
  /** The decision timestamp, fixed once so a resumed decision reproduces byte for byte. */
  ts?: string;
  /** The scratch skill set the candidate rollouts ran under (inside the iteration directory). */
  candidateSkills?: string;
  candidateSkillSetHash?: string;
  radius?: BlastRadius;
  /** The decision's own status, apart from the evaluation's (`record` set = sealed): a failed
   * decision is retried from the sealed record on resume, without a rollout. */
  decisionStatus?: StepStatus;
  decision?: DecisionSummary;
  gateInput?: GateInputRecord;
  event?: LedgerEvent;
}

export interface ControlState extends CandidateState {
  /** The control file, relative to the bench directory. */
  file: string;
  controlId: string;
  proposal: ProposerOutput;
  /** The rejection the control must earn (`ControlArm.expect`). */
  expect: ControlArm['expect'];
  /** True when the decision is `rejectedForReplayRegression(decision, expect.task)`. */
  expectMet?: boolean;
  /** Val replay tasks the control was rejected for (`rejectedForReplayRegression`). */
  replayRegressions?: string[];
}

export interface IterationState {
  v: 1;
  iterationId: string;
  createdAt: string;
  updatedAt: string;
  status: IterationStatus;
  /** The step the iteration stopped at (or `handoff` when complete). */
  step: IterationStep;
  message?: string;
  /** Fixed at creation: resuming uses these, whatever the caller passes. */
  settings: {
    scope: string;
    sandbox: SandboxKind;
    models?: string[];
    runs?: number;
    maxSteps?: number;
    rolloutRequestCap?: number;
    agentMaxSteps: { maintainer: number; proposer: number };
    incidents: string[];
    /** The controls directory, relative to the bench directory. */
    controlsDir: string;
  };
  /** The accepted skill set (06 §1.5) every baseline and train record must carry. */
  acceptedSkillSetHash: string;
  /** What the iteration was created against; every resume refuses (exit 4) when one differs. */
  pins?: IterationPins;
  /** The checkout's HEAD commit at creation. scripts/evo-restore.mjs restores a wiki page the
   * iteration wrote only while the checkout's copy still equals the copy at this commit (a page
   * a human committed since is never reverted). */
  baseCommit?: string;
  notes: string[];
  train: EvalStep;
  maintainer: {
    status: StepStatus;
    message?: string;
    attempts: number;
    bundleId?: string;
    bundleDir?: string;
    /** The validated MaintainerOutput, stored before it is applied. */
    outputFile?: string;
    /** Files the output writes, with the sha256 of their content: applying is idempotent. */
    writes?: { path: string; sha256: string }[];
    applied?: boolean;
    indexCorrections?: string[];
    rawIds?: string[];
    model?: string;
  };
  baseline: EvalStep & { earlyStop?: boolean };
  proposer: {
    status: StepStatus;
    message?: string;
    attempts: number;
    bundleId?: string;
    bundleDir?: string;
    proposalId?: string;
    proposal?: ProposerOutput;
    rawReads?: string[];
    model?: string;
  };
  evaluate: {
    status: StepStatus;
    message?: string;
    kind?: 'skill' | 'outlet' | 'no-action' | 'early-stop';
    candidate?: CandidateState;
    outlet?: {
      ts: string;
      /** The trees the outlet rule judges, pinned on first entry (a resume never re-resolves a
       * moving ref such as HEAD, and refuses a different --candidate). */
      base?: PinnedTree;
      candidate?: PinnedTree;
      result?: {
        decision: OutletResult['decision'];
        reasons: string[];
        evidence: OutletResult['evidence'];
      };
    };
    event?: LedgerEvent;
  };
  control: { status: StepStatus; message?: string; items: ControlState[] };
  record: { status: StepStatus; message?: string; eventIds?: string[] };
  handoff: { status: StepStatus; message?: string; file?: string };
  review?: {
    decision: 'accept' | 'reject';
    reason: string;
    ts: string;
    eventIds: string[];
  };
  /** A review whose events are computed and saved before they are appended: a retry after a
   * crash appends the same events (same eventIds) instead of new ones. */
  reviewPending?: {
    decision: 'accept' | 'reject';
    reason: string;
    ts: string;
    events: LedgerEvent[];
  };
}

/** Hashes of the inputs an iteration's evidence depends on (06 §1.5), fixed at creation. */
export interface IterationPins {
  skillSet: string;
  models: string;
  gate: string;
  splits: string;
  tasks: string;
  /** `bench/controls/**`: the control arms and the rejections they must earn. */
  controls: string;
  /** `bench/repro/**`: the trusted repros the mechanism / doctor outlets are judged by. */
  repro: string;
}

/** An outlet tree, resolved once: `key` names what it resolved to (a commit sha, a clean HEAD). */
export interface PinnedTree {
  tree: OutletTreeRef;
  key: string;
}

export interface IterateOptions {
  repoRoot: string;
  benchDir: string;
  /** The accepted (installed) skills. Never written: candidates run from scratch copies. */
  skillsDir: string;
  wikiRoot: string;
  /** `.greenlight/` (default `<repoRoot>/.greenlight`). */
  stateDir?: string;
  /** Lane templates (`tools`), for a template proposal's paths. */
  templatesDir?: string;
  /** `all` (default) or one managed skill. */
  scope?: string;
  resume?: string;
  sandbox: SandboxKind;
  assets: RunnerAssets;
  /** Gate models (default both) and val runs (default `bench/gate.json`). */
  models?: string[];
  runs?: number;
  maxSteps?: number;
  rolloutRequestCap?: number;
  agentMaxSteps?: Partial<{ maintainer: number; proposer: number }>;
  /** Incident pages for the maintainer bundle (default: every incident page of the wiki). */
  incidents?: string[];
  /** Default `<bench>/controls`. */
  controlsDir?: string;
  /** `context.json` of the maintainer bundle (the CLI passes the installed version and cells). */
  context?: BundleContext;
  /** Lint context for the maintainer's scratch wiki (default: the framework wiki, no seam terms). */
  lint?: Pick<LintContext, 'kind' | 'seam' | 'secretValues'>;
  /** The gate (default gate.ts `decide`); injectable so a failed decision can be tested. */
  decide?: typeof decide;
  /** The non-skill outlet evaluator (default outlets.ts `evaluateOutlet`). */
  evaluateOutlet?: typeof defaultEvaluateOutlet;
  /** mechanism / doctor: the base tree (default: the checkout's HEAD commit). */
  outletBase?: OutletTreeRef;
  /** mechanism / doctor / verify: the candidate change the outlet rule judges. Without it only
   * an `invalid` verdict is taken; a decision waits for it (the step is blocked). */
  outletCandidate?: OutletTreeRef;
  /** Further OutletContext fields (artifacts, repro pin, injected prepareTree/checkAll…). */
  outletContext?: Partial<OutletContext>;
  /** Fixed id for a new iteration (tests). */
  iterationId?: string;
  /** `--adopt-pins`: a resumed state missing a pin adopts the current input (logged); without it
   * the resume is refused (exit 4). */
  adoptPins?: boolean;
  /** `--break-lock`: remove a lock written on another host (which cannot be checked here). */
  breakLock?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  throttle?: BenchRunOptions['throttle'];
  quotaStore?: QuotaStore;
  skipModelsCheck?: boolean;
  rolloutTimeoutMs?: number;
  dockerBin?: string;
  log?: (s: string) => void;
  /** Called as each step starts. */
  onStep?: (step: IterationStep) => void;
}

export interface IterateResult {
  status: IterationStatus | 'usage' | 'refused';
  iterationId?: string;
  step?: IterationStep;
  message: string;
  state?: IterationState;
  /** On a rollout deferral: the rollout keys left per model. */
  remaining?: Record<string, string[]>;
  /** 07 §0: 0 complete, 1 deferred/blocked/failed, 2 usage, 3 missing prerequisite, 4 policy. */
  exitCode: 0 | 1 | 2 | 3 | 4;
}

export class IterationError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4 = 1,
  ) {
    super(message);
    this.name = 'IterationError';
  }
}

// ---- paths and persistence --------------------------------------------------------------------

export const iterationDir = (stateDir: string, id: string): string =>
  join(stateDir, 'bench', 'iterations', id);
export const iterationStatePath = (stateDir: string, id: string): string =>
  join(iterationDir(stateDir, id), 'state.json');

const ITERATION_ID_RE = /^iter-[A-Za-z0-9._-]{1,100}$/;

const StateHeaderSchema = z
  .object({
    v: z.literal(1),
    iterationId: z.string().regex(ITERATION_ID_RE),
    status: z.enum(['running', 'deferred', 'blocked', 'failed', 'complete']),
    step: z.enum(ITERATION_STEPS),
    settings: z.object({ scope: z.string(), sandbox: z.enum(['docker', 'process']) }).passthrough(),
    acceptedSkillSetHash: z.string(),
  })
  .passthrough();

export function loadIterationState(stateDir: string, id: string): IterationState {
  if (!ITERATION_ID_RE.test(id)) throw new IterationError(`"${id}" is not an iteration id`, 2);
  const file = iterationStatePath(stateDir, id);
  if (!existsSync(file)) throw new IterationError(`no iteration ${id} at ${file}`, 2);
  const json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  StateHeaderSchema.parse(json);
  return json as IterationState;
}

function saveState(stateDir: string, s: IterationState, now: Date): void {
  s.updatedAt = now.toISOString();
  const file = iterationStatePath(stateDir, s.iterationId);
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A process's start time on this host (Linux `/proc/<pid>/stat` field 22, in clock ticks since
 * boot), or null where it cannot be read. With the pid it names one process: a reused pid has
 * another start time. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

interface LockHolder {
  host?: unknown;
  pid?: unknown;
  start?: unknown;
  token?: unknown;
}

/**
 * One process per iteration: `.lock` in the iteration directory, holding `{host, pid, start,
 * token}`. Taken atomically: the content is written to a private temp file first, then `link()`ed
 * to `.lock`, which fails if any lock exists, so no reader ever sees a half-written lock and two
 * takers can never both win.
 *
 * - A holder on this host is alive when its pid runs with the same start time (a reused pid is
 *   not the holder); a dead holder's lock is stale.
 * - A lock written on another host cannot be checked here: it is refused unless `breakLock` (the
 *   CLI's `--break-lock`) says the owner knows that run is gone.
 * - A stale or broken lock is removed compare-and-delete, under `withFileLock(<lock>.steal)`: only
 *   if `.lock` still holds exactly the content that was judged, so a lock another process has just
 *   taken is never removed. Release is compare-and-delete with the holder's own content.
 */
export function acquireLock(
  dir: string,
  log: (s: string) => void = () => {},
  o: { breakLock?: boolean } = {},
): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.lock');
  const mine = JSON.stringify({
    host: hostname(),
    pid: process.pid,
    start: processStart(process.pid),
    token: randomBytes(12).toString('hex'),
  });
  const removeIf = (content: string) =>
    withFileLock(`${file}.steal`, () => {
      let cur: string | undefined;
      try {
        cur = readFileSync(file, 'utf8');
      } catch {
        return;
      }
      if (cur === content) rmSync(file, { force: true });
    });
  for (let i = 0; i < 3; i++) {
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, mine, { flag: 'wx' });
    try {
      linkSync(tmp, file);
      return () => removeIf(mine);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // released in between
    }
    let held: LockHolder = {};
    try {
      held = text.trim().startsWith('{')
        ? (JSON.parse(text) as LockHolder)
        : { pid: Number(text.trim()) };
    } catch {
      held = {};
    }
    const pid = Number(held.pid);
    if (typeof held.host === 'string' && held.host !== hostname()) {
      if (!o.breakLock) {
        throw new IterationError(
          `iteration is locked by process ${pid} on host ${held.host} (${file}); a lock is checked only on the host that wrote it. If that run is gone, rerun with --break-lock`,
          4,
        );
      }
      log(
        `warning: breaking the lock of process ${pid} on host ${held.host} at ${file} (--break-lock)`,
      );
      removeIf(text);
      continue;
    }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        const start = typeof held.start === 'string' ? held.start : null;
        alive = start === null || processStart(pid) === null || processStart(pid) === start;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new IterationError(`iteration is running in process ${pid} (${file})`, 4);
    log(`removing the stale lock of process ${pid} at ${file}`);
    removeIf(text);
  }
  throw new IterationError(`cannot lock ${file}`, 1);
}

/** The full sha of `repoRoot`'s HEAD, or undefined outside a git checkout. */
function headCommit(repoRoot: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The pins of an iteration's inputs as they are on disk now. */
export function iterationPins(benchDir: string, skillsDir: string): IterationPins {
  return {
    skillSet: skillSetHashOf(skillsDir),
    models: hashTree(join(benchDir, 'models.json')),
    gate: hashTree(join(benchDir, 'gate.json')),
    splits: hashTree(join(benchDir, 'splits.json')),
    tasks: hashTree(join(benchDir, 'tasks')),
    controls: hashTree(join(benchDir, 'controls')),
    repro: hashTree(join(benchDir, 'repro')),
  };
}

const PIN_NAMES: Record<keyof IterationPins, string> = {
  skillSet: 'the installed skill set',
  models: 'bench/models.json',
  gate: 'bench/gate.json',
  splits: 'bench/splits.json',
  tasks: 'the bench task set (bench/tasks)',
  controls: 'the control arms (bench/controls)',
  repro: 'the trusted repros (bench/repro)',
};

/** Refuses a resume whose inputs drifted from the iteration's creation. Pins fail closed: a state
 * without pins, or missing any pin, is refused (exit 4) unless `adoptPins` (`--adopt-pins`) says
 * the owner vouches that the inputs on disk now are the ones it was created against; only the
 * missing pins are adopted, and the present ones are still compared. */
function checkPins(s: IterationState, o: IterateOptions, log: (s: string) => void): void {
  const now = iterationPins(o.benchDir, o.skillsDir);
  if (now.skillSet !== s.acceptedSkillSetHash) {
    throw new IterationError(
      `iteration ${s.iterationId} runs under the accepted skill set ${s.acceptedSkillSetHash.slice(0, 12)}, but the installed skills at ${o.skillsDir} hash to ${now.skillSet.slice(0, 12)}: restore the accepted skills, or start a new iteration`,
      4,
    );
  }
  const names = Object.keys(PIN_NAMES) as (keyof IterationPins)[];
  const held: Partial<IterationPins> = s.pins ?? {};
  const missing = names.filter((k) => typeof held[k] !== 'string' || held[k] === '');
  if (missing.length > 0) {
    if (!o.adoptPins) {
      throw new IterationError(
        `iteration ${s.iterationId} has no pin for ${missing.map((k) => PIN_NAMES[k]).join(', ')}, so its inputs cannot be shown unchanged: start a new iteration, or rerun with --adopt-pins if you vouch for the inputs on disk now`,
        4,
      );
    }
    log(
      `warning: --adopt-pins: pinning ${missing.map((k) => PIN_NAMES[k]).join(', ')} as they are on disk now`,
    );
    s.pins = { ...now, ...held } as IterationPins;
    for (const k of missing) s.pins[k] = now[k];
  }
  const pins = s.pins as IterationPins;
  const drift = (Object.keys(PIN_NAMES) as (keyof IterationPins)[]).filter(
    (k) => pins[k] !== now[k],
  );
  if (drift.length > 0) {
    throw new IterationError(
      `iteration ${s.iterationId} was created against other inputs: ${drift.map((k) => PIN_NAMES[k]).join(', ')} changed since. Restore them, or start a new iteration`,
      4,
    );
  }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The repo's skills are read-only to an iteration: nothing it writes may land in them. */
export function assertOutsideSkills(skillsDir: string, dir: string, what: string): void {
  const real = (p: string) => {
    let cur = resolve(p);
    // Resolve the nearest existing ancestor, so a not-yet-created dir is checked too.
    const tail: string[] = [];
    while (!existsSync(cur)) {
      tail.unshift(cur.slice(resolve(cur, '..').length + 1));
      const up = resolve(cur, '..');
      if (up === cur) break;
      cur = up;
    }
    return join(existsSync(cur) ? realpathSync(cur) : cur, ...tail);
  };
  if (inside(real(skillsDir), real(dir)) || inside(real(dir), real(skillsDir))) {
    throw new IterationError(
      `refusing to write ${what} at ${dir}: it overlaps the accepted skill set ${skillsDir}, which an iteration never modifies`,
      4,
    );
  }
}

// ---- small readers ----------------------------------------------------------------------------

function readModels(benchDir: string): ModelsConfig {
  return ModelsConfigSchema.parse(JSON.parse(readFileSync(join(benchDir, 'models.json'), 'utf8')));
}

function readGateCfg(benchDir: string) {
  const f = join(benchDir, 'gate.json');
  return loadGateConfig(existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
}

function readSplits(benchDir: string): SplitIndex | undefined {
  const f = join(benchDir, 'splits.json');
  return existsSync(f) ? parseSplits(readFileSync(f, 'utf8')) : undefined;
}

function ledgerEvents(wikiRoot: string): LedgerEvent[] {
  const f = join(wikiRoot, LEDGER_FILE);
  return existsSync(f) ? parseLedger(readFileSync(f, 'utf8')).events : [];
}

function recordByHash(wikiRoot: string, hash: string): EvaluationRecord {
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

const readIf = (f: string): string | undefined =>
  existsSync(f) ? readFileSync(f, 'utf8') : undefined;

/** Val and test task ids from `splits.json`, plus held-out raw ids, for the bundle leak scan. */
function heldOut(splits: SplitIndex | undefined, records: readonly RawRecord[]): string[] {
  const ids = [...(splits ?? [])].filter(([, s]) => s !== 'train').map(([id]) => id);
  for (const r of records) {
    const s = r.bench ? splits?.get(r.bench.task) : undefined;
    if (r.kind === 'bench' && s !== 'train') ids.push(r.rawId);
  }
  return ids;
}

/** A proposal id the ledger has not seen: the content id, suffixed by the iteration on reuse. */
function uniqueProposalId(base: string, events: readonly LedgerEvent[], iterationId: string) {
  return events.some((e) => e.proposalId === base) ? `${base}-${iterationId.slice(-8)}` : base;
}

// ---- the iteration context --------------------------------------------------------------------

interface Ctx {
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
}

type StepOutcome = { ok: true } | { ok: false; result: IterateResult };

function stop(
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

/**
 * Why `rec` is not the record of a step bound by `b`, or null when it is: its role, proposal,
 * skill set, task split (every task of the split, as the runner's identity lists them) and the
 * identity's pins over the bench inputs on disk now (task set, splits, graders).
 */
export function recordBindingProblem(
  rec: EvaluationRecord,
  b: RecordBinding,
  benchDir: string,
  tasks: readonly LoadedTask[],
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
  return null;
}

async function evaluation(
  c: Ctx,
  step: IterationStep,
  st: EvalStep,
  over: Partial<BenchRunOptions>,
  bind: RecordBinding,
): Promise<{ ok: true; record: EvaluationRecord } | { ok: false; out: StepOutcome }> {
  const unbound = (rec: EvaluationRecord) => {
    const why = recordBindingProblem(rec, bind, c.o.benchDir, c.tasks);
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
    r = await runBench(runOptions(c, { ...over, ...(resume ? { resume } : {}) }));
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

// ---- LLM roles (maintainer, proposer) ---------------------------------------------------------

interface RoleCall {
  client: GeminiClient;
  modelId: string;
  cap: number;
}

/** A client for `role` with the quota check of 06 §4.8: the model's day must hold the whole
 * request cap (steps + 2) before the call starts; otherwise the step waits for another day. */
async function roleClient(
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

function chargeSpend(c: Ctx, modelId: string, r: ReactResult<unknown>, label: string): void {
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
const resumable = (kind: string | undefined) =>
  kind === 'deferred' || kind === 'rate_limited' || kind === 'budget_exhausted';

/** `read_file` / `list_dir` confined to a bundle. The model addresses it as `bundle/<path>`. */
function bundleFileTools(dir: string): ReactTool[] {
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

const zodIssue = (ctx: z.RefinementCtx, message: string) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });

// ---- step 1: train ----------------------------------------------------------------------------

function trainTasks(c: Ctx): string[] | undefined {
  const scope = c.s.settings.scope;
  if (scope === 'all') return undefined;
  const ids = c.tasks
    .filter((t) => t.spec.split === 'train' && t.spec.skills.includes(scope))
    .map((t) => t.id);
  if (ids.length === 0) throw new IterationError(`no train task measures skill ${scope}`, 2);
  return ids;
}

async function stepTrain(c: Ctx): Promise<StepOutcome> {
  const r = await evaluation(
    c,
    'train',
    c.s.train,
    { split: 'train', role: 'train', tasks: trainTasks(c) },
    { role: 'train', split: 'train', skillSetHash: c.s.acceptedSkillSetHash },
  );
  if (!r.ok) return r.out;
  if (r.record.identity.skillSetHash !== c.s.acceptedSkillSetHash) {
    c.s.train.status = 'failed';
    return stop(
      c,
      'train',
      'failed',
      `train record ${r.record.hash} was produced under skill set ${r.record.identity.skillSetHash}, not the accepted ${c.s.acceptedSkillSetHash}`,
      4,
    );
  }
  return { ok: true };
}

// ---- step 2: maintainer -----------------------------------------------------------------------

interface Prepared {
  ok: boolean;
  errors: string[];
  writes: { path: string; content: string }[];
  indexCorrections: string[];
}

/** `applyMaintainerOutput` on the current wiki, then the lint findings the output introduces
 * (06 §2.4): nothing is written. */
function prepareMaintainer(c: Ctx, wiki: Wiki, output: unknown, actor: string): Prepared {
  const applied = applyMaintainerOutput(wiki, output, {
    actor,
    now: c.now(),
    lint: c.o.lint ?? { kind: 'framework' },
  });
  if (!applied.ok) return { ok: false, errors: applied.errors, writes: [], indexCorrections: [] };
  const ctx: LintContext = { ...(c.o.lint ?? { kind: 'framework' }) };
  const introduced = introducedErrors(
    lint(wiki, ctx),
    lint(withWrites(wiki, applied.changeset.writes), ctx),
  );
  if (introduced.length > 0) {
    return {
      ok: false,
      errors: introduced.map((f) => `${f.rule} ${f.page}: ${f.message}`),
      writes: [],
      indexCorrections: [],
    };
  }
  return {
    ok: true,
    errors: [],
    writes: applied.changeset.writes,
    indexCorrections: applied.indexCorrections,
  };
}

/** Applies a stored, validated output exactly once: when every file it writes already holds its
 * content, it was applied by an earlier (interrupted) invocation. */
function applyStoredMaintainer(c: Ctx): StepOutcome {
  const m = c.s.maintainer;
  const wikiRoot = c.o.wikiRoot;
  const onDisk = (m.writes ?? []).every(
    (w) =>
      existsSync(join(wikiRoot, w.path)) && sha(readIf(join(wikiRoot, w.path)) ?? '') === w.sha256,
  );
  if (!(m.writes && m.writes.length > 0 && onDisk)) {
    const output = JSON.parse(readFileSync(m.outputFile as string, 'utf8')) as unknown;
    const p = prepareMaintainer(c, loadWiki(wikiRoot), output, `maintainer:${m.model}`);
    if (!p.ok) {
      m.status = 'failed';
      m.message = `the stored maintainer output no longer applies: ${p.errors.slice(0, 3).join('; ')}`;
      return stop(c, 'maintainer', 'failed', m.message, 1);
    }
    m.writes = p.writes.map((w) => ({ path: w.path, sha256: sha(w.content) }));
    m.indexCorrections = p.indexCorrections;
    c.save();
    writeChangeset(wikiRoot, { writes: p.writes });
  }
  m.applied = true;
  m.status = 'done';
  m.message = `applied: ${(m.writes ?? []).map((w) => w.path).join(', ')}`;
  c.save();
  return { ok: true };
}

function markBundleFailed(c: Ctx, bundleId: string, why: string): void {
  const wiki = loadWiki(c.o.wikiRoot);
  const log = appendLogEntry(wiki.log, {
    ts: c.now().toISOString(),
    actor: 'harness',
    operation: `ingest failed ${bundleId}`,
    body: `maintainer bundle ${bundleId} failed after three submissions: ${why}`,
  });
  writeChangeset(c.o.wikiRoot, { writes: [{ path: LOG_FILE, content: log }] });
}

async function stepMaintainer(c: Ctx): Promise<StepOutcome> {
  const m = c.s.maintainer;
  if (m.outputFile && !m.applied) return applyStoredMaintainer(c);
  const maxSteps = c.s.settings.agentMaxSteps.maintainer;
  const call = await roleClient(c, 'maintainer', maxSteps);
  if ('short' in call) {
    m.status = 'deferred';
    m.message = call.short;
    return stop(c, 'maintainer', 'deferred', `maintainer: ${call.short}`, 1);
  }
  const o = c.o;
  const train = recordByHash(o.wikiRoot, c.s.train.record as string);
  const store = loadRawStore(join(c.stateDir, 'raw'));
  const trainIds = new Set(train.outcomes.map((x) => x.rawId));
  const records = store.records.filter((r) => trainIds.has(r.rawId) || r.kind !== 'bench');
  const missing = [...trainIds].filter((id) => !store.records.some((r) => r.rawId === id));
  if (missing.length > 0) {
    const note = `maintainer: ${missing.length} train raw record(s) of ${train.hash.slice(0, 12)} are not in ${join(c.stateDir, 'raw')}`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.log(note);
  }
  m.attempts += 1;
  const bundleId = `${c.s.iterationId}-maintainer-${m.attempts}`;
  const bundleDir = join(c.dir, 'bundles', bundleId);
  const wiki = loadWiki(o.wikiRoot);
  const bundle = buildMaintainerBundle({
    id: bundleId,
    dir: 'bundle',
    wiki,
    records,
    context: o.context ?? defaultContext(o),
    sample: { failing: 5, passing: 3 },
    ...(c.s.settings.scope !== 'all' ? { skill: c.s.settings.scope } : {}),
    incidents: c.s.settings.incidents,
    heldOutTaskIds: heldOut(c.splits, store.records),
    ...(c.splits ? { splits: c.splits } : {}),
    now: c.now(),
  });
  rmSync(bundleDir, { recursive: true, force: true });
  writeBundle(bundleDir, bundle, { keysDir: c.keysDir });
  m.bundleId = bundleId;
  m.bundleDir = relative(c.dir, bundleDir);
  m.rawIds = bundle.manifest.rawIds;
  m.model = call.modelId;
  c.save();
  const actor = `maintainer:${call.modelId}`;
  const finishSchema = MaintainerOutputSchema.superRefine((v, ctx) => {
    const p = prepareMaintainer(c, loadWiki(o.wikiRoot), v, actor);
    for (const e of p.errors) zodIssue(ctx, e);
  });
  let r: ReactResult<MaintainerOutput>;
  try {
    r = await runReact<MaintainerOutput>({
      client: call.client,
      skills: [],
      rolePrompt: MAINTAINER_PROMPT.replaceAll('{{dir}}', 'bundle'),
      task: [
        `Your maintainer bundle is mounted at bundle/ (${bundle.manifest.files.length} files, ${bundle.manifest.rawIds.length} raw record(s)${c.s.settings.incidents.length ? `, ${c.s.settings.incidents.length} incident(s)` : ''}).`,
        'Read it with read_file and list_dir. Submit your MaintainerOutput as the arguments of `finish`; a rejected submission comes back with its errors, and you have three.',
      ].join('\n'),
      tools: bundleFileTools(bundleDir),
      finish: {
        description: 'Submit the MaintainerOutput (08 §9.1) as the arguments.',
        parameters: MAINTAINER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
        schema: finishSchema as unknown as z.ZodType<MaintainerOutput>,
      },
      maxSteps,
      budget: new RequestBudget(call.cap),
      maxFinishAttempts: 3,
    });
  } finally {
    // nothing to clean: the bundle stays for the hand-off and the artifact upload
  }
  chargeSpend(c, call.modelId, r, 'maintainer');
  if (!r.ok || !r.result) {
    const kind = r.error?.kind;
    const why = `${kind}: ${r.error?.message ?? 'no output'}${r.error?.issues?.length ? ` (${r.error.issues.slice(0, 3).join('; ')})` : ''}`;
    if (resumable(kind)) {
      m.status = 'deferred';
      m.message = why;
      return stop(c, 'maintainer', 'deferred', `maintainer: ${why}`, 1);
    }
    if (kind === 'finish_invalid' || kind === 'step_limit') markBundleFailed(c, bundleId, why);
    m.status = 'failed';
    m.message = why;
    return stop(c, 'maintainer', 'failed', `maintainer: ${why}`, 1);
  }
  const outputFile = join(c.dir, 'maintainer-output.json');
  writeFileSync(outputFile, `${JSON.stringify(r.result, null, 2)}\n`);
  m.outputFile = outputFile;
  m.applied = false;
  c.save();
  return applyStoredMaintainer(c);
}

function defaultContext(o: IterateOptions): BundleContext {
  return {
    installed: o.assets.greenlightVersion,
    cells: [],
    verifyCheckIds: [],
    skills: Object.fromEntries(
      loadSkills(o.skillsDir).map((s) => [s.name, s.version ?? 'unversioned']),
    ),
  };
}

// ---- step 3: baseline -------------------------------------------------------------------------

const gateModels = (config: ModelsConfig) => ({
  frontier: config.roles.frontier.id,
  small: config.roles.small.id,
});

const policyTasks = (r: EvaluationRecord): PolicyTask[] =>
  r.identity.tasks.map((t) => ({ id: t.id, kind: t.kind, state: t.state, modes: [...t.modes] }));

async function stepBaseline(c: Ctx): Promise<StepOutcome> {
  const gateCfg = readGateCfg(c.o.benchDir);
  const r = await evaluation(
    c,
    'baseline',
    c.s.baseline,
    {
      split: 'val',
      role: 'baseline',
      ...(c.s.settings.runs !== undefined ? { runs: c.s.settings.runs } : {}),
      reuseBaselineMaxAgeDays: gateCfg.maxBaselineAgeDays,
    },
    { role: 'baseline', split: 'val', skillSetHash: c.s.acceptedSkillSetHash },
  );
  if (!r.ok) return r.out;
  const rec = r.record;
  if (rec.identity.skillSetHash !== c.s.acceptedSkillSetHash) {
    c.s.baseline.status = 'failed';
    return stop(c, 'baseline', 'failed', 'the baseline is not the accepted skill set', 4);
  }
  const active = rec.identity.tasks.filter((t) => t.state === 'active');
  if (active.length === 0) {
    const note =
      'every val task is pending or quarantined: the gate excludes them (06 §4.1), so no decision can turn on them. Activate them with `greenlight bench activate` (a re-baseline) before the gated run.';
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.log(`warning: ${note}`);
  }
  const ev = earlyStopEvent(rec, {
    ts: c.now().toISOString(),
    models: gateModels(c.config),
    tasks: policyTasks(rec),
    config: { ...gateCfg, ...(c.s.settings.runs !== undefined ? { runs: c.s.settings.runs } : {}) },
    proposalId: `early-stop-${c.s.iterationId.slice(5)}`,
    ...(c.s.settings.scope !== 'all' ? { skill: c.s.settings.scope } : {}),
  });
  if (ev && active.length > 0) {
    c.s.baseline.earlyStop = true;
    c.s.proposer.status = 'skipped';
    c.s.proposer.message = 'early stop: the baseline already passes everything (06 §1.3)';
    c.s.evaluate.kind = 'early-stop';
    c.s.evaluate.event = ev;
    c.s.evaluate.status = 'done';
  }
  return { ok: true };
}

// ---- step 4: proposer -------------------------------------------------------------------------

function proposerTools(c: Ctx, bundleDir: string): ReactTool[] {
  const o = c.o;
  const bundle = openBundle(bundleDir, c.keysDir);
  const records = () => loadRawStore(join(c.stateDir, 'raw')).records;
  const files = bundleFileTools(bundleDir).filter((t) => t.name === 'read_file');
  return [
    ...files,
    {
      name: 'wiki_read',
      description:
        '`greenlight wiki read <ref>`: a wiki page id, raw:<rawId> (an execution trace) or skill:<name> (SKILL.md and PURPOSE.md). Every read is logged.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
      run: (a) => {
        const ref = String(a.ref ?? '');
        const result = readTarget(ref, 'proposer', {
          wiki: loadWiki(o.wikiRoot),
          records: ref.startsWith('raw:') ? records() : [],
          skillsDir: o.skillsDir,
          ...(c.splits ? { splits: c.splits } : {}),
        });
        recordAccess(bundle, {
          ts: c.now().toISOString(),
          command: 'read',
          target: ref,
          ...(result.ok ? {} : { refused: result.message }),
        });
        if (!result.ok) throw new Error(result.message);
        return result.text;
      },
    },
    {
      name: 'wiki_traces',
      description:
        '`greenlight wiki traces`: raw ids of execution traces you may read, newest first (field and training records only).',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          failed: { type: 'boolean' },
          passing: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
      run: (a) => {
        const limit =
          Number.isInteger(a.limit) && (a.limit as number) > 0 ? (a.limit as number) : 20;
        const rows = listTraces(records(), {
          ...(typeof a.skill === 'string' && a.skill ? { skill: a.skill } : {}),
          failed: a.failed === true,
          passing: a.passing === true,
          limit,
          ...(c.splits ? { splits: c.splits } : {}),
        });
        const args = [
          ...(typeof a.skill === 'string' && a.skill ? ['--skill', a.skill] : []),
          ...(a.failed === true ? ['--failed'] : []),
          ...(a.passing === true ? ['--passing'] : []),
          '--limit',
          String(limit),
        ];
        recordAccess(bundle, {
          ts: c.now().toISOString(),
          command: 'traces',
          target: args.join(' '),
        });
        return rows
          .map(
            (r) =>
              `${r.rawId}  ${r.tool}  ${r.kind}${r.bench ? ` ${r.bench.task}` : ''}  ${r.passed ? 'passed' : 'failed'}  ${r.startedAt}`,
          )
          .join('\n');
      },
    },
  ];
}

/** Lint LR-11/LR-12 on a candidate skill set: only findings the change introduces count. */
function skillLintErrors(c: Ctx, candidateSkills: string): string[] {
  const wiki = loadWiki(c.o.wikiRoot);
  const ctx = (dir: string): LintContext => ({ kind: 'framework', skills: loadSkills(dir) });
  return introducedErrors(lint(wiki, ctx(c.o.skillsDir)), lint(wiki, ctx(candidateSkills)))
    .filter((f) => f.rule === 'LR-11' || f.rule === 'LR-12')
    .map((f) => `${f.rule} ${f.page}: ${f.message}`);
}

async function stepProposer(c: Ctx): Promise<StepOutcome> {
  const p = c.s.proposer;
  const o = c.o;
  const maxSteps = c.s.settings.agentMaxSteps.proposer;
  const call = await roleClient(c, 'proposer', maxSteps);
  if ('short' in call) {
    p.status = 'deferred';
    p.message = call.short;
    return stop(c, 'proposer', 'deferred', `proposer: ${call.short}`, 1);
  }
  const store = loadRawStore(join(c.stateDir, 'raw'));
  const wiki = loadWiki(o.wikiRoot);
  const managed = loadSkills(o.skillsDir).map((s) => s.name);
  const scope = c.s.settings.scope;
  p.attempts += 1;
  const bundleId = `${c.s.iterationId}-proposer-${p.attempts}`;
  const bundleDir = join(c.dir, 'bundles', bundleId);
  const bundle = buildProposerBundle({
    id: bundleId,
    dir: 'bundle',
    wiki,
    records: store.records,
    skills: scope === 'all' ? managed : [scope],
    ...(scope !== 'all' ? { skill: scope } : {}),
    heldOutTaskIds: heldOut(c.splits, store.records),
    ...(c.splits ? { splits: c.splits } : {}),
    acceptedSkillSetHash: c.s.acceptedSkillSetHash,
    now: c.now(),
  });
  rmSync(bundleDir, { recursive: true, force: true });
  writeBundle(bundleDir, bundle, { keysDir: c.keysDir });
  p.bundleId = bundleId;
  p.bundleDir = relative(c.dir, bundleDir);
  p.model = call.modelId;
  c.save();

  let checkedId: string | undefined;
  const finishSchema = z
    .preprocess(normalizeProposerOutput, ProposerOutputSchema)
    .superRefine((v, ctx) => {
      const checked = checkProposal({
        output: v,
        bundleDir,
        wiki: loadWiki(o.wikiRoot),
        skillsDir: o.skillsDir,
        templatesDir: c.templatesDir,
        keysDir: c.keysDir,
        records: loadRawStore(join(c.stateDir, 'raw')).records,
        ...(c.splits ? { splits: c.splits } : {}),
        scope,
      });
      if (!checked.ok) {
        for (const e of checked.errors) zodIssue(ctx, e);
        return;
      }
      const errors: string[] = [];
      if (v.action === 'create' || (v.action === 'patch' && v.outlet === 'skill')) {
        // 06 §3.4: the change is applied to a scratch skill set and linted before any rollout.
        const scratch = join(c.dir, 'candidates', '.lint');
        const made = materializeCandidate(o.skillsDir, v, scratch);
        errors.push(...(made.ok ? skillLintErrors(c, scratch) : made.errors));
        rmSync(scratch, { recursive: true, force: true });
      }
      for (const e of errors) zodIssue(ctx, e);
      if (errors.length === 0) checkedId = checked.proposalId;
    });
  const r = await runReact<ProposerOutput>({
    client: call.client,
    skills: [],
    rolePrompt: PROPOSER_PROMPT.replaceAll('{{dir}}', 'bundle'),
    task: [
      'Your proposer bundle is mounted at bundle/ (index.md, skill-impact.md, outcomes.md).',
      'The read-only commands are tools: `wiki_read` is `greenlight wiki read <ref>` and `wiki_traces` is `greenlight wiki traces`; read_file reads the bundle.',
      'Submit your ProposerOutput as the arguments of `finish`; a rejected submission comes back with its errors, and you have three.',
    ].join('\n'),
    tools: proposerTools(c, bundleDir),
    finish: {
      description: 'Submit the ProposerOutput (08 §9.2) as the arguments.',
      parameters: PROPOSER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      schema: finishSchema as unknown as z.ZodType<ProposerOutput>,
    },
    maxSteps,
    budget: new RequestBudget(call.cap),
    maxFinishAttempts: 3,
  });
  chargeSpend(c, call.modelId, r, 'proposer');
  if (!r.ok || !r.result || !checkedId) {
    const kind = r.error?.kind;
    const why = `${kind}: ${r.error?.message ?? 'no output'}${r.error?.issues?.length ? ` (${r.error.issues.slice(0, 3).join('; ')})` : ''}`;
    p.status = resumable(kind) ? 'deferred' : 'failed';
    p.message = why;
    return stop(
      c,
      'proposer',
      p.status === 'deferred' ? 'deferred' : 'failed',
      `proposer: ${why}`,
      1,
    );
  }
  const proposal = r.result;
  const proposalId = uniqueProposalId(checkedId, ledgerEvents(o.wikiRoot), c.s.iterationId);
  const record = {
    proposalId,
    bundle: bundleId,
    validatedAt: c.now().toISOString(),
    output: proposal,
  };
  writeFileSync(join(bundleDir, PROPOSAL_FILE), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(c.dir, 'proposal.json'), `${JSON.stringify(record, null, 2)}\n`);
  p.proposal = proposal;
  p.proposalId = proposalId;
  // Distinct reads, as checkProposal counts them (a re-read of one trace is one read).
  p.rawReads = [
    ...new Set(
      readFileSync(join(bundleDir, 'access.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { command: string; target: string; refused?: string })
        .filter((e) => e.command === 'read' && !e.refused && e.target.startsWith('raw:'))
        .map((e) => e.target),
    ),
  ];
  p.status = 'done';
  p.message = `${proposal.action}${'outlet' in proposal ? ` (${proposal.outlet})` : ''}: ${proposalId}`;
  if (proposal.action === 'no_action') {
    c.s.evaluate.kind = 'no-action';
    c.s.evaluate.event = sealEvent({
      ts: c.now().toISOString(),
      proposalId,
      stage: 'no-action',
      ...(scope !== 'all' ? { skill: scope } : {}),
      change: { kind: 'no_action' },
      reason: proposal.reason,
    });
    c.s.evaluate.status = 'done';
  }
  c.save();
  return { ok: true };
}

// ---- step 5/6: candidate evaluation -----------------------------------------------------------

/**
 * Copies the accepted skill set to `dest` and applies a skill proposal there. `dest` is created
 * fresh; the source is never written.
 */
export function materializeCandidate(
  skillsDir: string,
  p: ProposerOutput,
  dest: string,
): { ok: true } | { ok: false; errors: string[] } {
  assertOutsideSkills(skillsDir, dest, 'a candidate skill set');
  if (p.action !== 'create' && !(p.action === 'patch' && p.outlet === 'skill')) {
    return { ok: false, errors: [`a ${p.action} proposal has no skill set to build`] };
  }
  // One canonical path segment: a name never addresses another skill (`a/../b`, `b/`).
  if (!SKILL_NAME_RE.test(p.name)) {
    return { ok: false, errors: [`"${p.name}" is not a canonical skill name`] };
  }
  if (p.action === 'patch' && !loadSkills(skillsDir).some((s) => s.name === p.name)) {
    return { ok: false, errors: [`skill ${p.name} is not an accepted skill`] };
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, '..'), { recursive: true });
  cpSync(skillsDir, dest, { recursive: true });
  if (p.action === 'create') {
    const dir = join(dest, p.name);
    if (existsSync(dir)) return { ok: false, errors: [`skill ${p.name} already exists`] };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), p.skill_md);
    writeFileSync(join(dir, 'PURPOSE.md'), p.purpose_md);
    return { ok: true };
  }
  const root = join(dest, p.name);
  if (!existsSync(root)) return { ok: false, errors: [`skill ${p.name} does not exist`] };
  const applied = applyFilePatches(root, p.edits);
  if (!applied.ok) return { ok: false, errors: applied.errors };
  writeChangeset(root, applied.changeset);
  return { ok: true };
}

const skillOf = (p: ProposerOutput): string =>
  p.action === 'create' || p.action === 'patch' ? p.name : '';

function skillLines(dir: string, skill: string): number {
  const t = readIf(join(dir, skill, 'SKILL.md'));
  return t === undefined ? 0 : t.split('\n').length;
}

/** Runs (or resumes) the candidate rollouts of one skill candidate, then decides it. */
async function evaluateCandidate(
  c: Ctx,
  step: 'evaluate' | 'control',
  cand: CandidateState,
  proposal: ProposerOutput,
  meta: { control: boolean; pattern?: string[] },
): Promise<StepOutcome> {
  const o = c.o;
  cand.ts ??= c.now().toISOString();
  // A candidate directory on disk (restored with the state, or left by an earlier run) is never
  // trusted: the skill set is rebuilt from the accepted skills and the proposal on every entry,
  // and a rebuilt hash that differs from the stored one refuses the step (exit 4).
  const dest = join(c.dir, 'candidates', cand.proposalId, 'skills');
  const made = materializeCandidate(o.skillsDir, proposal, dest);
  if (!made.ok) {
    cand.status = 'failed';
    cand.message = made.errors.join('; ');
    return stop(c, step, 'failed', `${step}: ${cand.message}`, 1);
  }
  cand.candidateSkills = relative(c.dir, dest);
  const hash = skillSetHashOf(dest);
  if (cand.candidateSkillSetHash && cand.candidateSkillSetHash !== hash) {
    cand.status = 'failed';
    cand.message = `the candidate skill set rebuilt from the proposal hashes to ${hash.slice(0, 12)}, not the stored ${cand.candidateSkillSetHash.slice(0, 12)}`;
    return stop(c, step, 'failed', `${step}: ${cand.message}`, 4);
  }
  cand.candidateSkillSetHash = hash;
  const skill = skillOf(proposal);
  // 06 §5.4: from the ACCEPTED tree (pinned by the iteration's drift check) or the table, never
  // the candidate's copy, and never a create's own purpose_md. Recomputed on every entry.
  cand.radius = blastRadius(
    skill,
    proposal.action === 'patch' ? readIf(join(o.skillsDir, skill, 'PURPOSE.md')) : undefined,
  );
  c.save();
  const r = await evaluation(
    c,
    step,
    cand,
    {
      split: 'val',
      role: 'candidate',
      proposalId: cand.proposalId,
      skillsDir: dest,
      ...(c.s.settings.runs !== undefined ? { runs: c.s.settings.runs } : {}),
    },
    { role: 'candidate', split: 'val', proposalId: cand.proposalId, skillSetHash: hash },
  );
  if (!r.ok) return r.out;
  const baseline = recordByHash(o.wikiRoot, c.s.baseline.record as string);
  const baseWhy = recordBindingProblem(
    baseline,
    { role: 'baseline', split: 'val', skillSetHash: c.s.acceptedSkillSetHash },
    o.benchDir,
    c.tasks,
  );
  if (baseWhy) {
    cand.status = 'failed';
    cand.message = `the baseline record ${baseline.hash} is not this iteration's: ${baseWhy}`;
    return stop(c, step, 'failed', `${step}: ${cand.message}`, 4);
  }
  const gateCfg = readGateCfg(o.benchDir);
  let d: GateDecision;
  try {
    d = (o.decide ?? decide)(baseline, r.record, {
      ts: cand.ts,
      radius: cand.radius,
      path: 'standard',
      models: gateModels(c.config),
      tasks: policyTasks(baseline),
      acceptedSkillSetHash: c.s.acceptedSkillSetHash,
      // The M1/M2 posture (06 §5.1): isolation only, declared explicitly.
      modes: ['isolation'],
      config: {
        ...gateCfg,
        ...(c.s.settings.runs !== undefined ? { runs: c.s.settings.runs } : {}),
      },
      skillLines: { before: skillLines(o.skillsDir, skill), after: skillLines(dest, skill) },
      skill,
      ...(meta.pattern ? { pattern: meta.pattern } : {}),
      outlet: 'skill',
      ...(meta.control ? { control: true } : {}),
    });
  } catch (e) {
    cand.status = 'failed';
    cand.decisionStatus = 'failed';
    cand.message = (e as Error).message;
    const what = e instanceof GateHarnessError ? 'harness error' : 'gate error';
    return stop(c, step, 'failed', `${step}: ${what}: ${cand.message}`, 1);
  }
  cand.decision = {
    decision: d.decision,
    path: d.path,
    reasons: d.reasons,
    results: d.results,
    seed: d.seed,
    baselineRecords: d.baselineRecords,
    candidateRecords: d.candidateRecords,
  };
  if (d.decision === 'invalid' || !d.ledgerEvent || !d.gateInput) {
    cand.status = 'failed';
    cand.decisionStatus = 'failed';
    cand.message = `the evaluation is invalid: ${d.reasons
      .filter((x) => x.severity === 'invalid')
      .map((x) => x.code)
      .join(', ')}`;
    return stop(c, step, 'failed', `${step}: ${cand.message}`, 1);
  }
  cand.gateInput = d.gateInput;
  cand.event = d.ledgerEvent;
  cand.decisionStatus = 'done';
  cand.status = 'done';
  cand.message = `${d.ledgerEvent.stage}: ${d.ledgerEvent.reason ?? d.decision}`;
  c.save();
  return { ok: true };
}

/**
 * Why the proposal stored in the state may not be evaluated, or null. The state may have been
 * restored on another runner, so its proposal is re-checked as the proposer step checked it (all
 * but the bundle's access log, whose keys are per runner) and its id must be the content id.
 */
function storedProposalProblem(
  c: Ctx,
  proposal: ProposerOutput,
  proposalId: string,
): string | null {
  const checked = checkProposalContent({
    output: proposal,
    wiki: loadWiki(c.o.wikiRoot),
    skillsDir: c.o.skillsDir,
    templatesDir: c.templatesDir,
    scope: c.s.settings.scope,
  });
  if (!checked.ok) return `the stored proposal fails its checks: ${checked.errors.join('; ')}`;
  const id = checked.proposalId;
  if (proposalId !== id && proposalId !== `${id}-${c.s.iterationId.slice(-8)}`) {
    return `the stored proposal id ${proposalId} is not its content id ${id}`;
  }
  return null;
}

async function stepEvaluate(c: Ctx): Promise<StepOutcome> {
  const e = c.s.evaluate;
  const p = c.s.proposer;
  if (e.kind === 'early-stop' || e.kind === 'no-action') return { ok: true };
  const proposal = p.proposal as ProposerOutput;
  const proposalId = p.proposalId as string;
  const why = storedProposalProblem(c, proposal, proposalId);
  if (why) {
    e.status = 'failed';
    e.message = why;
    return stop(c, 'evaluate', 'failed', `evaluate: ${why}`, 4);
  }
  if (
    proposal.action === 'create' ||
    (proposal.action === 'patch' && proposal.outlet === 'skill')
  ) {
    e.kind = 'skill';
    e.candidate ??= { status: 'pending', proposalId, skill: proposal.name };
    const out = await evaluateCandidate(c, 'evaluate', e.candidate, proposal, {
      control: false,
      pattern: proposal.patterns,
    });
    if (!out.ok) {
      e.status = e.candidate.status;
      return out;
    }
    e.event = e.candidate.event;
    return { ok: true };
  }
  if (proposal.action === 'no_action') return { ok: true };
  // mechanism / doctor / verify (issue) and template (patch): outlets.ts (06 §5.6).
  e.kind = 'outlet';
  e.outlet ??= { ts: c.now().toISOString() };
  const sourceRepo = c.o.outletContext?.sourceRepo ?? 'RTrentJones/greenlight';
  // The trees are pinned on first entry: a resume never re-resolves HEAD, and a --candidate (or
  // base) other than the pinned one is refused rather than silently judged.
  const wantBase = c.o.outletBase ? pinTree(c.o.repoRoot, c.o.outletBase, sourceRepo) : undefined;
  if (e.outlet.base && wantBase && wantBase.key !== e.outlet.base.key) {
    return stop(
      c,
      'evaluate',
      'blocked',
      `evaluate: the outlet base is pinned to ${e.outlet.base.key}; refusing ${wantBase.key}`,
      4,
    );
  }
  e.outlet.base ??= wantBase ?? pinTree(c.o.repoRoot, { commit: 'HEAD' }, sourceRepo);
  if (c.o.outletCandidate) {
    const want = pinTree(c.o.repoRoot, c.o.outletCandidate, sourceRepo);
    if (e.outlet.candidate && want.key !== e.outlet.candidate.key) {
      return stop(
        c,
        'evaluate',
        'blocked',
        `evaluate: the candidate is pinned to ${e.outlet.candidate.key}; refusing --candidate ${want.key}`,
        4,
      );
    }
    e.outlet.candidate ??= want;
  }
  c.save();
  const evaluate = c.o.evaluateOutlet ?? defaultEvaluateOutlet;
  const base: OutletTreeRef = e.outlet.base.tree;
  const candidate = e.outlet.candidate?.tree;
  const fixedTs = e.outlet.ts;
  let result: OutletResult;
  try {
    result = await evaluate(proposal as never, {
      // Caller-supplied fields first: the pinned trees, the id and the clock always win.
      ...(c.o.outletContext ?? {}),
      repoRoot: c.o.repoRoot,
      proposalId,
      base,
      // Without a named candidate change the trees are equal: only an `invalid` verdict (no
      // reviewed repro, no artifacts) can be taken from that run; a decision needs the candidate.
      candidate: candidate ?? base,
      tasks: c.tasks.map((t) => t.spec),
      now: () => new Date(fixedTs),
    });
  } catch (err) {
    e.status = 'failed';
    e.message = (err as Error).message;
    return stop(c, 'evaluate', 'failed', `evaluate (${proposal.outlet}): ${e.message}`, 1);
  }
  const reasons = result.reasons.map((r) => `${r.code}${r.detail ? ` (${r.detail})` : ''}`);
  if (result.decision !== 'invalid' && !candidate) {
    e.status = 'blocked';
    e.message = `the ${proposal.outlet} rule needs the candidate change: resume with --candidate <commit|dir> once it exists`;
    return stop(c, 'evaluate', 'blocked', `evaluate: ${e.message}`, 1);
  }
  e.outlet.result = { decision: result.decision, reasons, evidence: result.evidence };
  if (result.decision === 'invalid' || !result.ledgerEvent) {
    // 06 §4.8 / outlets.ts: an invalid evaluation never reaches the ledger. The iteration records
    // it as a no-ledger outcome in the hand-off, never as a rejection.
    e.message = `invalid, no ledger event: ${reasons.join('; ')}`;
    const note = `the ${proposal.outlet} proposal ${proposalId} could not be evaluated (${reasons.join('; ')}); it has no ledger row`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.save();
    return { ok: true };
  }
  const valid = LedgerEventSchema.safeParse(result.ledgerEvent);
  if (!valid.success || result.ledgerEvent.proposalId !== proposalId) {
    e.status = 'failed';
    e.message = 'the outlet evaluator returned an invalid ledger event';
    return stop(c, 'evaluate', 'failed', `evaluate: ${e.message}`, 1);
  }
  e.event = result.ledgerEvent;
  return { ok: true };
}

/**
 * Resolves an outlet tree once. A commit becomes its full sha. A directory is pinned to its clean
 * HEAD (named as a `commit:` ref, which outlets.ts re-checks against the directory); a dirty one
 * keeps no ref and is judged `unpinned-tree` there.
 */
export function pinTree(repoRoot: string, t: OutletTreeRef, sourceRepo: string): PinnedTree {
  if ('commit' in t) {
    try {
      const sha = execFileSync(
        'git',
        ['-C', repoRoot, 'rev-parse', '--verify', `${t.commit}^{commit}`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .trim();
      return { tree: { commit: sha }, key: `commit:${sha}` };
    } catch {
      // Never pinned literally: an unresolvable name would be re-resolved (to anything) later.
      throw new IterationError(`outlet tree ${t.commit} is not a commit of ${repoRoot}`, 2);
    }
  }
  const dir = resolve(t.dir);
  const head = cleanHead(dir);
  const ref = t.ref ?? (head ? `commit:${sourceRepo}@${head}` : undefined);
  return {
    tree: ref ? { dir, ref } : { dir },
    key: `dir:${dir}@${head ?? 'unpinned'}${t.ref ? `#${t.ref}` : ''}`,
  };
}

/** `bench/controls/*.json` (06 §10.2 step 4, roadmap M2-03), each read with `loadControlArm`:
 * a hand-written skill proposal labelled `control` and the rejection it must earn (`expect`). */
export function loadControls(
  benchDir: string,
  controlsDir: string,
): { file: string; arm: ControlArm }[] {
  const dir = resolve(benchDir, controlsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      let arm: ControlArm;
      try {
        arm = loadControlArm(join(dir, f));
      } catch (err) {
        throw new IterationError(`control ${f} is invalid: ${(err as Error).message}`, 2);
      }
      const p = arm.proposal;
      if (p.action !== 'create' && !(p.action === 'patch' && p.outlet === 'skill')) {
        throw new IterationError(`control ${f} must be a skill proposal (create or patch)`, 2);
      }
      return { file: relative(benchDir, join(dir, f)), arm };
    });
}

async function stepControl(c: Ctx): Promise<StepOutcome> {
  const ctl = c.s.control;
  if (c.s.baseline.earlyStop) {
    // 06 §1.3: an early stop records no_action and returns; nothing else is evaluated.
    ctl.status = 'skipped';
    ctl.message = 'early stop: no control arm (06 §1.3)';
    c.save();
    return { ok: true };
  }
  if (ctl.items.length === 0) {
    const found = loadControls(c.o.benchDir, c.s.settings.controlsDir);
    if (found.length === 0) {
      ctl.status = 'skipped';
      ctl.message = `no control proposals under ${c.s.settings.controlsDir}`;
      c.save();
      return { ok: true };
    }
    ctl.items = found.map((x) => ({
      status: 'pending',
      file: x.file,
      controlId: x.arm.id,
      proposal: x.arm.proposal,
      expect: x.arm.expect,
      proposalId: `control-${x.arm.id}-${c.s.iterationId.slice(-8)}`,
      skill: skillOf(x.arm.proposal),
    }));
    c.save();
  }
  const replayVal = c.tasks.filter((t) => t.spec.split === 'val' && t.spec.kind === 'replay');
  const onDisk = new Map(
    loadControls(c.o.benchDir, c.s.settings.controlsDir).map((x) => [x.file, x.arm] as const),
  );
  for (const item of ctl.items) {
    if (item.status === 'done') continue;
    // The control is the pinned file's (bench/controls is an iteration pin), never the copy in a
    // restored state.
    const arm = onDisk.get(item.file);
    if (
      !arm ||
      arm.id !== item.controlId ||
      canonicalJson(arm.proposal) !== canonicalJson(item.proposal) ||
      canonicalJson(arm.expect) !== canonicalJson(item.expect) ||
      item.proposalId !== `control-${arm.id}-${c.s.iterationId.slice(-8)}`
    ) {
      item.status = 'failed';
      item.message = `control ${item.controlId} in the state is not ${item.file} on disk`;
      ctl.status = 'failed';
      return stop(c, 'control', 'failed', `control: ${item.message}`, 4);
    }
    const out = await evaluateCandidate(c, 'control', item, item.proposal, {
      control: true,
      ...('patterns' in item.proposal ? { pattern: item.proposal.patterns } : {}),
    });
    if (!out.ok) {
      ctl.status = item.status;
      return out;
    }
    const d = item.decision as DecisionSummary;
    item.replayRegressions = replayVal
      .map((t) => t.id)
      .filter((id) => rejectedForReplayRegression(d, id));
    // 06 §10.3: the control counts only when rejected for the reason it encodes.
    item.expectMet =
      item.expect.decision === 'reject' &&
      item.expect.reason === 'replay-regression' &&
      rejectedForReplayRegression(d, item.expect.task);
    const note = `control ${item.controlId}: ${item.expectMet ? 'rejected' : 'NOT rejected'} for replay-regression on ${item.expect.task} (06 §10.3)`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.save();
  }
  return { ok: true };
}

// ---- step 7: record ---------------------------------------------------------------------------

function recordEvent(c: Ctx, e: LedgerEvent, gateInput: GateInputRecord | undefined): boolean {
  const o = c.o;
  if (gateInput) {
    GateInputRecordSchema.parse(gateInput);
    const f = join(o.wikiRoot, evalEvidencePath(gateInput.hash));
    if (!existsSync(f)) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, `${JSON.stringify(gateInput, null, 2)}\n`);
    }
    if (!readGateInput(o.wikiRoot, gateInput.hash))
      throw new IterationError(`gate input ${gateInput.hash} does not read back`, 1);
  }
  if (ledgerEvents(o.wikiRoot).some((x) => x.eventId === e.eventId)) return false;
  appendEvent(o.wikiRoot, e);
  return true;
}

function stepRecord(c: Ctx): StepOutcome {
  const o = c.o;
  const pairs: [LedgerEvent, GateInputRecord | undefined][] = [];
  const ev = c.s.evaluate;
  if (ev.event) pairs.push([ev.event, ev.candidate?.gateInput]);
  for (const item of c.s.control.items) if (item.event) pairs.push([item.event, item.gateInput]);
  const written: string[] = [];
  for (const [e, gi] of pairs) if (recordEvent(c, e, gi)) written.push(e.eventId);
  const events = ledgerEvents(o.wikiRoot);
  const wiki = loadWiki(o.wikiRoot);
  let log = wiki.log;
  // Every event of this iteration that is in the ledger gets its log line once: one appended by
  // an earlier, interrupted invocation (crash between the append and this write) is repaired.
  for (const [e] of pairs) {
    if (!events.some((x) => x.eventId === e.eventId)) continue;
    if ((log ?? '').includes(`ledger event ${e.eventId}`)) continue;
    // No reason text: log.md is copied verbatim into agent bundles, and gate reasons name val
    // tasks (06 §1.4). The ledger holds the reason; bundles get only its projection.
    log = appendLogEntry(log, {
      ts: c.now().toISOString(),
      actor: 'harness',
      operation: `${e.control ? 'control ' : ''}${e.stage} ${e.proposalId}`,
      body: `bench iterate ${c.s.iterationId}: ${e.stage}${e.outlet ? ` (${e.outlet}${e.skill ? `, ${e.skill}` : ''})` : ''}; ledger event ${e.eventId}`,
    });
  }
  writeChangeset(o.wikiRoot, {
    writes: [
      { path: SKILL_IMPACT_FILE, content: renderSkillImpact(events) },
      ...(log !== wiki.log ? [{ path: LOG_FILE, content: log as string }] : []),
    ],
  });
  c.s.record.eventIds = pairs.map(([e]) => e.eventId);
  c.s.record.status = 'done';
  c.s.record.message = `${pairs.length} event(s) in the ledger (${written.length} appended now)`;
  c.save();
  return { ok: true };
}

// ---- step 8: hand-off (M2-04) -----------------------------------------------------------------

export interface Handoff {
  kind: 'pr' | 'issue' | 'review';
  title: string;
  labels: string[];
  draft: boolean;
  /** For a PR: the branch the orchestrator pushes the candidate skill set to. */
  branch?: string;
  body: string;
  iterationId: string;
  proposalId?: string;
  eventId?: string;
  gateInput?: string;
  recompute?: string;
}

const fmt = (x: number) => x.toFixed(2);

function resultsTable(
  results: readonly GateResult[],
  heldOut: ReadonlyMap<string, string>,
): string[] {
  if (results.length === 0) return ['_No per-model results._'];
  return [
    '| model | mode | split | runs | replay passing (cand/base of total) | regressions | capability before → after | Δ | p | decision |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.model} | ${r.mode} | ${r.split} | ${r.runs} | ${r.replay.candidatePassing}/${r.replay.baselinePassing} of ${r.replay.total} | ${r.replay.regressions.length ? countTasks(r.replay.regressions, heldOut) : '—'} | ${fmt(r.capability.before)} → ${fmt(r.capability.after)} | ${r.capability.delta >= 0 ? '+' : ''}${fmt(r.capability.delta)} | ${r.capability.pValue ?? '—'} | ${r.decision} |`,
    ),
  ];
}

const failReasons = (d: DecisionSummary | undefined): string[] =>
  (d?.reasons ?? [])
    .filter((r) => r.severity !== 'info')
    .map(
      (r) =>
        `- \`${r.code}\`${[r.model, r.mode, r.task].filter(Boolean).length ? ` (${[r.model, r.mode, r.task].filter(Boolean).join(' / ')})` : ''}${r.detail ? `: ${r.detail}` : ''}`,
    );

/** The iteration's spend from the ledger: every spend event of its evaluations and LLM roles. */
export function iterationCost(
  s: IterationState,
  events: readonly LedgerEvent[],
): { model: string; requests: number; rollouts: number; tokensIn: number; tokensOut: number }[] {
  const ids = new Set<string>(
    [
      s.train.evaluationId,
      s.baseline.evaluationId,
      s.evaluate.candidate?.evaluationId,
      ...s.control.items.map((i) => i.evaluationId),
    ].filter((x): x is string => Boolean(x)),
  );
  const by = new Map<
    string,
    { requests: number; rollouts: number; tokensIn: number; tokensOut: number }
  >();
  for (const e of events) {
    const sp = e.spend;
    if (e.stage !== 'spend' || !sp?.evaluationId) continue;
    if (!ids.has(sp.evaluationId) && !sp.evaluationId.startsWith(`${s.iterationId}/`)) continue;
    const m = sp.model ?? '(unnamed)';
    const t = by.get(m) ?? { requests: 0, rollouts: 0, tokensIn: 0, tokensOut: 0 };
    t.requests += sp.requests;
    t.rollouts += sp.rollouts;
    t.tokensIn += sp.tokensIn;
    t.tokensOut += sp.tokensOut;
    by.set(m, t);
  }
  return [...by]
    .map(([model, t]) => ({ model, ...t }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

function candidateSection(
  c: HandoffCtx & { state: IterationState },
  cand: CandidateState,
  heading: string,
): string[] {
  const gi = cand.gateInput?.hash;
  const out = [`### ${heading}`, ''];
  out.push(
    `- proposal: \`${cand.proposalId}\` (skill \`${cand.skill}\`, blast radius ${cand.radius ?? '—'})`,
  );
  if (cand.event)
    out.push(
      `- ledger event: \`${cand.event.eventId}\` (\`${cand.event.stage}\`, path \`${cand.event.path}\`)`,
    );
  if (gi) out.push(`- gate input: \`${gi}\``);
  if (cand.decision) {
    out.push(
      `- evaluation records: ${[...cand.decision.baselineRecords, ...cand.decision.candidateRecords].map((h) => `\`${h}\``).join(', ')}`,
    );
    out.push(`- bootstrap seed: \`${cand.decision.seed}\``);
  }
  if (gi)
    out.push(
      '',
      'Recompute the decision from the stored evidence (no rollouts):',
      '',
      '```sh',
      `greenlight bench gate --recompute ${gi}`,
      '```',
    );
  out.push('', ...resultsTable(cand.decision?.results ?? [], heldOutTasks(c.state, c)));
  const reasons = failReasons(cand.decision);
  if (reasons.length) out.push('', 'Reasons:', '', ...reasons);
  if (cand.candidateSkills) {
    const diff = treeDiff(c.skillsDir, join(c.dir, cand.candidateSkills));
    out.push(
      '',
      '<details><summary>diff</summary>',
      '',
      '```diff',
      diff.trimEnd() || '(no change)',
      '```',
      '',
      '</details>',
    );
  }
  return out;
}

interface HandoffCtx {
  dir: string;
  skillsDir: string;
  wikiRoot: string;
  /** Val and test task ids → split (from the bench); masked in the public hand-off (06 §1.4). */
  heldOut?: ReadonlyMap<string, string>;
}

/** Val/test task ids the hand-off must not name: the bench's, plus every task id the state's
 * val decisions name (a gate decision runs on val only). */
function heldOutTasks(s: IterationState, c: HandoffCtx): Map<string, string> {
  const out = new Map(c.heldOut ?? []);
  const cands = [s.evaluate.candidate, ...s.control.items].filter(
    (x): x is CandidateState => x !== undefined,
  );
  for (const cand of cands) {
    for (const r of cand.decision?.results ?? [])
      for (const t of r.replay.regressions) if (!out.has(t)) out.set(t, r.split);
    for (const r of cand.decision?.reasons ?? [])
      if (r.task && !out.has(r.task)) out.set(r.task, 'val');
  }
  for (const item of s.control.items) {
    if (!out.has(item.expect.task)) out.set(item.expect.task, 'val');
    for (const t of item.replayRegressions ?? []) if (!out.has(t)) out.set(t, 'val');
  }
  return out;
}

/** `2 val replay tasks`: what the public hand-off says instead of held-out task ids. */
function countTasks(ids: readonly string[], heldOut: ReadonlyMap<string, string>): string {
  const by = new Map<string, number>();
  for (const id of ids) {
    const k = `${heldOut.get(id) ?? 'val'} ${id.split('/')[0] ?? 'task'}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${n} ${k} task${n === 1 ? '' : 's'}`)
    .join(', ');
}

/** Replaces every held-out task id left in `text` by its split and family, then redacts secrets:
 * the hand-off is posted publicly (a PR or issue body). */
function publicText(text: string, heldOut: ReadonlyMap<string, string>): string {
  let out = text;
  for (const id of [...heldOut.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split(id).join(`(a ${heldOut.get(id)} ${id.split('/')[0]} task)`);
  }
  return redact(out);
}

/** Builds the hand-off for an iteration from its state (pure apart from reading the ledger and the
 * candidate diff). */
export function buildHandoff(s: IterationState, hc: HandoffCtx): Handoff {
  const c = { ...hc, state: s };
  const heldOut = heldOutTasks(s, hc);
  const p = s.proposer.proposal;
  const e = s.evaluate.event;
  const cand = s.evaluate.candidate;
  const events = ledgerEvents(c.wikiRoot);
  const review = `greenlight bench review ${s.iterationId} --decision accept|reject --reason "<text>"`;
  const lines: string[] = [];
  let kind: Handoff['kind'] = 'review';
  let title = `evo: iteration ${s.iterationId}`;
  let draft = false;
  let branch: string | undefined;

  const stage = e?.stage ?? '(not recorded yet)';
  lines.push(`Greenlight evolution loop, iteration \`${s.iterationId}\` (vision 06 §1.3).`, '');
  lines.push(`**Outcome:** \`${stage}\`${e?.reason ? ` — ${e.reason}` : ''}`, '');
  if (s.evaluate.kind === 'skill' && p && (p.action === 'patch' || p.action === 'create')) {
    kind = 'pr';
    const accepted = e?.stage === 'candidate-accepted';
    draft = !accepted;
    branch = `evo/${s.proposer.proposalId}`;
    const what = p.action === 'create' ? 'new skill' : `${p.edits.length} edit(s)`;
    title = `evo(${p.name}): ${what} citing ${p.patterns.join(', ')} [${s.proposer.proposalId}]`;
    if (!accepted)
      lines.push(
        '> The gate did not accept this candidate. The PR documents the rejected change for review; do not merge it (the wiki keeps the rejection, 06 §6).',
        '',
      );
    else if (cand?.radius === 'high')
      lines.push(
        '> High blast radius (06 §5.4): merging is not enough, a release that passes §5.7 is also required.',
        '',
      );
    if (cand) lines.push(...candidateSection(c, cand, 'Gate'), '');
  } else if (s.evaluate.kind === 'outlet' && p) {
    if (p.action === 'issue') {
      kind = 'issue';
      title = p.title;
      lines.push(p.body.trim(), '', '---', '');
    } else if (p.action === 'patch') {
      kind = 'pr';
      draft = e?.stage !== 'candidate-accepted';
      branch = `evo/${s.proposer.proposalId}`;
      title = `evo(${p.name}): template patch [${s.proposer.proposalId}]`;
    }
    const outletName = 'outlet' in p ? p.outlet : '';
    lines.push(`### Outlet evaluation (${outletName}, 06 §5.6)`, '');
    lines.push(`- proposal: \`${s.proposer.proposalId}\``);
    if (e) lines.push(`- ledger event: \`${e.eventId}\` (\`${e.stage}\`)`);
    const r = s.evaluate.outlet?.result;
    if (r) lines.push(`- decision: \`${r.decision}\` (${r.reasons.join('; ') || 'no reasons'})`);
    if (r?.evidence) lines.push(`- evidence: \`${JSON.stringify(r.evidence)}\``);
    if (r?.decision === 'invalid')
      lines.push(
        '',
        '> **No ledger outcome.** The outlet rule could not be applied (an invalid evaluation never reaches the ledger, 06 §4.8). This is not a rejection: the proposal waits for what the reasons name (for example an owner-reviewed repro).',
      );
    else if (!r && s.evaluate.message) lines.push(`- not decided yet: ${s.evaluate.message}`);
    if (outletName === 'verify' && (!r || r.decision === 'invalid'))
      lines.push(
        '',
        '> In M2 a verify proposal is evaluated only programmatically (`OutletContext.artifacts`: the faulty and fixed artifacts and how to serve them); `bench iterate` takes no artifacts on the command line.',
      );
    if (e?.evidence?.kind === 'template' && e.evidence.gateInput)
      lines.push('', '```sh', `greenlight bench gate --recompute ${e.evidence.gateInput}`, '```');
    lines.push('');
  } else if (s.evaluate.kind === 'no-action' || s.evaluate.kind === 'early-stop') {
    title = `evo: no action (${s.evaluate.kind === 'early-stop' ? 'early stop' : 'proposer'}) — iteration ${s.iterationId}`;
    lines.push(`- proposal: \`${e?.proposalId ?? s.proposer.proposalId}\``);
    if (e) lines.push(`- ledger event: \`${e.eventId}\` (\`no-action\`)`);
    lines.push('', 'A justified `no_action` is a successful iteration (06 §0).', '');
  }

  const m = s.maintainer;
  lines.push('### Maintainer pass', '');
  lines.push(
    `- bundle: \`${m.bundleId ?? '—'}\` (${m.rawIds?.length ?? 0} raw record(s), incidents: ${s.settings.incidents.join(', ') || 'none'})`,
  );
  lines.push(`- status: ${m.status}${m.message ? ` — ${m.message}` : ''}`);
  if (m.indexCorrections?.length)
    lines.push(`- index corrections: ${m.indexCorrections.join('; ')}`);
  if (m.outputFile && existsSync(m.outputFile)) {
    try {
      const out = JSON.parse(readFileSync(m.outputFile, 'utf8')) as MaintainerOutput;
      lines.push('', '```text', out.append_log.trim(), '```');
    } catch {
      // the stored output is shown only when it reads back
    }
  }
  lines.push('');

  if (s.control.items.length > 0) {
    lines.push('### Control arm (06 §10.2 step 4; never merged)', '');
    for (const item of s.control.items) {
      lines.push(...candidateSection(c, item, `Control ${item.file}`));
      lines.push(
        '',
        `- rejected for a replay regression: ${item.replayRegressions?.length ? `yes, on ${countTasks(item.replayRegressions, heldOut)}` : 'no'}`,
        `- expected: \`${item.expect.decision}\` for \`${item.expect.reason}\` on ${countTasks([item.expect.task], heldOut)} → ${item.expectMet === undefined ? 'not evaluated yet' : item.expectMet ? '**met** (`rejectedForReplayRegression`)' : '**NOT met**: the gate did not refuse the plausible but wrong lesson (06 §10.3)'}`,
        '',
      );
    }
  }

  const cost = iterationCost(s, events);
  lines.push('### Cost', '');
  if (cost.length === 0) lines.push('_No spend recorded (cached evidence only)._');
  else {
    lines.push('| model | requests | rollouts | tokens in | tokens out |', '|---|---|---|---|---|');
    for (const x of cost)
      lines.push(`| ${x.model} | ${x.requests} | ${x.rollouts} | ${x.tokensIn} | ${x.tokensOut} |`);
  }
  lines.push('');
  if (s.notes.length) lines.push('### Notes', '', ...s.notes.map((n) => `- ${n}`), '');
  lines.push('### Review', '');
  if (s.review) {
    lines.push(
      `Reviewed ${s.review.ts}: **${s.review.decision}** — ${s.review.reason}`,
      '',
      `Ledger events: ${s.review.eventIds.map((x) => `\`${x}\``).join(', ')}`,
    );
  } else {
    lines.push(
      'Record the owner review of these ledger rows (06 §0 condition 4):',
      '',
      '```sh',
      review,
      '```',
    );
  }
  lines.push('');

  const gi = cand?.gateInput?.hash;
  return {
    kind,
    title: publicText(title, heldOut),
    labels: ['greenlight-evo'],
    draft,
    ...(branch ? { branch } : {}),
    body: publicText(lines.join('\n'), heldOut),
    iterationId: s.iterationId,
    ...((s.proposer.proposalId ?? e?.proposalId)
      ? { proposalId: s.proposer.proposalId ?? e?.proposalId }
      : {}),
    ...(e ? { eventId: e.eventId } : {}),
    ...(gi ? { gateInput: gi, recompute: `greenlight bench gate --recompute ${gi}` } : {}),
  };
}

/** Val and test task ids of a bench, by split (`splits.json`, else each task's own split). */
export function benchHeldOut(benchDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(join(benchDir, 'tasks'))) return out;
  for (const t of loadTasks(benchDir).tasks)
    if (t.spec.split !== 'train') out.set(t.id, t.spec.split);
  for (const [id, split] of readSplits(benchDir) ?? []) if (split !== 'train') out.set(id, split);
  return out;
}

export function renderHandoffMarkdown(h: Handoff): string {
  return [
    `<!-- greenlight-evo hand-off: iteration ${h.iterationId}; the orchestrator posts this (the CLI does not call GitHub) -->`,
    `kind: ${h.kind}`,
    `title: ${h.title}`,
    `labels: ${h.labels.join(', ')}`,
    ...(h.kind === 'pr' ? [`draft: ${h.draft}`] : []),
    ...(h.branch ? [`branch: ${h.branch}`] : []),
    '---',
    '',
    h.body,
  ].join('\n');
}

/** Writes `handoff.md` and `handoff.json` for an iteration (also `--handoff-only`). */
export function writeHandoff(o: {
  stateDir: string;
  skillsDir: string;
  wikiRoot: string;
  iterationId: string;
  /** The bench, for its val/test task ids (masked in the hand-off). */
  benchDir?: string;
}): { file: string; handoff: Handoff } {
  const s = loadIterationState(o.stateDir, o.iterationId);
  const dir = iterationDir(o.stateDir, o.iterationId);
  const h = buildHandoff(s, {
    dir,
    skillsDir: o.skillsDir,
    wikiRoot: o.wikiRoot,
    ...(o.benchDir ? { heldOut: benchHeldOut(o.benchDir) } : {}),
  });
  const file = join(dir, 'handoff.md');
  writeFileSync(file, `${renderHandoffMarkdown(h)}\n`);
  writeFileSync(join(dir, 'handoff.json'), `${JSON.stringify(h, null, 2)}\n`);
  return { file, handoff: h };
}

function stepHandoff(c: Ctx): StepOutcome {
  c.s.handoff.status = 'done';
  c.s.status = 'complete';
  c.s.step = 'handoff';
  c.s.message = 'complete: post the hand-off for owner review';
  c.save();
  const { file } = writeHandoff({
    stateDir: c.stateDir,
    skillsDir: c.o.skillsDir,
    wikiRoot: c.o.wikiRoot,
    iterationId: c.s.iterationId,
    benchDir: c.o.benchDir,
  });
  c.s.handoff.file = relative(c.dir, file);
  c.save();
  return { ok: true };
}

// ---- the driver -------------------------------------------------------------------------------

function newState(
  o: IterateOptions,
  c: { id: string; accepted: string; now: Date; wiki: Wiki },
): IterationState {
  const incidents =
    o.incidents ??
    [...c.wiki.pages.values()]
      .filter((p) => !p.archived && p.frontmatter.type === 'incident')
      .map((p) => p.id)
      .sort();
  const benchRel = (d: string) => relative(o.benchDir, resolve(o.benchDir, d)) || '.';
  return {
    v: 1,
    iterationId: c.id,
    createdAt: c.now.toISOString(),
    updatedAt: c.now.toISOString(),
    status: 'running',
    step: 'train',
    settings: {
      scope: o.scope ?? 'all',
      sandbox: o.sandbox,
      ...(o.models ? { models: o.models } : {}),
      ...(o.runs !== undefined ? { runs: o.runs } : {}),
      ...(o.maxSteps !== undefined ? { maxSteps: o.maxSteps } : {}),
      ...(o.rolloutRequestCap !== undefined ? { rolloutRequestCap: o.rolloutRequestCap } : {}),
      agentMaxSteps: { ...DEFAULT_AGENT_MAX_STEPS, ...(o.agentMaxSteps ?? {}) },
      incidents,
      controlsDir: benchRel(o.controlsDir ?? join(o.benchDir, 'controls')),
    },
    acceptedSkillSetHash: c.accepted,
    notes: [],
    train: { status: 'pending' },
    maintainer: { status: 'pending', attempts: 0 },
    baseline: { status: 'pending' },
    proposer: { status: 'pending', attempts: 0 },
    evaluate: { status: 'pending' },
    control: { status: 'pending', items: [] },
    record: { status: 'pending' },
    handoff: { status: 'pending' },
  };
}

/** The accepted skill set (06 §1.5): from the ledger's latest gated state, else the installed
 * skills. The installed skills must BE that set, since every rollout runs from them. */
export function resolveAcceptedSkillSet(wikiRoot: string, skillsDir: string): string {
  const installed = skillSetHashOf(skillsDir);
  const fromLedger = acceptedSkillSet(ledgerEvents(wikiRoot), (h) => readGateInput(wikiRoot, h));
  if (fromLedger !== undefined && fromLedger !== installed) {
    throw new IterationError(
      `the installed skills (${installed.slice(0, 12)}) are not the accepted skill set ${fromLedger.slice(0, 12)} the ledger names; check out the accepted skills first`,
      4,
    );
  }
  return fromLedger ?? skillSetHash(skillsDir) ?? installed;
}

const STEP_FNS: Record<IterationStep, (c: Ctx) => Promise<StepOutcome> | StepOutcome> = {
  train: stepTrain,
  maintainer: stepMaintainer,
  baseline: stepBaseline,
  proposer: stepProposer,
  evaluate: stepEvaluate,
  control: stepControl,
  record: stepRecord,
  handoff: stepHandoff,
};

const stepStatus = (s: IterationState, step: IterationStep): StepStatus => s[step].status;

export async function iterate(o: IterateOptions): Promise<IterateResult> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const stateDir = o.stateDir ?? join(o.repoRoot, '.greenlight');
  try {
    assertOutsideSkills(o.skillsDir, stateDir, 'iteration state');
    assertOutsideSkills(o.skillsDir, o.wikiRoot, 'the wiki');
    const id = o.resume ?? o.iterationId ?? `iter-${newRawId(now())}`;
    if (!ITERATION_ID_RE.test(id)) throw new IterationError(`"${id}" is not an iteration id`, 2);
    if (o.resume && !existsSync(iterationStatePath(stateDir, id)))
      throw new IterationError(`no iteration ${id} at ${iterationStatePath(stateDir, id)}`, 2);
    if (!o.resume && existsSync(iterationStatePath(stateDir, id)))
      throw new IterationError(`iteration ${id} exists; resume it with --resume ${id}`, 2);
    // The lock comes first: the state is loaded (or created) only by its holder.
    const dir = iterationDir(stateDir, id);
    const unlock = acquireLock(dir, log, { breakLock: o.breakLock === true });
    try {
      let s: IterationState;
      if (o.resume) {
        s = loadIterationState(stateDir, id);
        if (o.sandbox !== s.settings.sandbox) {
          throw new IterationError(
            `iteration ${s.iterationId} runs in the ${s.settings.sandbox} sandbox; resume it there`,
            4,
          );
        }
        if (s.status === 'complete') {
          return {
            status: 'complete',
            iterationId: s.iterationId,
            step: 'handoff',
            message: `iteration ${s.iterationId} is already complete`,
            state: s,
            exitCode: 0,
          };
        }
        checkPins(s, o, log);
      } else {
        if (existsSync(iterationStatePath(stateDir, id)))
          throw new IterationError(`iteration ${id} exists; resume it with --resume ${id}`, 2);
        const accepted = resolveAcceptedSkillSet(o.wikiRoot, o.skillsDir);
        const wiki = loadWiki(o.wikiRoot);
        if (
          o.scope &&
          o.scope !== 'all' &&
          !loadSkills(o.skillsDir).some((x) => x.name === o.scope)
        )
          throw new IterationError(`scope ${o.scope} is not a managed skill`, 2);
        s = newState(o, { id, accepted, now: now(), wiki });
        s.pins = iterationPins(o.benchDir, o.skillsDir);
        const head = headCommit(o.repoRoot);
        if (head) s.baseCommit = head;
        for (const inc of s.settings.incidents) {
          const page = wiki.pages.get(inc);
          if (!page || page.frontmatter.type !== 'incident')
            throw new IterationError(`${inc} is not an incident page of the wiki`, 2);
        }
      }
      const tasks = loadTasks(o.benchDir);
      if (tasks.problems.length > 0) throw new IterationError(tasks.problems.join('\n'), 3);
      const c: Ctx = {
        o,
        s,
        stateDir,
        dir,
        keysDir: join(stateDir, 'bundle-keys'),
        templatesDir: o.templatesDir ?? join(o.repoRoot, 'tools'),
        config: readModels(o.benchDir),
        splits: readSplits(o.benchDir),
        tasks: tasks.tasks,
        now,
        log,
        save: () => saveState(stateDir, s, now()),
      };
      s.status = 'running';
      s.message = undefined;
      c.save();
      log(
        `iteration ${s.iterationId} (${o.resume ? 'resumed' : 'new'}), state ${iterationStatePath(stateDir, s.iterationId)}`,
      );
      for (const step of ITERATION_STEPS) {
        const st = stepStatus(s, step);
        if (st === 'done' || st === 'skipped') continue;
        s.step = step;
        c.save();
        o.onStep?.(step);
        log(`step ${step} …`);
        let out: StepOutcome;
        try {
          out = await STEP_FNS[step](c);
        } catch (err) {
          // Anything unexpected fails the step visibly and leaves it resumable.
          if (err instanceof IterationError) throw err;
          s[step].status = 'failed';
          s[step].message = (err as Error).message;
          out = stop(c, step, 'failed', `${step}: ${(err as Error).message}`, 1);
        }
        if (!out.ok) return out.result;
        if (s[step].status !== 'skipped') s[step].status = 'done';
        c.save();
      }
      return {
        status: 'complete',
        iterationId: s.iterationId,
        step: 'handoff',
        message: `iteration ${s.iterationId} complete; hand-off at ${join(dir, 'handoff.md')}`,
        state: s,
        exitCode: 0,
      };
    } finally {
      unlock();
    }
  } catch (e) {
    if (e instanceof IterationError) {
      return {
        status: e.exitCode === 2 ? 'usage' : 'refused',
        message: e.message,
        exitCode: e.exitCode,
      };
    }
    throw e;
  }
}

// ---- review (M2-04) ---------------------------------------------------------------------------

/**
 * Records the owner's review of an iteration's ledger rows (06 §0 condition 4, 13 §3 M2 #6). For
 * every recorded proposal of the iteration (the real one and each control), by the proposal's
 * LATEST ledger stage (not the stage the iteration recorded, which may have moved on):
 * - a `reject` of a proposal whose latest stage is accepted or later (`candidate-accepted`,
 *   `merged`, `released`, `verified-in-production`) is a `withdrawn` event (06 §6.1: abandoned
 *   after acceptance, with the reason), carrying the review;
 * - everything else is a `review` annotation event: a stage that may follow any stage, final ones
 *   included, and never moves the stage machine (08 §8).
 * Under the iteration lock, every event is computed first and saved in the state, then appended
 * all or nothing (`appendEvents`); a retry after a crash appends the same events (same eventIds),
 * so nothing is duplicated. Refuses an iteration with nothing recorded yet, or one already reviewed.
 */
export function reviewIteration(o: {
  stateDir: string;
  wikiRoot: string;
  skillsDir: string;
  iterationId: string;
  decision: 'accept' | 'reject';
  reason: string;
  benchDir?: string;
  now?: () => Date;
  breakLock?: boolean;
  log?: (s: string) => void;
}): { eventIds: string[]; events: LedgerEvent[] } {
  const now = o.now ?? (() => new Date());
  const reason = o.reason.trim();
  if (!reason) throw new IterationError('a review needs --reason', 2);
  if (!ITERATION_ID_RE.test(o.iterationId))
    throw new IterationError(`"${o.iterationId}" is not an iteration id`, 2);
  if (!existsSync(iterationStatePath(o.stateDir, o.iterationId)))
    throw new IterationError(`no iteration ${o.iterationId}`, 2);
  const unlock = acquireLock(iterationDir(o.stateDir, o.iterationId), o.log, {
    breakLock: o.breakLock === true,
  });
  try {
    const s = loadIterationState(o.stateDir, o.iterationId);
    if (s.review) {
      throw new IterationError(
        `iteration ${s.iterationId} was already reviewed (${s.review.decision}, ${s.review.ts})`,
        4,
      );
    }
    const recorded = new Set(s.record.eventIds ?? []);
    const targets = [s.evaluate.event, ...s.control.items.map((i) => i.event)].filter(
      (e): e is LedgerEvent => e !== undefined && recorded.has(e.eventId),
    );
    if (s.record.status !== 'done' || targets.length === 0) {
      throw new IterationError(
        `iteration ${s.iterationId} has no recorded ledger rows to review yet (step ${s.step}: ${s.status})`,
        4,
      );
    }
    let pending = s.reviewPending;
    if (pending && (pending.decision !== o.decision || pending.reason !== reason)) {
      throw new IterationError(
        `iteration ${s.iterationId} has a half-recorded review (${pending.decision}: ${pending.reason}); rerun it with the same --decision and --reason to finish it`,
        4,
      );
    }
    // The events are DERIVED from the state and the ledger, never taken from a stored copy: a
    // pending review keeps only its decision, reason and ts, and its events must re-derive to the
    // same eventIds (the ledger read without them, in case a crash left them appended).
    const derive = (ts: string, without: ReadonlySet<string>) => {
      const ledger = ledgerEvents(o.wikiRoot).filter((e) => !without.has(e.eventId));
      return targets.map((target) => {
        const latest = proposalHistory(ledger, target.proposalId as string).latest;
        const withdraw =
          o.decision === 'reject' && latest !== undefined && AFTER_ACCEPT.has(latest);
        return sealEvent({
          ts,
          proposalId: target.proposalId,
          stage: withdraw ? 'withdrawn' : 'review',
          ...(target.control ? { control: true } : {}),
          reason: `owner review (${o.decision}): ${reason}`,
          review: { decision: o.decision, iteration: s.iterationId },
        });
      });
    };
    let events: LedgerEvent[];
    if (pending) {
      const stored = new Set(pending.events.map((e) => e.eventId));
      events = derive(pending.ts, stored);
      const same =
        events.length === pending.events.length &&
        events.every((e, i) => e.eventId === pending?.events[i]?.eventId);
      if (!same) {
        throw new IterationError(
          `iteration ${s.iterationId} has a half-recorded review whose events do not re-derive from the state and the ledger; refusing to append them`,
          4,
        );
      }
    } else {
      const ts = now().toISOString();
      events = derive(ts, new Set());
      pending = { decision: o.decision, reason, ts, events };
      s.reviewPending = pending;
      saveState(o.stateDir, s, now());
    }

    try {
      // A torn trailing line (a crash mid-append) is repaired under the ledger lock first.
      appendEvents(o.wikiRoot, events, { repairTornTail: true });
    } catch (e) {
      // The pending review is KEPT: a retry derives and appends the same events (same eventIds,
      // same reason), never new ones.
      throw new IterationError(
        `the review was not recorded (${(e as Error).message}); rerun it with the same --decision and --reason`,
        4,
      );
    }
    writeChangeset(o.wikiRoot, {
      writes: [{ path: SKILL_IMPACT_FILE, content: renderSkillImpact(ledgerEvents(o.wikiRoot)) }],
    });
    s.review = {
      decision: o.decision,
      reason,
      ts: pending.ts,
      eventIds: events.map((e) => e.eventId),
    };
    s.reviewPending = undefined;
    saveState(o.stateDir, s, now());
    writeHandoff({
      stateDir: o.stateDir,
      skillsDir: o.skillsDir,
      wikiRoot: o.wikiRoot,
      iterationId: s.iterationId,
      ...(o.benchDir ? { benchDir: o.benchDir } : {}),
    });
    return { eventIds: s.review.eventIds, events };
  } finally {
    unlock();
  }
}

/** Stages a reject withdraws (06 §6.1 `withdrawn`: reverted or abandoned after acceptance). */
const AFTER_ACCEPT: ReadonlySet<string> = new Set([
  'candidate-accepted',
  'merged',
  'released',
  'verified-in-production',
]);

// ---- dry run ----------------------------------------------------------------------------------

/** What `bench iterate --dry-run` reports: the steps left and what they would spend. No request,
 * no write, no docker. */
export function planIteration(o: IterateOptions): { lines: string[]; state?: IterationState } {
  const stateDir = o.stateDir ?? join(o.repoRoot, '.greenlight');
  const lines: string[] = [];
  let s: IterationState | undefined;
  if (o.resume) {
    s = loadIterationState(stateDir, o.resume);
    lines.push(
      `iteration ${s.iterationId}: ${s.status} at ${s.step}${s.message ? ` — ${s.message}` : ''}`,
    );
  } else {
    lines.push('a new iteration');
  }
  const accepted = s?.acceptedSkillSetHash ?? resolveAcceptedSkillSet(o.wikiRoot, o.skillsDir);
  lines.push(`accepted skill set ${accepted}`);
  const config = readModels(o.benchDir);
  const gateCfg = readGateCfg(o.benchDir);
  const tasks = loadTasks(o.benchDir).tasks.filter((t) => t.spec.state !== 'quarantined');
  const models = (s?.settings.models ?? o.models)?.length ?? 2;
  const runs = s?.settings.runs ?? o.runs ?? gateCfg.runs;
  const val = tasks.filter((t) => t.spec.split === 'val');
  const train = tasks.filter((t) => t.spec.split === 'train');
  const cached = loadEvaluationRecords(o.wikiRoot).filter(
    (r) => r.role === 'train' && r.identity.skillSetHash === accepted,
  );
  const controls = loadControls(o.benchDir, s?.settings.controlsDir ?? o.controlsDir ?? 'controls');
  for (const step of ITERATION_STEPS) {
    const st = s ? stepStatus(s, step) : 'pending';
    let what = '';
    if (step === 'train')
      what = cached.length
        ? `reuse a sealed train record if its identity matches (${cached.map((r) => r.hash.slice(0, 12)).join(', ')}), else ${train.length * models} rollout(s)`
        : `${train.length * models} rollout(s)`;
    if (step === 'maintainer')
      what = `≤ ${(s?.settings.agentMaxSteps.maintainer ?? DEFAULT_AGENT_MAX_STEPS.maintainer) + 2} request(s) on ${entryForRole(config, 'maintainer').id}`;
    if (step === 'baseline')
      what = `${val.length * models * runs} rollout(s) unless a sealed baseline of this identity exists`;
    if (step === 'proposer')
      what = `≤ ${(s?.settings.agentMaxSteps.proposer ?? DEFAULT_AGENT_MAX_STEPS.proposer) + 2} request(s) on ${entryForRole(config, 'proposer').id}`;
    if (step === 'evaluate')
      what = `skill: ${val.length * models * runs} candidate rollout(s); other outlets: evaluateOutlet`;
    if (step === 'control')
      what = `${controls.length} control(s) × ${val.length * models * runs} rollout(s)`;
    lines.push(
      `  ${step.padEnd(10)} ${st.padEnd(8)} ${st === 'done' || st === 'skipped' ? '' : what}`,
    );
  }
  return { lines, ...(s ? { state: s } : {}) };
}
