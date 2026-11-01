import { EvidenceRefSchema } from '@rtrentjones/greenlight-shared';
import { z } from 'zod';
import { IsoDateTime, Outlet, Sha256, contentHash } from './common';

/**
 * The ledger (vision 08 §8, roadmap M0-04): append-only events, one per stage of a proposal's life,
 * written only by the harness. Gate evidence carries one result per model × mode, because the
 * policy table (06 §5.4) decides per model and mode.
 */

export const LEDGER_STAGES = [
  'no-action',
  'candidate-rejected',
  'candidate-accepted',
  'merged',
  'released',
  'verified-in-production',
  'withdrawn',
  'release-check',
  'spend',
] as const;

const Mode = z.enum(['isolation', 'production']);

export const GateResultSchema = z
  .object({
    model: z.string().min(1),
    mode: Mode,
    split: z.enum(['val', 'test']),
    runs: z.number().int().min(1),
    replay: z
      .object({
        total: z.number().int().min(0),
        baselinePassing: z.number().int().min(0),
        candidatePassing: z.number().int().min(0),
        regressions: z.array(z.string()),
      })
      .strict(),
    capability: z
      .object({
        before: z.number().min(0).max(1),
        after: z.number().min(0).max(1),
        delta: z.number().min(-1).max(1),
        pValue: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    decision: z.enum(['pass', 'fail']),
  })
  .strict();

export const EvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bench'),
      /** The GateInputRecord (08 §10.4) the decision was computed from. REQUIRED on candidate-*
       * events; absent on release-check events, which have no gate input. */
      gateInput: Sha256.optional(),
      /** Every EvaluationRecord the decision read, baseline and candidate, every mode, sorted. The
       * retention rule (03 §5) keeps each one as long as this row exists. */
      evaluationRecords: z.array(Sha256).min(1),
      results: z.array(GateResultSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('repro'),
      base: EvidenceRefSchema,
      candidate: EvidenceRefSchema,
      reproTask: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('template'),
      gateInput: Sha256,
      evaluationRecords: z.array(Sha256).min(1),
      /** The capability non-regression guard on cells using the template, one per model × mode. */
      results: z.array(GateResultSchema).min(1),
      lanes: z.array(z.string().min(1)).min(1),
      mutantsFailed: z.number().int().min(0),
      mutantsTotal: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact'),
      check: z.string().min(1),
      faulty: EvidenceRefSchema,
      fixed: EvidenceRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('field'),
      check: z.string().min(1),
      before: EvidenceRefSchema,
      after: EvidenceRefSchema,
    })
    .strict(),
]);

const LedgerEventObject = z
  .object({
    ts: IsoDateTime,
    writer: z.literal('harness'),
    eventId: Sha256,
    proposalId: z.string().min(1).optional(),
    stage: z.enum(LEDGER_STAGES),
    path: z.enum(['standard', 'safety-fix', 'neutral']).optional(),
    control: z.boolean().optional(),
    pattern: z.array(z.string().min(1)).optional(),
    skill: z.string().min(1).optional(),
    outlet: Outlet.optional(),
    change: z
      .object({
        kind: z.enum(['create', 'patch', 'pr', 'issue', 'no_action']),
        diff: z.string().optional(),
        ref: z.string().optional(),
      })
      .strict()
      .optional(),
    evidence: EvidenceSchema.optional(),
    reason: z.string().min(1).optional(),
    versionFrom: z.string().min(1).optional(),
    versionTo: z.string().min(1).optional(),
    release: z.string().min(1).optional(),
    spend: z
      .object({
        usd: z.number().min(0),
        rollouts: z.number().int().min(0),
        requests: z.number().int().min(0),
        tokensIn: z.number().int().min(0),
        tokensOut: z.number().int().min(0),
        evaluationId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const LedgerEventSchema = LedgerEventObject.superRefine((e, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  const unattached = e.stage === 'spend' || e.stage === 'release-check';
  if (!unattached && !e.proposalId) issue('proposalId', `stage "${e.stage}" needs a proposalId`);
  if (e.stage.startsWith('candidate-') && !e.path) issue('path', 'candidate events need a path');
  if ((e.stage === 'no-action' || e.stage === 'withdrawn' || e.path === 'neutral') && !e.reason) {
    issue('reason', `a ${e.path === 'neutral' ? 'neutral-path' : e.stage} event needs a reason`);
  }
  if (e.stage === 'spend' && !e.spend) issue('spend', 'a spend event needs spend');
  if (e.stage !== 'spend' && e.spend) issue('spend', 'only spend events carry spend');
  if (e.stage === 'released' && !e.release) issue('release', 'a released event names the release');
  if (e.stage === 'verified-in-production' && e.evidence?.kind !== 'field') {
    issue('evidence', 'verified-in-production needs field evidence');
  }
  if (
    e.stage.startsWith('candidate-') &&
    e.evidence?.kind === 'bench' &&
    e.evidence.gateInput === undefined
  ) {
    issue('evidence', 'candidate bench evidence names its gate input record');
  }
  if (e.control && (e.stage === 'merged' || e.stage === 'released')) {
    issue('control', 'a control-arm proposal is never merged or released');
  }
  if (e.eventId !== contentHash(e as unknown as Record<string, unknown>, 'eventId')) {
    issue('eventId', 'eventId must be the sha256 of the canonical JSON of the rest of the event');
  }
});

export type LedgerEvent = z.infer<typeof LedgerEventObject>;
export type GateResult = z.infer<typeof GateResultSchema>;

/** Outlets whose change reaches users only in a published CLI version (06 §3.5, §6.1): the
 * framework fix (mechanism), the doctor rule, and the skills and templates bundled with the CLI.
 * For these, `verified-in-production` follows `released`. The verify outlet's assertion lives in
 * the wrapper's verify spec and ships with the wrapper, never in a CLI release, so for it
 * `merged -> verified-in-production` is the path and `released` cannot occur. */
export const RELEASED_OUTLETS: ReadonlySet<string> = new Set([
  'mechanism',
  'doctor',
  'template',
  'skill',
]);

/** Stages that may follow each stage of one proposal (vision 06 §6.1). `withdrawn` can end any
 * accepted, merged, released or verified proposal; a rejected or no-action proposal is final. */
function nextStages(at: string, outlet: string | undefined): readonly string[] {
  switch (at) {
    case 'start':
      return ['no-action', 'candidate-rejected', 'candidate-accepted'];
    case 'candidate-accepted':
      return ['merged', 'withdrawn'];
    case 'merged':
      // An event list that names no outlet is treated as release-carried (the stricter reading).
      return outlet === 'verify'
        ? ['verified-in-production', 'withdrawn']
        : ['released', 'withdrawn'];
    case 'released':
      return ['verified-in-production', 'withdrawn'];
    case 'verified-in-production':
      return ['withdrawn'];
    default:
      return [];
  }
}

/** Checks that one proposal's events, in order, follow the stage machine (06 §6.1) and name at
 * most one outlet. Returns problems; empty for a well-formed history. */
export function checkProposalHistory(events: readonly LedgerEvent[]): string[] {
  const out: string[] = [];
  const outlets = [...new Set(events.flatMap((e) => (e.outlet ? [e.outlet] : [])))];
  if (outlets.length > 1) out.push(`events name more than one outlet (${outlets.join(', ')})`);
  const outlet = outlets[0];
  let at = 'start';
  for (const e of events) {
    if (!nextStages(at, outlet).includes(e.stage)) {
      const why =
        e.stage === 'released' && outlet === 'verify' ? ' (outlet verify has no CLI release)' : '';
      out.push(`stage "${e.stage}" cannot follow "${at}"${why}`);
    }
    at = e.stage;
  }
  return out;
}

/** Builds a harness event with its eventId filled in. */
export function sealEvent(e: Omit<LedgerEvent, 'eventId' | 'writer'>): LedgerEvent {
  const withWriter = { ...e, writer: 'harness' as const };
  return { ...withWriter, eventId: contentHash(withWriter as Record<string, unknown>, 'eventId') };
}
