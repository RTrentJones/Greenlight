import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { redact } from '../../redact';
import type { GateResult, LedgerEvent, MaintainerOutput } from '../../schema';
import {
  type EvaluationRecord,
  EvaluationRecordSchema,
  evalEvidencePath,
} from '../../schema/bench';
import { loadTasks } from '../check-graders';
import { twoThirds } from '../policy';
import { treeDiff } from '../sandbox';
import { type Ctx, type StepOutcome, ledgerEvents, readSplits } from './context';
import { iterationDir, loadIterationState } from './state';
import type { CandidateState, DecisionSummary, IterationState } from './types';

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

/** One maintainer-graded task on one model in an evaluation record. */
export interface MaintainerGrade {
  task: string;
  model: string;
  passed: number;
  runs: number;
  /** At least ⌈2R/3⌉ of R, the gate's own bar for a task a baseline passes (06 §5.4). */
  passing: boolean;
}

/**
 * How the maintainer role scored on the bench's maintainer-graded tasks in one evaluation (06
 * §10.2 step 2). The iteration's own maintainer pass runs on the real wiki, which has no reference
 * output and so cannot be graded; these tasks give the same role and skills the fixed inputs a
 * grader can judge, among them the 06 §10.1 wiki state.
 */
export function maintainerGrades(record: EvaluationRecord): MaintainerGrade[] {
  const graded = new Set(
    record.identity.tasks.filter((t) => t.graders.includes('maintainer')).map((t) => t.id),
  );
  const by = new Map<string, MaintainerGrade>();
  for (const o of record.outcomes) {
    if (!graded.has(o.task)) continue;
    const k = `${o.task}\u0000${o.model}`;
    const g = by.get(k) ?? { task: o.task, model: o.model, passed: 0, runs: 0, passing: false };
    g.runs += 1;
    g.passed += o.score;
    by.set(k, g);
  }
  return [...by.values()]
    .map((g) => ({ ...g, passing: g.passed >= twoThirds(g.runs) }))
    .sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model));
}

function readRecord(wikiRoot: string, hash: string | undefined): EvaluationRecord | undefined {
  if (!hash) return undefined;
  const file = join(wikiRoot, evalEvidencePath(hash));
  if (!existsSync(file)) return undefined;
  try {
    const r = EvaluationRecordSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** The graded-maintainer lines of the hand-off. A held-out task is never named (06 §1.4): its
 * results are given per model, as totals and as a count of tasks the baseline passes. */
function maintainerGradeLines(
  s: IterationState,
  c: HandoffCtx,
  heldOut: ReadonlyMap<string, string>,
): string[] {
  const rows: string[] = [];
  for (const [label, hash] of [
    ['train', s.train.record],
    ['baseline', s.baseline.record],
  ] as const) {
    const record = readRecord(c.wikiRoot, hash);
    if (!record) continue;
    const grades = maintainerGrades(record);
    const open = grades.filter((g) => !heldOut.has(g.task));
    for (const task of [...new Set(open.map((g) => g.task))]) {
      rows.push(
        `  - ${label}, \`${task}\`: ${open
          .filter((g) => g.task === task)
          .map((g) => `${g.model} ${g.passed}/${g.runs}`)
          .join(', ')}`,
      );
    }
    const held = grades.filter((g) => heldOut.has(g.task));
    const tasks = [...new Set(held.map((g) => g.task))];
    if (tasks.length === 0) continue;
    rows.push(
      `  - ${label}, ${countTasks(tasks, heldOut)}: ${[...new Set(held.map((g) => g.model))]
        .map((model) => {
          const own = held.filter((g) => g.model === model);
          const sum = (f: (g: MaintainerGrade) => number) => own.reduce((n, g) => n + f(g), 0);
          return `${model} ${sum((g) => g.passed)}/${sum((g) => g.runs)} (${own.filter((g) => g.passing).length} of ${own.length} task(s) passing)`;
        })
        .join(', ')}`,
    );
  }
  if (rows.length === 0) return [];
  return [
    "- graded: the pass above runs on the real wiki, which has no reference output, so it is not graded. The same role and skills are graded on the bench's maintainer tasks (06 §10.2 step 2); a task is passing at ⌈2R/3⌉ of R runs:",
    ...rows,
  ];
}

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
    out.push(
      `- decision: \`${cand.decision.decision}\` (exact stratified permutation test, algorithm ${cand.decision.algorithm ?? 1}, 06 §5.2)`,
    );
    if (cand.decision.decision === 'blocked' || cand.decision.decision === 'underpowered')
      out.push(
        '',
        cand.decision.decision === 'blocked'
          ? '> **No decision: the baseline is not gateable.** A replay task is flaky in the baseline at high blast radius (06 §5.4). This says nothing about the candidate: fix or quarantine the task named below, re-baseline, and gate again. Nothing was written to the ledger.'
          : "> **No decision: the gate is underpowered here.** No candidate outcome could reach the significance level on this skill's bench slice (06 §5.2), so neither an accept nor a rejection would mean anything. Add objective tasks that exercise the skill (or runs), then gate again. Nothing was written to the ledger.",
      );
    const nonRegression = cand.decision.reasons.filter((r) => r.code === 'non-regression-set');
    if (nonRegression.length > 0)
      out.push(
        '',
        "Non-regression is tested over every objective task of the split, which the capability columns below (the patched skill's own tasks) do not show:",
        '',
        ...nonRegression.map((r) => `- ${r.model} / ${r.mode}: ${r.detail}`),
      );
    const vacuous = cand.decision.reasons.filter((r) => r.code === 'safety-vacuous');
    if (vacuous.length > 0)
      out.push(
        '',
        `> **Replay safety is vacuous** on ${vacuous.map((r) => `${r.model}/${r.mode}`).join(', ')}: no replay task is baseline-passing there, so "no regression" proves nothing (06 §5.4).`,
      );
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

  // `blocked` / `underpowered` (06 §5.2, §5.4): the gate ran and made no decision.
  const made = cand?.decision?.decision;
  const noDecision = made === 'blocked' || made === 'underpowered' ? made : undefined;
  const stage = e?.stage ?? (noDecision ? `no decision: ${noDecision}` : '(not recorded yet)');
  lines.push(`Greenlight evolution loop, iteration \`${s.iterationId}\` (vision 06 §1.3).`, '');
  lines.push(`**Outcome:** \`${stage}\`${e?.reason ? ` — ${e.reason}` : ''}`, '');
  if (s.evaluate.kind === 'skill' && p && (p.action === 'patch' || p.action === 'create')) {
    kind = 'pr';
    const accepted = e?.stage === 'candidate-accepted';
    draft = !accepted;
    branch = `evo/${s.proposer.proposalId}`;
    const what = p.action === 'create' ? 'new skill' : `${p.edits.length} edit(s)`;
    title = `evo(${p.name}): ${what} citing ${p.patterns.join(', ')} [${s.proposer.proposalId}]`;
    if (noDecision)
      lines.push(
        '> The gate made no decision on this candidate: it is neither accepted nor rejected, and it has no ledger row. The PR documents the change and what blocks the gate; do not merge it.',
        '',
      );
    else if (!accepted)
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
  if (m.source === 'external')
    lines.push(`- produced by: external agent \`${m.agent ?? '(not handed in yet)'}\``);
  if (m.indexCorrections?.length)
    lines.push(`- index corrections: ${m.indexCorrections.join('; ')}`);
  lines.push(...maintainerGradeLines(s, c, heldOut));
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
        `- expected: \`${item.expect.decision}\` for \`${item.expect.reason}\` on ${countTasks([item.expect.task], heldOut)} → ${item.expectMet === undefined ? 'not evaluated yet' : item.expectMet ? '**met** (`rejectedForReplayRegression`)' : item.outcome === 'inconclusive' ? '**inconclusive**: the gate could not have rejected for this regression (no decision, or the task fails in the baseline so it cannot regress); the control shows nothing about the gate until the baseline passes that task (06 §10.3)' : '**NOT met**: the gate did not refuse the plausible but wrong lesson (06 §10.3)'}`,
        '',
      );
    }
  }

  const cost = iterationCost(s, events);
  // A role done by an external agent has no request, quota or spend event of the harness's: the
  // table says so, and by whom, instead of showing nothing for it.
  const external = (['maintainer', 'proposer'] as const).filter((r) => s[r].source === 'external');
  lines.push('### Cost', '');
  if (cost.length === 0 && external.length === 0)
    lines.push('_No spend recorded (cached evidence only)._');
  else {
    lines.push('| model | requests | rollouts | tokens in | tokens out |', '|---|---|---|---|---|');
    for (const x of cost)
      lines.push(`| ${x.model} | ${x.requests} | ${x.rollouts} | ${x.tokensIn} | ${x.tokensOut} |`);
    for (const r of external)
      lines.push(
        `| ${r}: external agent \`${s[r].agent ?? '(not handed in yet)'}\` (not called by the harness; no quota, no spend event) | — | — | — | — |`,
      );
  }
  lines.push('');
  if (s.notes.length) lines.push('### Notes', '', ...s.notes.map((n) => `- ${n}`), '');
  lines.push('### Review', '');
  if (s.review) {
    lines.push(
      `Reviewed ${s.review.ts}${s.review.by ? ` by ${s.review.by}` : ''}: **${s.review.decision}** — ${s.review.reason}`,
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

export function stepHandoff(c: Ctx): StepOutcome {
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
