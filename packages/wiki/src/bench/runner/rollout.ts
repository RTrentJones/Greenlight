import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRawId } from '@rtrentjones/greenlight-shared';
import { clientForRole } from '../../llm/models';
import { type ReactResult, buildSystemPrompt, runReact } from '../../llm/react';
import type { LoadedTask } from '../check-graders';
import { DEFAULT_EXTERNAL_TIMEOUT_FACTOR, externalBudgetNote } from '../external';
import { gradeRollout } from '../grade';
import {
  type Sandbox,
  createDockerSandbox,
  createProcessSandbox,
  shimUid,
  shortSocketDir,
  stageRollout,
  treeDiff,
} from '../sandbox';
import { Sequencer, ShimChannel, mergeTrajectory, toJsonl, toolCallEvent } from '../shims';
import { type RolloutOutcome, type RunCtx, seedFor } from './context';
import {
  DEFERRING,
  type JudgeState,
  ScopedBudget,
  TARGET_BRANCH,
  finishRaw,
  judgeFor,
  maintainerPrompt,
  retriedRequests,
} from './finish';
import { fixtureAwareDetector, fixtureTexts } from './redact';
import { roleOf } from './selection';
import { loadSkillsFor } from './skills';
import { AGENT_ROLE_PROMPT, CodingFinish, agentTools, budgetNote, maintainerFinish } from './tools';
import { ANNOUNCE_REMAINING_STEPS, ROLLOUT_KEY, ROLLOUT_RETRY_DELAYS_MS } from './types';

export async function runRollout(
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
