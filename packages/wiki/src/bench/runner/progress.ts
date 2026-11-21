import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BaselineIdentitySchema, type EvaluationRecord } from '../../schema/bench';
import { loadEvaluationRecords } from './records';

// ---------------------------------------------------------------------------------------------
// progress (resume)

const OutcomeArray = z.array(z.unknown());
export const ProgressSchema = z
  .object({
    v: z.literal(1),
    evaluationId: z.string().min(1),
    startedAt: z.string(),
    identity: BaselineIdentitySchema,
    selection: z
      .object({
        split: z.enum(['train', 'val', 'test']),
        role: z.enum(['train', 'baseline', 'candidate']),
        proposalId: z.string().optional(),
        tasks: z.array(z.string()),
        models: z.array(z.string()),
        runs: z.number().int().min(1),
        mode: z.literal('isolation'),
        sandbox: z.enum(['docker', 'process']),
      })
      .strict(),
    outcomes: OutcomeArray,
    rawIds: z.array(z.string()),
    problems: z.array(z.object({ key: z.string(), kind: z.string(), message: z.string() })),
    status: z.string(),
    /** Set with `status: complete`: the sealed EvaluationRecord, so a caller that crashed between
     * the seal and its own save finds it (`sealedRecordFor`). */
    recordHash: z.string().optional(),
  })
  .strict();
export type Progress = z.infer<typeof ProgressSchema>;
export type Outcome = EvaluationRecord['outcomes'][number];

export const progressPath = (stateDir: string, evaluationId: string) =>
  join(stateDir, 'bench', 'runs', evaluationId, 'progress.json');

export function saveProgress(stateDir: string, p: Progress): void {
  const file = progressPath(stateDir, p.evaluationId);
  mkdirSync(join(file, '..'), { recursive: true });
  // Written whole or not at all: a kill mid-write must not leave a truncated file, because a
  // resume reads this to know which graded rollouts it already holds.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * The sealed record of a COMPLETE evaluation, else undefined. A complete evaluation cannot be
 * resumed (a usage error), so a caller whose own state missed the seal (a crash between the seal
 * and its save) loads the record instead: by the progress file's `recordHash`, or, for a progress
 * file from before it, the record of the same role and proposal holding exactly its raw ids.
 */
export function sealedRecordFor(
  stateDir: string,
  wikiRoot: string,
  evaluationId: string,
): EvaluationRecord | undefined {
  const file = progressPath(stateDir, evaluationId);
  if (!existsSync(file)) return undefined;
  const parsed = ProgressSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success || parsed.data.status !== 'complete') return undefined;
  const p = parsed.data;
  const records = loadEvaluationRecords(wikiRoot);
  if (p.recordHash) return records.find((r) => r.hash === p.recordHash);
  const want = [...new Set(p.outcomes.map((x) => (x as { rawId?: string }).rawId))].sort();
  return records.find(
    (r) =>
      r.role === p.selection.role &&
      (r.proposalId ?? undefined) === p.selection.proposalId &&
      [...new Set(r.outcomes.map((x) => x.rawId))].sort().join('\n') === want.join('\n'),
  );
}
