import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Shared primitives for the knowledge-plane schemas (vision 08). */

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const Sha256 = z.string().regex(SHA256_RE, 'must be a sha256 hex digest');
export const KebabSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be kebab-case (lowercase letters, digits, hyphens)');
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');
export const IsoDateTime = z.string().datetime();

export const OUTLETS = ['mechanism', 'doctor', 'template', 'verify', 'skill'] as const;
export const Outlet = z.enum(OUTLETS);

export const RemediationSchema = z
  .object({ outlet: Outlet, ref: z.string().min(1), verified: z.boolean() })
  .strict();

export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append'), text: z.string() }).strict(),
  z.object({ op: z.literal('replace'), target: z.string().min(1), text: z.string() }).strict(),
  z.object({ op: z.literal('insert_after'), target: z.string().min(1), text: z.string() }).strict(),
]);

/** JSON with object keys sorted recursively — the input to every content hash in the ledger and
 * evaluation records, so a hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** sha256 of the canonical JSON of `value` with `omitKey` removed (the field that holds the hash). */
export function contentHash(value: Record<string, unknown>, omitKey: string): string {
  const { [omitKey]: _omit, ...rest } = value;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}
