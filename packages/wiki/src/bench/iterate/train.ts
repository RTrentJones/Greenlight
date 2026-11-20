import { type Ctx, type StepOutcome, evaluation, stop } from './context';
import { IterationError } from './types';

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

export async function stepTrain(c: Ctx): Promise<StepOutcome> {
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
