import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { newRawId } from '@rtrentjones/greenlight-shared';
import { acceptedSkillSet, readGateInput, skillSetHash } from '../../bundle';
import { gateInputOfEvent, proposalHistory } from '../../ledger';
import { entryForRole, isExternalRole } from '../../llm';
import { type Wiki, loadWiki } from '../../load';
import { findSecrets } from '../../redact';
import { loadSkills } from '../../skills';
import { loadTasks } from '../check-graders';
import { skillSetHashOf } from '../identity';
import { loadEvaluationRecords } from '../runner';
import { stepBaseline } from './baseline';
import {
  type Ctx,
  type StepOutcome,
  ledgerEvents,
  readGateCfg,
  readModels,
  readSplits,
  stop,
} from './context';
import { loadControls, stepControl, stepEvaluate } from './evaluate';
import { stepHandoff } from './handoff';
import { stepMaintainer } from './maintainer';
import { stepProposer } from './proposer';
import { stepRecord } from './record';
import { SUBMIT_FLAG } from './roles';
import {
  ITERATION_ID_RE,
  acquireLock,
  assertOutsideSkills,
  checkPins,
  headCommit,
  iterationDir,
  iterationPins,
  iterationStatePath,
  loadIterationState,
  saveState,
} from './state';
import { stepTrain } from './train';
import {
  AGENT_ID_RE,
  DEFAULT_AGENT_MAX_STEPS,
  type ExternalRole,
  ITERATION_STEPS,
  type IterateOptions,
  type IterateResult,
  IterationError,
  type IterationState,
  type IterationStep,
  type StepStatus,
} from './types';

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
      ...(o.rolloutAgent ? { rolloutAgent: o.rolloutAgent } : {}),
      agentMaxSteps: { ...DEFAULT_AGENT_MAX_STEPS, ...(o.agentMaxSteps ?? {}) },
      incidents,
      controlsDir: benchRel(o.controlsDir ?? join(o.benchDir, 'controls')),
      ...(o.safetyFixTargets?.length
        ? { safetyFixTargets: [...new Set(o.safetyFixTargets)].sort() }
        : {}),
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

/**
 * The accepted, not yet merged proposal whose gated candidate IS `installedSkillSet`, if any: the
 * one case where "the installed skills are not the accepted set" means "a merge was not recorded",
 * so the refusal can name the command that fixes it.
 */
export function unrecordedMerge(wikiRoot: string, installedSkillSet: string): string | undefined {
  const ledger = ledgerEvents(wikiRoot);
  const ids = [...new Set(ledger.flatMap((e) => (e.proposalId ? [e.proposalId] : [])))];
  for (const id of ids.reverse()) {
    const h = proposalHistory(ledger, id);
    if (h.latest !== 'candidate-accepted' || h.events.some((e) => e.control === true)) continue;
    const accepted = h.events.find((e) => e.stage === 'candidate-accepted');
    const gi = gateInputOfEvent(accepted);
    const sets = gi === undefined ? undefined : readGateInput(wikiRoot, gi);
    if (sets?.candidateSkillSetHash === installedSkillSet) return id;
  }
  return undefined;
}

/** The accepted skill set (06 §1.5): from the ledger's latest gated state, else the installed
 * skills. The installed skills must BE that set, since every rollout runs from them. */
export function resolveAcceptedSkillSet(wikiRoot: string, skillsDir: string): string {
  const installed = skillSetHashOf(skillsDir);
  const fromLedger = acceptedSkillSet(ledgerEvents(wikiRoot), (h) => readGateInput(wikiRoot, h));
  if (fromLedger !== undefined && fromLedger !== installed) {
    const unrecorded = unrecordedMerge(wikiRoot, installed);
    throw new IterationError(
      unrecorded
        ? `the installed skills (${installed.slice(0, 12)}) are the gated candidate of accepted proposal ${unrecorded}, but the ledger has no merged event for it. If it was merged, record that: greenlight bench merged ${unrecorded} --ref <commit sha or pull request URL>`
        : `the installed skills (${installed.slice(0, 12)}) are not the accepted skill set ${fromLedger.slice(0, 12)} the ledger names; check out the accepted skills first`,
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

/** The role a submitted file is for, after the usage checks: one file per invocation, only on a
 * resume, and always with a well-formed `--agent`. */
function submittedRole(o: IterateOptions): ExternalRole | undefined {
  const both = o.maintainerOutput !== undefined && o.proposal !== undefined;
  if (both) {
    throw new IterationError(
      'pass --maintainer-output or --proposal, not both: one step at a time',
      2,
    );
  }
  const role: ExternalRole | undefined =
    o.maintainerOutput !== undefined
      ? 'maintainer'
      : o.proposal !== undefined
        ? 'proposer'
        : undefined;
  if (!role) {
    if (o.agent !== undefined) {
      throw new IterationError(
        '--agent names who produced a submitted output: pass it with --maintainer-output or --proposal',
        2,
      );
    }
    return undefined;
  }
  const flag = SUBMIT_FLAG[role];
  if (!o.resume) throw new IterationError(`${flag} needs --resume <iterationId>`, 2);
  if (o.agent === undefined) {
    throw new IterationError(
      `${flag} needs --agent "<agent id>" (who produced the file, e.g. claude-code/<model>)`,
      2,
    );
  }
  if (!AGENT_ID_RE.test(o.agent) || findSecrets(o.agent).length > 0) {
    throw new IterationError(
      '--agent must be one token of letters, digits and . _ : / @ + - (at most 100 characters, starting with a letter or digit)',
      2,
    );
  }
  return role;
}

/** Refuses (exit 4) a submitted file the iteration is not waiting for: the role is not external,
 * its step is not `awaiting-external` (another step is, or it already has its output), or the
 * iteration is complete. Runs after the pin check, so drifted inputs refuse first. */
function checkSubmission(c: Ctx, role: ExternalRole): void {
  const s = c.s;
  const st = s[role];
  const flag = SUBMIT_FLAG[role];
  if (!isExternalRole(c.config, role)) {
    throw new IterationError(
      `${flag} refused: the ${role} role is "${c.config.roles[role]}" in bench/models.json, not "external"; the harness produces its output`,
      4,
    );
  }
  if (st.status === 'done' || (role === 'maintainer' && s.maintainer.outputFile !== undefined)) {
    throw new IterationError(
      `${flag} refused: iteration ${s.iterationId} already has its ${role} output (from ${st.agent ?? st.model ?? 'an earlier run'}); a second submission is never applied`,
      4,
    );
  }
  if (st.status !== 'awaiting-external') {
    const waiting = (['maintainer', 'proposer'] as const).find(
      (r) => s[r].status === 'awaiting-external',
    );
    throw new IterationError(
      `${flag} refused: iteration ${s.iterationId} is not awaiting the ${role}'s output (it is ${s.status} at ${s.step}${waiting ? `, awaiting the ${waiting}` : ''}; the ${role} step is ${st.status})`,
      4,
    );
  }
}

export async function iterate(o: IterateOptions): Promise<IterateResult> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const stateDir = o.stateDir ?? join(o.repoRoot, '.greenlight');
  try {
    assertOutsideSkills(o.skillsDir, stateDir, 'iteration state');
    assertOutsideSkills(o.skillsDir, o.wikiRoot, 'the wiki');
    const id = o.resume ?? o.iterationId ?? `iter-${newRawId(now())}`;
    if (!ITERATION_ID_RE.test(id)) throw new IterationError(`"${id}" is not an iteration id`, 2);
    const submitted = submittedRole(o);
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
        if (s.status === 'complete' && !submitted) {
          return {
            status: 'complete',
            iterationId: s.iterationId,
            step: 'handoff',
            message: `iteration ${s.iterationId} is already complete`,
            state: s,
            exitCode: 0,
          };
        }
        // The rollout agent is fixed once known: every record of the iteration must carry it.
        if (
          o.rolloutAgent &&
          s.settings.rolloutAgent &&
          o.rolloutAgent !== s.settings.rolloutAgent
        ) {
          throw new IterationError(
            `iteration ${s.iterationId} runs its rollouts as agent ${s.settings.rolloutAgent}; a different --rollout-agent would make its records incomparable`,
            4,
          );
        }
        // The gate path is the owner's choice at creation (06 §5.4); a resume cannot change it.
        if (
          o.safetyFixTargets &&
          [...new Set(o.safetyFixTargets)].sort().join(',') !==
            (s.settings.safetyFixTargets ?? []).join(',')
        ) {
          throw new IterationError(
            `iteration ${s.iterationId} was created ${s.settings.safetyFixTargets?.length ? `with --safety-fix ${s.settings.safetyFixTargets.join(',')}` : 'on the standard path'}; the gate path is fixed at creation`,
            4,
          );
        }
        if (o.rolloutAgent && !s.settings.rolloutAgent) s.settings.rolloutAgent = o.rolloutAgent;
        // Before anything a submitted file could reach: drifted inputs refuse the resume.
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
        if (o.safetyFixTargets?.length) {
          const replay = new Set(
            loadTasks(o.benchDir)
              .tasks.filter(
                (t) =>
                  t.spec.kind === 'replay' && t.spec.split === 'val' && t.spec.state === 'active',
              )
              .map((t) => t.id),
          );
          const unknown = o.safetyFixTargets.filter((t) => !replay.has(t));
          if (unknown.length > 0)
            throw new IterationError(
              `--safety-fix: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not an active val replay task (active: ${[...replay].sort().join(', ') || 'none'})`,
              2,
            );
        }
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
      if (submitted) checkSubmission(c, submitted);
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

// ---- dry run ----------------------------------------------------------------------------------

const EXTERNAL_PLAN =
  'external agent: no request; stops as awaiting-agent (exit 5) until its output is handed in';

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
  if (config.roles.frontier.external || config.roles.small.external) {
    lines.push(
      `rollouts: external agent ${s?.settings.rolloutAgent ?? o.rolloutAgent ?? '(pass --rollout-agent <id>)'} (06 §4.9): each rollout step serves its rollouts from this process and writes a manifest; no request, no quota`,
    );
  }
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
      what = isExternalRole(config, 'maintainer')
        ? EXTERNAL_PLAN
        : `≤ ${(s?.settings.agentMaxSteps.maintainer ?? DEFAULT_AGENT_MAX_STEPS.maintainer) + 2} request(s) on ${entryForRole(config, 'maintainer').id}`;
    if (step === 'baseline')
      what = `${val.length * models * runs} rollout(s) unless a sealed baseline of this identity exists`;
    if (step === 'proposer')
      what = isExternalRole(config, 'proposer')
        ? EXTERNAL_PLAN
        : `≤ ${(s?.settings.agentMaxSteps.proposer ?? DEFAULT_AGENT_MAX_STEPS.proposer) + 2} request(s) on ${entryForRole(config, 'proposer').id}`;
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
