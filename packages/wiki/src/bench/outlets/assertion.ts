import { z } from 'zod';
import { KebabSlug } from '../../schema/common';
import { errMsg, issues } from './helpers';

// ---- verify assertions ----------------------------------------------------------------------

const AssertionCheckSchema = z
  .object({ id: KebabSlug, path: z.string().startsWith('/') })
  .passthrough()
  .refine((c) => !('logsOnFailure' in c), 'a check may not carry a command');

/** The proposed verify assertion: `api` checks only (JSON data, no command). */
const AssertionInputSchema = z.union([
  AssertionCheckSchema,
  z.array(AssertionCheckSchema).min(1),
  z.object({ mode: z.literal('api'), checks: z.array(AssertionCheckSchema).min(1) }).strict(),
]);

export interface AssertionSpec {
  id: string;
  mode: 'api';
  checks: (z.infer<typeof AssertionCheckSchema> & Record<string, unknown>)[];
}

/** The first fenced block whose info string is `json verify` (or `verify`) in an issue body. */
export function extractAssertion(body: string): string | null {
  const m = /^```[ \t]*(?:json[ \t]+)?verify[ \t]*\r?\n([\s\S]*?)^```/m.exec(body);
  return m ? (m[1] as string) : null;
}

export function parseAssertion(text: string): AssertionSpec | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON: ${errMsg(e)}` };
  }
  const r = AssertionInputSchema.safeParse(json);
  if (!r.success) return { error: issues(r.error) };
  type Check = z.infer<typeof AssertionCheckSchema>;
  const d = r.data as Check | Check[] | { mode: 'api'; checks: Check[] };
  const checks: Check[] = Array.isArray(d)
    ? d
    : 'mode' in d && !('path' in d)
      ? (d.checks as Check[])
      : [d as Check];
  const ids = checks.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return { error: `check id "${dup}" appears twice` };
  return { id: 'proposed-assertion', mode: 'api', checks: checks as AssertionSpec['checks'] };
}
