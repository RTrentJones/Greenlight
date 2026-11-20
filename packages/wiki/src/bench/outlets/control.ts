import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { KebabSlug } from '../../schema/common';
import { ProposerOutputSchema } from '../../schema/io';

// ---- control arm (06 §10.2 step 4; roadmap M2-03) -------------------------------------------

/** `bench/controls/<id>.json`: a hand-written proposal the harness evaluates beside the real one,
 * labelled `control` in the ledger and never merged. `expect` states why it must be rejected. */
export const ControlArmSchema = z
  .object({
    control: z.literal(true),
    id: KebabSlug,
    description: z.string().min(1),
    /** The overgeneral rule it encodes, and the pair rule (bench/pairs) that grades it. */
    statement: z.string().min(1),
    pair: z.object({ id: KebabSlug, rule: KebabSlug }).strict(),
    expect: z
      .object({
        decision: z.literal('reject'),
        reason: z.literal('replay-regression'),
        task: z.string().min(1),
      })
      .strict(),
    proposal: ProposerOutputSchema,
  })
  .strict();
export type ControlArm = z.infer<typeof ControlArmSchema>;

export function loadControlArm(file: string): ControlArm {
  return ControlArmSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
