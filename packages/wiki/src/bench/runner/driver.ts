import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSecrets, newRawId, runIdentity, treeIdentity } from '@rtrentjones/greenlight-shared';
import { appendEvent } from '../../ledger';
import { RequestBudget } from '../../llm/limits';
import { checkModels, createLimiters, entryForRole, isExternalModel } from '../../llm/models';
import { FileQuotaStore, usageFromLedger } from '../../llm/quota';
import { HARNESS_VENDOR, HARNESS_VERSION } from '../../llm/react';
import {
  type Budget,
  BudgetSchema,
  EvaluationRecordSchema,
  ModelsConfigSchema,
  evalEvidencePath,
  identityDiff,
  sealRecord,
} from '../../schema/bench';
import { checkBudget, estimateGateCost, spendEvent } from '../budget';
import { type LoadedTask, loadTasks } from '../check-graders';
import {
  DEFAULT_CLAIM_TIMEOUT_MS,
  DEFAULT_EXTERNAL_CONCURRENCY,
  DEFAULT_EXTERNAL_TIMEOUT_FACTOR,
  EXTERNAL_AGENT_ID_RE,
  EXTERNAL_VENDOR,
  RolloutServer,
} from '../external';
import { computeIdentity } from '../identity';
import { type RunnerImage, ensureRunnerImage } from '../sandbox';
import { PrerequisiteError, readGateConfigFile, readJson } from './config';
import { type Limits, type RolloutOutcome, type RunCtx, type Usage, sourceRepo } from './context';
import {
  type Outcome,
  type Progress,
  ProgressSchema,
  progressPath,
  saveProgress,
} from './progress';
import { findCachedRecord, findCachedTrain, ledgerEvents, loadEvaluationRecords } from './records';
import { runRollout } from './rollout';
import { UsageError, globToRegExp, resolveModels } from './selection';
import {
  type BenchRunOptions,
  DEFAULT_MAX_STEPS,
  type EvalRole,
  type QuotaStore,
  REQUESTS_PER_ROLLOUT,
  ROLLOUT_KEY,
  type RolloutSummary,
  type RunResult,
  type RunStatus,
  type Split,
  rolloutRequestCap,
} from './types';

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
  const gateCfg: { runs?: number } = existsSync(join(o.benchDir, 'gate.json'))
    ? readGateConfigFile(o.benchDir)
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
  o.onEvaluationStarted?.(evaluationId);
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
