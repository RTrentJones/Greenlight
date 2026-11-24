import type { EvaluationRecord, ModelsConfig } from '../../schema';
import { earlyStopEvent } from '../gate';
import type { PolicyTask } from '../policy';
import { type Ctx, type StepOutcome, evaluation, readGateCfg, stop } from './context';

// ---- step 3: baseline -------------------------------------------------------------------------

export const gateModels = (config: ModelsConfig) => ({
  frontier: config.roles.frontier.id,
  small: config.roles.small.id,
});

export const policyTasks = (r: EvaluationRecord): PolicyTask[] =>
  r.identity.tasks.map((t) => ({
    id: t.id,
    kind: t.kind,
    state: t.state,
    modes: [...t.modes],
    ...(t.skills ? { skills: [...t.skills] } : {}),
  }));

export async function stepBaseline(c: Ctx): Promise<StepOutcome> {
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
