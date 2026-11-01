import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RawRecord, RawRecordSchema, sha256 } from '@rtrentjones/greenlight-shared';

/** Raw records for sampling and bundle tests. Every record is validated, so a fixture can never
 * drift from `RawRecordSchema`. */

export const SKILL_SET = 'a'.repeat(64);

export interface RecOpts {
  id: string;
  passed?: boolean;
  split?: 'train' | 'val' | 'test';
  task?: string;
  tool?: string;
  startedAt?: string;
  wikiHits?: string[];
  skill?: { name: string; version: string };
  excerpt?: string;
}

/** `id` is the 8-hex suffix; the timestamp part comes from `startedAt`. */
export function rec(o: RecOpts): RawRecord {
  const startedAt = o.startedAt ?? '2026-11-01T09:00:00Z';
  const ts = startedAt.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const excerpt = o.excerpt ?? `run ${o.id}: ${o.passed ? 'ok' : 'FAIL a check'}`;
  const bench = o.split !== undefined;
  const stamp = o.skill
    ? { [o.skill.name]: { version: o.skill.version, contentHash: SKILL_SET } }
    : {};
  return RawRecordSchema.parse({
    tool: o.tool ?? 'fixture-tool',
    env: bench ? 'bench' : 'prod',
    sourceRepo: 'owner/fixture',
    gitSha: null,
    dirty: false,
    wrapperRev: { sha: null, verifyConfigHash: null },
    runId: `run-${o.id}`,
    attempt: 1,
    skills: { installed: stamp, used: o.skill ? stamp : 'unknown' },
    rawId: `${ts}-${o.id}`,
    kind: bench ? 'bench' : 'verify',
    passed: o.passed ?? false,
    startedAt,
    durationMs: 1000,
    ...(bench
      ? {
          bench: {
            task: o.task ?? `replay/fixture-task-${o.split}`,
            split: o.split,
            model: 'model-a',
            mode: 'isolation',
            skillSetHash: SKILL_SET,
            evaluationId: 'eval-1',
            run: 1,
            seed: '1',
          },
        }
      : {}),
    refs: [],
    retained: {
      verdict: o.passed ? 'passed' : 'failed',
      excerpt,
      hashes: { excerpt: sha256(excerpt) },
      fetchedAt: startedAt,
    },
    ...(o.wikiHits ? { wikiHits: o.wikiHits } : {}),
  });
}

export function writeRaw(dir: string, records: readonly RawRecord[]): void {
  mkdirSync(dir, { recursive: true });
  for (const r of records) writeFileSync(join(dir, `${r.rawId}.json`), JSON.stringify(r, null, 2));
}
