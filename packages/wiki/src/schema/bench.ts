import { z } from 'zod';
import { IsoDateTime, KebabSlug, Sha256, contentHash } from './common';

/** Bench schemas (vision 08 §10, roadmap M0-03): tasks, trajectories, baseline identity,
 * evaluation records, budget and models. */

export const TASK_KINDS = [
  'capability',
  'replay',
  'loop',
  'wiki',
  'routing',
  'portfolio',
  'mechanism',
] as const;
export const GRADER_KINDS = ['app', 'trajectory', 'maintainer', 'routing', 'repro'] as const;
const Mode = z.enum(['isolation', 'production']);
const Split = z.enum(['train', 'val', 'test']);

const KIND_PREFIX: Record<(typeof TASK_KINDS)[number], string> = {
  capability: 'cap',
  replay: 'replay',
  loop: 'loop',
  wiki: 'wiki',
  routing: 'route',
  portfolio: 'port',
  mechanism: 'mech',
};

export const MatcherSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()).optional(),
    meta: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const TrajectoryRuleUnion = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('before'), first: MatcherSchema, next: MatcherSchema }).strict(),
  z
    .object({
      rule: z.literal('after'),
      trigger: MatcherSchema,
      next: MatcherSchema,
      within: z.number().int().min(1).optional(),
    })
    .strict(),
  z
    .object({ rule: z.literal('never'), match: MatcherSchema, unless: MatcherSchema.optional() })
    .strict(),
  z
    .object({
      rule: z.literal('count'),
      match: MatcherSchema,
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
    })
    .strict(),
]);

export const TrajectoryRuleSchema = TrajectoryRuleUnion.superRefine((r, ctx) => {
  if (r.rule !== 'count') return;
  if (r.min === undefined && r.max === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a count rule needs min or max' });
  }
  if (r.min !== undefined && r.max !== undefined && r.min > r.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'count min must be ≤ max' });
  }
});

export const TrajectoryEventSchema = z
  .object({
    seq: z.number().int().min(0),
    ts: IsoDateTime,
    source: z.enum(['shim', 'transcript']),
    cmd: z.string().min(1),
    argv: z.array(z.string()),
    cwd: z.string(),
    exit: z.number().int().optional(),
    meta: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const TaskSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z]+\/[a-z0-9][a-z0-9-]*$/, 'task id must be "<kind-prefix>/<slug>"'),
    kind: z.enum(TASK_KINDS),
    graders: z.array(z.enum(GRADER_KINDS)).min(1),
    cell: z
      .string()
      .regex(/^[a-z*]+\/[a-z*]+\/[a-z*]+$/)
      .optional(),
    skills: z.array(KebabSlug),
    fidelity: z.enum(['runtime', 'structural']),
    pattern: z.string().min(1).optional(),
    split: Split,
    state: z.enum(['pending', 'active', 'quarantined']),
    quarantineReason: z.string().min(1).optional(),
    timeoutMin: z.number().int().min(1),
    modes: z.array(Mode).min(1).default(['isolation', 'production']),
    trajectory: z
      .object({ rules: z.array(TrajectoryRuleSchema).min(1) })
      .strict()
      .optional(),
    routing: z
      .object({ expect: z.array(KebabSlug).min(1), forbid: z.array(KebabSlug) })
      .strict()
      .optional(),
    mutants: z
      .array(
        z
          .object({
            id: KebabSlug,
            grader: z.enum(GRADER_KINDS),
            description: z.string().min(1),
            kind: z.enum(['patch', 'tree', 'trajectory', 'maintainer-output']),
          })
          .strict(),
      )
      .min(1, 'every task ships with at least one mutant (06 §4.3)'),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const prefix = KIND_PREFIX[t.kind];
    if (!t.id.startsWith(`${prefix}/`)) issue('id', `a ${t.kind} task id starts with "${prefix}/"`);
    if (['capability', 'replay', 'loop'].includes(t.kind) && !t.cell)
      issue('cell', `a ${t.kind} task needs a cell`);
    if (['replay', 'mechanism'].includes(t.kind) && !t.pattern)
      issue('pattern', `a ${t.kind} task needs a pattern`);
    if (t.graders.includes('trajectory') !== (t.trajectory !== undefined)) {
      issue('trajectory', 'trajectory rules are required iff graders includes "trajectory"');
    }
    if (t.graders.includes('routing') !== (t.routing !== undefined)) {
      issue('routing', 'routing expectations are required iff graders includes "routing"');
    }
    if ((t.state === 'quarantined') !== (t.quarantineReason !== undefined)) {
      issue('quarantineReason', 'quarantineReason is required iff state is "quarantined"');
    }
    for (const g of new Set(t.graders)) {
      if (!t.mutants.some((m) => m.grader === g))
        issue('mutants', `grader "${g}" has no mutant (06 §4.3)`);
    }
    for (const m of t.mutants) {
      if (!t.graders.includes(m.grader))
        issue(
          'mutants',
          `mutant "${m.id}" targets grader "${m.grader}", which the task does not use`,
        );
    }
  });

export const BaselineIdentitySchema = z
  .object({
    taskSetHash: Sha256,
    splitsHash: Sha256,
    graderSetHash: Sha256,
    depsHash: Sha256,
    harness: z
      .object({ runnerVersion: z.string().min(1), imageDigest: z.string().min(1) })
      .strict(),
    agent: z.object({ vendor: z.string().min(1), version: z.string().min(1) }).strict(),
    models: z.array(z.string().min(1)).min(1),
    skillSetHash: Sha256,
    mode: Mode,
    wikiSnapshotHash: Sha256.nullable(),
    proxyPolicyHash: Sha256.nullable(),
  })
  .strict()
  .refine((b) => b.mode !== 'production' || b.wikiSnapshotHash !== null, {
    message: 'production mode needs a wikiSnapshotHash',
    path: ['wikiSnapshotHash'],
  });

export type BaselineIdentity = z.infer<typeof BaselineIdentitySchema>;

/** Fields that differ between two identities. Two evaluations are comparable iff the only
 * difference is `skillSetHash` (vision 06 §1.5); anything else forces a re-baseline. */
export function identityDiff(a: BaselineIdentity, b: BaselineIdentity): string[] {
  const keys = Object.keys(a) as (keyof BaselineIdentity)[];
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export function comparable(baseline: BaselineIdentity, candidate: BaselineIdentity): boolean {
  return identityDiff(baseline, candidate).every((k) => k === 'skillSetHash');
}

const OutcomeSchema = z
  .object({
    task: z.string().min(1),
    run: z.number().int().min(1),
    model: z.string().min(1),
    mode: Mode,
    score: z.union([z.literal(0), z.literal(1)]),
    graders: z
      .array(
        z
          .object({
            kind: z.enum(GRADER_KINDS),
            passed: z.boolean(),
            detail: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    seed: z.string().min(1),
    rawId: z.string().min(1),
    durationMs: z.number().int().min(0),
    /** The model that actually served the rollout; a fallback-served rollout is invalid for gating
     * (vision 06 §4.8). */
    servedBy: z.string().min(1),
    cost: z
      .object({
        usd: z.number().min(0),
        requests: z.number().int().min(0),
        tokensIn: z.number().int().min(0),
        tokensOut: z.number().int().min(0),
      })
      .strict(),
  })
  .strict()
  .refine((o) => o.score === (o.graders.every((g) => g.passed) ? 1 : 0), {
    message: 'score is 1 iff every grader passed',
    path: ['score'],
  });

export const EvaluationRecordSchema = z
  .object({
    hash: Sha256,
    identity: BaselineIdentitySchema,
    role: z.enum(['baseline', 'candidate', 'release-check', 'train']),
    proposalId: z.string().min(1).optional(),
    outcomes: z.array(OutcomeSchema),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.role === 'candidate' && !r.proposalId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposalId'],
        message: 'a candidate record names its proposal',
      });
    }
    if (r.hash !== contentHash(r as unknown as Record<string, unknown>, 'hash')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hash'],
        message: 'hash must be the sha256 of the canonical JSON of the rest',
      });
    }
    const seen = new Set<string>();
    for (const o of r.outcomes) {
      const k = `${o.task}|${o.run}|${o.model}|${o.mode}`;
      if (seen.has(k))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outcomes'],
          message: `duplicate outcome ${k}`,
        });
      seen.add(k);
    }
  });

export type EvaluationRecord = z.infer<typeof EvaluationRecordSchema>;

/** Builds a record with its content hash filled in. */
export function sealRecord(r: Omit<EvaluationRecord, 'hash'>): EvaluationRecord {
  return { ...r, hash: contentHash(r as Record<string, unknown>, 'hash') };
}

export const BudgetSchema = z
  .object({
    monthlyUsd: z.number().min(0),
    perGateMaxUsd: z.number().min(0),
    perGateMaxRollouts: z.number().int().min(1),
    perGateMaxRequests: z.number().int().min(1),
    splitAcrossDays: z.boolean(),
  })
  .strict();

const ModelEntrySchema = z
  .object({
    id: z.string().min(1),
    fallback: z.string().min(1).optional(),
    limits: z
      .object({
        rpm: z.number().int().min(1),
        rpd: z.number().int().min(1),
        tpm: z.number().int().min(1).optional(),
      })
      .strict(),
    priceUsdPerMTok: z
      .object({ input: z.number().min(0), output: z.number().min(0) })
      .strict()
      .optional(),
  })
  .strict();

export const ModelsConfigSchema = z
  .object({
    provider: z.enum(['gemini', 'anthropic', 'openai']),
    keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    roles: z
      .object({
        frontier: ModelEntrySchema,
        small: ModelEntrySchema,
        maintainer: z.enum(['frontier', 'small']),
        proposer: z.enum(['frontier', 'small']),
        judge: z.enum(['frontier', 'small']),
      })
      .strict(),
    temperature: z.number().min(0).max(2),
  })
  .strict()
  .refine((m) => m.roles.frontier.id !== m.roles.small.id, {
    message: 'the gate pair must be two different models (06 §5.3)',
    path: ['roles', 'small', 'id'],
  });

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;
export type TrajectoryRule = z.infer<typeof TrajectoryRuleSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
