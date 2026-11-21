import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelsConfigSchema, type TaskSpec } from '../../schema/bench';
import { loadEvaluationRecords } from './records';

/** Activates pending tasks (06 §4.1): a task joins gating only once a recorded baseline covers it
 * on every gate model. Flips `"state": "pending"` to `"active"` in task.json, nothing else. */
export function activateTasks(o: {
  benchDir: string;
  wikiRoot: string;
  taskIds: readonly string[];
}): { activated: string[]; refused: { task: string; reason: string }[] } {
  const config = ModelsConfigSchema.parse(
    JSON.parse(readFileSync(join(o.benchDir, 'models.json'), 'utf8')),
  );
  const gateModels = [config.roles.frontier.id, config.roles.small.id];
  const baselines = loadEvaluationRecords(o.wikiRoot).filter((r) => r.role === 'baseline');
  const activated: string[] = [];
  const refused: { task: string; reason: string }[] = [];
  for (const id of o.taskIds) {
    const file = join(o.benchDir, 'tasks', id, 'task.json');
    if (!existsSync(file)) {
      refused.push({ task: id, reason: 'no such task' });
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const spec = JSON.parse(text) as TaskSpec;
    if (spec.state !== 'pending') {
      refused.push({ task: id, reason: `state is ${spec.state}, not pending` });
      continue;
    }
    const missing = gateModels.filter(
      (m) => !baselines.some((r) => r.outcomes.some((x) => x.task === id && x.model === m)),
    );
    if (missing.length > 0) {
      refused.push({ task: id, reason: `no recorded baseline on ${missing.join(', ')}` });
      continue;
    }
    const next = text.replace(/"state":\s*"pending"/, '"state": "active"');
    writeFileSync(file, next);
    activated.push(id);
  }
  return { activated, refused };
}
