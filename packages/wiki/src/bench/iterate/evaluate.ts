import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { checkProposalContent } from '../../bundle';
import { loadWiki } from '../../load';
import { applyFilePatches, writeChangeset } from '../../patch';
import { LedgerEventSchema, type ProposerOutput, SKILL_NAME_RE } from '../../schema';
import type { EvaluationRecord } from '../../schema/bench';
import { canonicalJson } from '../../schema/common';
import { loadSkills } from '../../skills';
import {
  type GateDecision,
  GateHarnessError,
  baselinePrecheck,
  controlOutcome,
  decide,
  rejectedForReplayRegression,
} from '../gate';
import { skillSetHashOf } from '../identity';
import {
  type ControlArm,
  type OutletResult,
  type OutletTreeRef,
  evaluateOutlet as defaultEvaluateOutlet,
  loadControlArm,
  safeGit,
  treeContentHash,
} from '../outlets';
import type { BlastRadius } from '../policy';
import { gateModels, policyTasks } from './baseline';
import {
  type Ctx,
  type StepOutcome,
  bindingProblem,
  blastRadius,
  evaluation,
  readGateCfg,
  readIf,
  recordByHash,
  stop,
} from './context';
import { assertOutsideSkills } from './state';
import {
  type CandidateState,
  type DecisionSummary,
  IterationError,
  type IterationState,
  type PinnedTree,
} from './types';

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

const skillText = (dir: string, skill: string): string =>
  readIf(join(dir, skill, 'SKILL.md')) ?? '';

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
  const gateCfg = readGateCfg(o.benchDir);
  const gateCtxFor = (baseline: EvaluationRecord) => ({
    radius: cand.radius as BlastRadius,
    // The standard path, unless the OWNER created the iteration with --safety-fix (06 §5.4).
    // The safety-fix and neutral paths waive efficacy, so the proposer never chooses them
    // (ProposerOutput, 08 §9.2, has no path field), and a control arm is always held to the
    // standard path.
    ...gatePathFor(c.s.settings, meta.control === true),
    models: gateModels(c.config),
    tasks: policyTasks(baseline),
    // The M1/M2 posture (06 §5.1): isolation only, declared explicitly.
    modes: ['isolation' as const],
    config: {
      ...gateCfg,
      ...(c.s.settings.runs !== undefined ? { runs: c.s.settings.runs } : {}),
    },
    skill,
    outlet: 'skill' as const,
  });
  const boundBaseline = (): { record: EvaluationRecord } | { why: string } => {
    const record = recordByHash(o.wikiRoot, c.s.baseline.record as string);
    const why = bindingProblem(c, record, {
      role: 'baseline',
      split: 'val',
      skillSetHash: c.s.acceptedSkillSetHash,
    });
    return why
      ? { why: `the baseline record ${record.hash} is not this iteration's: ${why}` }
      : { record };
  };
  // 06 §5.2: power is checked before the rollouts are spent. What the baseline alone settles is
  // read first, and only while no candidate rollout exists: an evaluation already under way or
  // sealed is finished and decided by the gate itself. A baseline that is missing, unbound or
  // unreadable is not this check's to report; the steps below refuse it in their usual order.
  if (!cand.record && !cand.evaluationId && c.s.baseline.record) {
    let pre: ReturnType<typeof baselinePrecheck> = null;
    let path: GateDecision['path'] = 'standard';
    try {
      const b = boundBaseline();
      if ('record' in b) {
        const ctx = gateCtxFor(b.record);
        path = ctx.path;
        pre = baselinePrecheck(b.record, ctx);
      }
    } catch {
      pre = null;
    }
    // A control exists to be rejected for a replay regression, which needs no power, so only a
    // baseline that blocks every decision stops it.
    if (pre && (pre.decision === 'blocked' || !meta.control)) {
      cand.decision = {
        decision: pre.decision,
        path,
        reasons: pre.reasons,
        results: [],
        algorithm: pre.algorithm,
        baselineRecords: pre.baselineRecords,
        candidateRecords: [],
      };
      const why = pre.reasons.map((x) => `${x.code}${x.detail ? ` (${x.detail})` : ''}`).join('; ');
      cand.decisionStatus = 'done';
      cand.status = 'done';
      cand.message = `no decision (${pre.decision}), settled by the baseline before any candidate rollout: ${why}`;
      const note = `${meta.control ? 'control' : 'proposal'} ${cand.proposalId}: the baseline already rules out a decision (${pre.decision}); no candidate rollout was run and there is no ledger row`;
      if (!c.s.notes.includes(note)) c.s.notes.push(note);
      c.save();
      return { ok: true };
    }
  }
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
  const b = boundBaseline();
  if ('why' in b) {
    cand.status = 'failed';
    cand.message = b.why;
    return stop(c, step, 'failed', `${step}: ${cand.message}`, 4);
  }
  const baseline = b.record;
  const gateCtx = gateCtxFor(baseline);
  let d: GateDecision;
  try {
    d = (o.decide ?? decide)(baseline, r.record, {
      ts: cand.ts,
      ...gateCtx,
      acceptedSkillSetHash: c.s.acceptedSkillSetHash,
      skillText: { before: skillText(o.skillsDir, skill), after: skillText(dest, skill) },
      ...(meta.pattern ? { pattern: meta.pattern } : {}),
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
    algorithm: d.algorithm,
    baselineRecords: d.baselineRecords,
    candidateRecords: d.candidateRecords,
  };
  if (d.decision === 'blocked' || d.decision === 'underpowered') {
    // No decision (06 §5.2, §5.4): the baseline holds a flaky replay task, or the efficacy test
    // cannot reach alpha at this shape. Neither is a verdict on the candidate, and a re-run of
    // the same evaluation cannot change it, so nothing reaches the ledger and the iteration goes
    // on to the hand-off, which says what the owner has to fix.
    const why = d.reasons
      .filter((x) => x.severity === 'blocked')
      .map((x) => `${x.code}${x.detail ? ` (${x.detail})` : ''}`)
      .join('; ');
    cand.decisionStatus = 'done';
    cand.status = 'done';
    cand.message = `no decision (${d.decision}): ${why}`;
    const note = `${meta.control ? 'control' : 'proposal'} ${cand.proposalId}: the gate made no decision (${d.decision}); it has no ledger row`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.save();
    return { ok: true };
  }
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

export async function stepEvaluate(c: Ctx): Promise<StepOutcome> {
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
  // Suppression markers the candidate adds are the owner's to weigh (06 §5.6): noted, not judged.
  for (const n of result.notes ?? []) {
    const note = `${proposal.outlet} proposal ${proposalId}: ${n}`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
  }
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
 * Resolves an outlet tree once. A commit becomes its full sha, resolved in the HARNESS repository
 * (host git with `safeGit`). A directory is never opened with git: it is pinned by its content
 * hash (`treeContentHash`), which outlets.ts re-checks, so a directory changed after the pin is
 * refused on resume. A directory without an evidence ref, or with its own `.git`, is judged
 * `unpinned-tree` there.
 */
export function pinTree(repoRoot: string, t: OutletTreeRef, _sourceRepo: string): PinnedTree {
  if ('commit' in t) {
    try {
      const sha = safeGit(repoRoot, ['rev-parse', '--verify', `${t.commit}^{commit}`]);
      return { tree: { commit: sha }, key: `commit:${sha}` };
    } catch {
      // Never pinned literally: an unresolvable name would be re-resolved (to anything) later.
      throw new IterationError(`outlet tree ${t.commit} is not a commit of ${repoRoot}`, 2);
    }
  }
  const dir = resolve(t.dir);
  const hash = existsSync(dir) ? treeContentHash(dir) : 'absent';
  return {
    tree: { dir, ...(t.ref ? { ref: t.ref } : {}), hash },
    key: `dir:${dir}@sha256:${hash}${t.ref ? `#${t.ref}` : ''}`,
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

export async function stepControl(c: Ctx): Promise<StepOutcome> {
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
    // 06 §10.3: the control counts only when rejected for the reason it encodes. When the gate
    // could not have rejected for that reason (no decision, or the expected task fails in the
    // baseline so it cannot regress), the control is inconclusive, not failed.
    const expectsRegression =
      item.expect.decision === 'reject' && item.expect.reason === 'replay-regression';
    item.outcome = expectsRegression ? controlOutcome(d, item.expect.task) : 'not-met';
    item.expectMet = item.outcome === 'met';
    const how =
      item.outcome === 'met'
        ? 'rejected'
        : item.outcome === 'inconclusive'
          ? 'INCONCLUSIVE (the gate could not have rejected it)'
          : 'NOT rejected';
    const note = `control ${item.controlId}: ${how} for replay-regression on ${item.expect.task} (06 §10.3)`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.save();
  }
  return { ok: true };
}

/** The gate path of one candidate of an iteration (06 §5.4): safety-fix only for the proposal of
 * an iteration its owner created with `--safety-fix`, never for a control arm. */
export function gatePathFor(
  settings: Pick<IterationState['settings'], 'safetyFixTargets'>,
  control: boolean,
): { path: 'standard' } | { path: 'safety-fix'; safetyFixTargets: string[] } {
  return settings.safetyFixTargets?.length && !control
    ? { path: 'safety-fix', safetyFixTargets: settings.safetyFixTargets }
    : { path: 'standard' };
}
