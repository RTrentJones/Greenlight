import { EvidenceRefSchema } from '@rtrentjones/greenlight-shared';
import { z } from 'zod';
import { IsoDate, KebabSlug, RemediationSchema } from './common';

/**
 * Wiki page frontmatter (vision 08 §3, roadmap M0-06). `affects` + `relevance` replace the old
 * `applies` range, so a lesson about app code still surfaces on a framework that fixed its own
 * half; decision and contract pages carry `skills[]` so LR-11 back-links hold for every cited page.
 */

export const PAGE_TYPES = [
  'pattern',
  'fact',
  'decision',
  'incident',
  'contract',
  'intent',
  'liveness',
  'tool-decisions',
] as const;

export const PATTERN_CLASSES = [
  'proxy-check',
  'artifact-identity',
  'free-tier-physics',
  'env-drift',
  'capability-regression',
  'iac-hazard',
  'spec-validity',
  'alert-suppression',
] as const;

/** `<type>/<slug>`, optionally nested by tool for project pages (`intent/bamcp`, `tools/x/...`). */
const PageId = z
  .string()
  .regex(/^[a-z-]+\/[a-z0-9][a-z0-9/-]*$/, 'page id must be "<type>/<slug>"');

const base = {
  id: PageId,
  title: z.string().min(1),
  updated: IsoDate,
  status: z.enum(['hypothesis', 'confirmed', 'superseded', 'archived']),
  supersededBy: PageId.optional(),
};

const CatchSpecSchema = z
  .object({
    description: z.string().min(1),
    checkSignature: z.string().min(1).optional(),
    graderTask: z.string().min(1).optional(),
  })
  .strict();

export const PatternPageSchema = z
  .object({
    ...base,
    type: z.literal('pattern'),
    kind: z.enum(['failure', 'strategy']),
    // Open set (LR-07 warns on unknown values), so any slug is accepted here.
    class: KebabSlug,
    atRisk: z.string().min(1),
    probed: z.string().min(1).optional(),
    cells: z
      .array(z.string().regex(/^[a-z*]+\/[a-z*]+\/[a-z*]+$/, 'cell must be "lane/target/data"'))
      .min(1),
    affects: z.string().min(1).optional(),
    relevance: z.enum(['framework-version', 'app-code', 'both']),
    evidence: z.array(EvidenceRefSchema),
    catches: CatchSpecSchema.optional(),
    remediation: z.array(RemediationSchema),
    skills: z.array(KebabSlug),
  })
  .strict();

const QuotaSchema = z
  .object({
    key: KebabSlug,
    label: z.string().min(1),
    limit: z.number().nonnegative(),
    unit: z.string().min(1),
    scope: z.enum(['account', 'project', 'database', 'worker']),
    usage: z
      .object({
        kind: z.enum(['provider-api', 'graphql', 'none']),
        ref: z.string().min(1),
        returns: z.literal('QuotaObservation[]'),
      })
      .strict()
      .optional(),
  })
  .strict();

export const FactPageSchema = z
  .object({
    ...base,
    type: z.literal('fact'),
    provider: KebabSlug,
    verified: IsoDate,
    source: z.array(z.string().url()).min(1),
    cardRequired: z.boolean(),
    idle: z.enum(['pauses', 'scales-to-zero', 'reclaimed', 'unaffected']),
    quotas: z.array(QuotaSchema),
  })
  .strict();

export const DecisionPageSchema = z
  .object({
    ...base,
    type: z.literal('decision'),
    decided: IsoDate,
    scope: z.array(z.string().min(1)),
    skills: z.array(KebabSlug),
  })
  .strict();

export const IncidentPageSchema = z
  .object({
    ...base,
    type: z.literal('incident'),
    tool: KebabSlug,
    opened: IsoDate,
    closed: IsoDate.optional(),
    evidence: z.array(EvidenceRefSchema),
    patterns: z.array(PageId),
    timeline: z.array(
      z
        .object({ date: IsoDate, text: z.string().min(1), evidence: EvidenceRefSchema.optional() })
        .strict(),
    ),
  })
  .strict();

export const ContractPageSchema = z
  .object({
    ...base,
    type: z.literal('contract'),
    clause: z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']),
    lanes: z.array(z.string().min(1)).min(1),
    enforcedBy: z.array(RemediationSchema),
    skills: z.array(KebabSlug),
  })
  .strict();

export const CriterionSchema = z
  .object({
    id: z.string().regex(/^AC-\d+$/, 'criterion id must be "AC-<n>"'),
    text: z.string().min(1),
    source: z.enum(['kickoff', 'feedback', 'incident']),
    added: IsoDate,
    checks: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'check id must be kebab-case')),
  })
  .strict();

export const IntentPageSchema = z
  .object({
    ...base,
    type: z.literal('intent'),
    tool: KebabSlug,
    criteria: z.array(CriterionSchema),
  })
  .strict();

export const LivenessPageSchema = z
  .object({
    ...base,
    type: z.literal('liveness'),
    tool: KebabSlug,
    model: z.enum(['needs-traffic', 'needs-silence', 'needs-heal', 'always-on']),
    atRisk: z.string().min(1),
    probe: z.string().min(1).optional(),
    quotas: z.array(z.string().min(1)),
  })
  .strict();

export const ToolDecisionsPageSchema = z
  .object({ ...base, type: z.literal('tool-decisions'), tool: KebabSlug })
  .strict();

const rawPage = z.discriminatedUnion('type', [
  PatternPageSchema,
  FactPageSchema,
  DecisionPageSchema,
  IncidentPageSchema,
  ContractPageSchema,
  IntentPageSchema,
  LivenessPageSchema,
  ToolDecisionsPageSchema,
]);

/** Any page's frontmatter, with the cross-field rules every type shares:
 * - `supersededBy` is required iff `status` is `superseded`;
 * - a `confirmed` failure pattern needs ≥1 evidence, a `catches`, and ≥1 verified remediation (LR-05);
 * - `probed` only describes failures. */
export const PageSchema = rawPage.superRefine((p, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if ((p.status === 'superseded') !== (p.supersededBy !== undefined)) {
    issue('supersededBy', 'supersededBy is required iff status is "superseded"');
  }
  if (p.type === 'pattern') {
    if (p.kind === 'strategy' && p.probed !== undefined)
      issue('probed', 'probed applies only to failure patterns');
    if (p.relevance === 'framework-version' && p.affects === undefined) {
      issue('affects', 'relevance "framework-version" needs an affects range');
    }
    if (p.status === 'confirmed' && p.kind === 'failure') {
      if (p.evidence.length === 0)
        issue('evidence', 'a confirmed failure pattern needs evidence (LR-05)');
      if (!p.catches) issue('catches', 'a confirmed failure pattern needs catches (LR-05)');
      if (!p.remediation.some((r) => r.verified)) {
        issue('remediation', 'a confirmed failure pattern needs a verified remediation (LR-05)');
      }
    }
  }
});

export type Page = z.infer<typeof rawPage>;
export type PatternPage = z.infer<typeof PatternPageSchema>;
export type IntentPage = z.infer<typeof IntentPageSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
