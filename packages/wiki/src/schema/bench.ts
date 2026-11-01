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

const MODE_ORDER = ['isolation', 'production'] as const;
const TaskState = z.enum(['pending', 'active', 'quarantined']);

const ascending = (xs: readonly string[]): boolean =>
  xs.every((x, i) => i === 0 || (xs[i - 1] as string) < x);

/** True when `xs` is unique and in the order of `order` (the canonical list order). */
const inOrder = (xs: readonly string[], order: readonly string[]): boolean => {
  const canon = order.filter((o) => xs.includes(o));
  return canon.length === xs.length && canon.every((o, i) => xs[i] === o);
};

/**
 * One task as the baseline identity records it (08 §10.3): what the gate needs to know about the
 * task to exclude or gate it. Bound into the identity so a task's state, kind, modes or graders
 * cannot be changed by the gate's caller: a quarantine is a new identity, so a re-baseline
 * (06 §4.1). `modes` and `graders` are unique, in canonical order (MODE_ORDER, GRADER_KINDS).
 */
export const IdentityTaskSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(TASK_KINDS),
    state: TaskState,
    modes: z.array(Mode).min(1),
    graders: z.array(z.enum(GRADER_KINDS)).min(1),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!inOrder(t.modes, MODE_ORDER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modes'],
        message: `task ${t.id} modes are unique, in isolation, production order`,
      });
    }
    if (!inOrder(t.graders, GRADER_KINDS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['graders'],
        message: `task ${t.id} graders are unique, in GRADER_KINDS order (${GRADER_KINDS.join(', ')})`,
      });
    }
  });
export type IdentityTask = z.infer<typeof IdentityTaskSchema>;

/** The canonical identity projection of task specs: sorted by id, modes and graders in canonical
 * order. The runner fills `BaselineIdentity.tasks` with this. */
export function identityTasks(
  specs: readonly Pick<TaskSpec, 'id' | 'kind' | 'state' | 'modes' | 'graders'>[],
): IdentityTask[] {
  return [...specs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      state: t.state,
      modes: MODE_ORDER.filter((m) => t.modes.includes(m)),
      graders: GRADER_KINDS.filter((g) => t.graders.includes(g)),
    }));
}

export const BaselineIdentitySchema = z
  .object({
    taskSetHash: Sha256,
    /** The evaluated tasks with the fields the gate reads (sorted by id, unique). The gate asserts
     * that its task list equals this projection (06 §1.5, §4.1). */
    tasks: z.array(IdentityTaskSchema).min(1),
    splitsHash: Sha256,
    graderSetHash: Sha256,
    depsHash: Sha256,
    harness: z
      .object({
        runnerVersion: z.string().min(1),
        imageDigest: z.string().min(1),
        /** The rollout limits: a 10-step run says nothing about a 20-step one (06 §1.5). Absent
         * only in records written before the field existed, which then compare unequal to every
         * record that has it. `timeoutMin` null = each task's own `timeoutMin` (in taskSetHash). */
        limits: z
          .object({
            maxSteps: z.number().int().min(1),
            requestsPerRollout: z.number().int().min(1),
            timeoutMin: z.number().positive().nullable(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    agent: z.object({ vendor: z.string().min(1), version: z.string().min(1) }).strict(),
    models: z.array(z.string().min(1)).min(1),
    skillSetHash: Sha256,
    mode: Mode,
    wikiSnapshotHash: Sha256.nullable(),
    proxyPolicyHash: Sha256.nullable(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.mode === 'production' && b.wikiSnapshotHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['wikiSnapshotHash'],
        message: 'production mode needs a wikiSnapshotHash',
      });
    }
    if (!ascending(b.tasks.map((t) => t.id))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tasks'],
        message: 'tasks are sorted by id, unique',
      });
    }
  });

export type BaselineIdentity = z.infer<typeof BaselineIdentitySchema>;

/** Fields that differ between two identities. Two evaluations are comparable iff the only
 * difference is `skillSetHash` (vision 06 §1.5); anything else forces a re-baseline — including
 * `tasks`, so a change in any task's state, kind, modes or graders (e.g. a quarantine) does. */
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
    /** Set when a grader crashed (threw, timed out) instead of returning a verdict. The outcome
     * scores 0 and makes the evaluation invalid (`grader-error`), never a fail or a regression: a
     * broken grader says nothing about the skill. */
    graderError: z.string().min(1).optional(),
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
  .superRefine((o, ctx) => {
    if (o.score !== (o.graders.every((g) => g.passed) ? 1 : 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['score'],
        message: 'score is 1 iff every grader passed',
      });
    }
    if (o.graderError !== undefined && o.score !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['graderError'],
        message: 'an outcome with a graderError scores 0',
      });
    }
  });

export const EvaluationRecordSchema = z
  .object({
    hash: Sha256,
    identity: BaselineIdentitySchema,
    role: z.enum(['baseline', 'candidate', 'release-check', 'train']),
    proposalId: z.string().min(1).optional(),
    /** When the evaluation finished (ISO). The gate refuses a baseline older than
     * `maxBaselineAgeDays` (default 30) at the gate's ts (vision 06 §1.5, §5.1). */
    createdAt: IsoDateTime,
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

/** Where content-addressed evidence lives, relative to the wiki root (08 §10.4): evaluation
 * records and gate input records share `evidence/eval/<hash>.json`. */
export const EVAL_EVIDENCE_DIR = 'evidence/eval';
export const evalEvidencePath = (hash: string): string => `${EVAL_EVIDENCE_DIR}/${hash}.json`;

const Radius = z.enum(['high', 'medium', 'low']);
const GatePathEnum = z.enum(['standard', 'safety-fix', 'neutral']);
/**
 * Everything a gate decision depends on besides the EvaluationRecords it names (vision 06 §5.8,
 * 08 §10.4). Content-addressed and stored beside the records (`evidence/eval/<hash>.json`); the
 * ledger's bench or template evidence references it by `gateInput`. `bench gate --recompute
 * <hash>` needs this record plus the records it lists, and nothing else: no ctx, no task-file
 * order, no choice among several comparable baselines.
 */
export const GateInputRecordSchema = z
  .object({
    hash: Sha256,
    kind: z.literal('gate-input'),
    proposalId: z.string().min(1),
    /** The ledger event's ts; it seeds the eventId and the baseline-age check. */
    ts: IsoDateTime,
    outlet: z.enum(['skill', 'template']),
    radius: Radius,
    path: GatePathEnum,
    /** The bootstrap seed actually used (default `gate:<proposalId>`, or the caller's override). */
    seed: z.string().min(1),
    /** bench/gate.json as resolved, defaults filled in. */
    config: z
      .object({
        alpha: z.number().gt(0).lt(1),
        runs: z.number().int().min(1),
        resamples: z.number().int().min(1),
        acceptShorterOnTie: z.boolean(),
        maxBaselineAgeDays: z.number().int().min(1),
      })
      .strict(),
    models: z.object({ frontier: z.string().min(1), small: z.string().min(1) }).strict(),
    /** The modes evaluated, in isolation, production order. */
    modes: z.array(Mode).min(1),
    /** True when the caller declared `modes` explicitly (the M1/M2 isolation-only posture, 06 §5.1);
     * false when they are every mode the gated tasks declare. */
    modesDeclared: z.boolean(),
    /** The accepted skill set the baseline was run under; every baseline record carries it. */
    acceptedSkillSetHash: Sha256,
    candidateSkillSetHash: Sha256,
    /** The gated task list, sorted by id, with kind, state and resolved modes. */
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.enum(TASK_KINDS),
            state: TaskState,
            modes: z.array(Mode).min(1),
          })
          .strict(),
      )
      .min(1),
    /** One record hash per evaluated mode on each side, in mode order. */
    baselineRecords: z.array(Sha256).min(1),
    candidateRecords: z.array(Sha256).min(1),
    safetyFixTargets: z.array(z.string().min(1)).optional(),
    neutralReason: z.string().min(1).optional(),
    neutralPendingForSkill: z.boolean().optional(),
    skillLines: z
      .object({ before: z.number().int().min(0), after: z.number().int().min(0) })
      .strict()
      .optional(),
    skill: z.string().min(1).optional(),
    pattern: z.array(z.string().min(1)).optional(),
    control: z.boolean().optional(),
    /** Template outlet only (06 §5.6): generated-app test results per lane, and per mutant whether
     * those tests caught it. */
    template: z
      .object({
        lanes: z.array(z.object({ lane: z.string().min(1), passed: z.boolean() }).strict()),
        mutants: z.array(z.object({ id: z.string().min(1), caught: z.boolean() }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (g.hash !== contentHash(g as unknown as Record<string, unknown>, 'hash')) {
      issue('hash', 'hash must be the sha256 of the canonical JSON of the rest');
    }
    if (!ascending(g.tasks.map((t) => t.id))) issue('tasks', 'tasks are sorted by id, unique');
    for (const t of g.tasks) {
      const order = MODE_ORDER.filter((m) => t.modes.includes(m));
      if (order.length !== t.modes.length || order.some((m, i) => t.modes[i] !== m)) {
        issue('tasks', `task ${t.id} modes are unique, in isolation, production order`);
      }
    }
    const modes = MODE_ORDER.filter((m) => g.modes.includes(m));
    if (modes.length !== g.modes.length || modes.some((m, i) => g.modes[i] !== m)) {
      issue('modes', 'modes are unique, in isolation, production order');
    }
    if (
      g.baselineRecords.length !== g.modes.length ||
      g.candidateRecords.length !== g.modes.length
    ) {
      issue('baselineRecords', 'one baseline and one candidate record per evaluated mode');
    }
    if (g.acceptedSkillSetHash === g.candidateSkillSetHash) {
      issue('candidateSkillSetHash', 'the candidate skill set equals the accepted one');
    }
    if (g.safetyFixTargets && !ascending(g.safetyFixTargets)) {
      issue('safetyFixTargets', 'safetyFixTargets are sorted, unique');
    }
    if ((g.outlet === 'template') !== (g.template !== undefined)) {
      issue('template', 'template results are required iff the outlet is "template"');
    }
  });

export type GateInputRecord = z.infer<typeof GateInputRecordSchema>;

/** Builds a gate input record with its content hash filled in. */
export function sealGateInput(g: Omit<GateInputRecord, 'hash'>): GateInputRecord {
  return { ...g, hash: contentHash(g as Record<string, unknown>, 'hash') };
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
