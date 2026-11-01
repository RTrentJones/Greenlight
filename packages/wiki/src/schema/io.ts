import { z } from 'zod';
import { normalizeId } from '../ids';
import { KebabSlug, PatchOpSchema } from './common';

/** Maintainer and proposer I/O (vision 08 §9, roadmap M0-05). The paper's JSON edit protocol,
 * generalized from patterns to pages, with multi-file proposer patches so SKILL.md and PURPOSE.md
 * change together or not at all. */

export const MaintainerOutputSchema = z
  .object({
    create_pages: z.array(z.object({ id: z.string().min(1), content: z.string().min(1) }).strict()),
    update_pages: z.array(
      z.object({ id: z.string().min(1), ops: z.array(PatchOpSchema).min(1) }).strict(),
    ),
    update_index: z.string().min(1),
    append_log: z.string().min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Compared by canonical id: `pattern/x` and `patterns/x` name one page (one file), so two
    // entries for them would write the same path twice and silently lose the first edit.
    const raw = [...m.create_pages.map((p) => p.id), ...m.update_pages.map((p) => p.id)];
    const ids = raw.map(normalizeId);
    const at = ids.findIndex((id, i) => ids.indexOf(id) !== i);
    if (at >= 0) {
      const first = raw[ids.indexOf(ids[at] as string)];
      const spelled = first === raw[at] ? `"${raw[at]}"` : `"${first}" and "${raw[at]}"`;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page ${spelled} (${ids[at]}) appears more than once; one create or one update per page`,
      });
    }
  });

/** A patch op on one file. `file` is "SKILL.md" | "PURPOSE.md" (relative to the skill dir) or a
 * template path; the applier resolves it and refuses anything outside the target (08 §9.2). */
const FileField = z
  .string()
  .min(1)
  .refine(
    (f) => !f.split('/').includes('..') && !f.startsWith('/'),
    'file must be a relative path inside the target',
  );

const FilePatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('append'), file: FileField, text: z.string() }).strict(),
  z
    .object({
      op: z.literal('replace'),
      file: FileField,
      target: z.string().min(1),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal('insert_after'),
      file: FileField,
      target: z.string().min(1),
      text: z.string(),
    })
    .strict(),
]);

const Patterns = z.array(z.string().min(1)).min(1, 'a proposal cites at least one pattern');

export const ProposerOutputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      outlet: z.literal('skill'),
      name: KebabSlug,
      skill_md: z.string().min(1),
      purpose_md: z.string().min(1),
      patterns: Patterns,
    })
    .strict(),
  z
    .object({
      action: z.literal('patch'),
      outlet: z.enum(['skill', 'template']),
      name: z.string().min(1),
      edits: z.array(FilePatchOpSchema).min(1),
      patterns: Patterns,
    })
    .strict(),
  z
    .object({
      action: z.literal('issue'),
      outlet: z.enum(['mechanism', 'doctor', 'verify']),
      title: z.string().min(1),
      body: z.string().min(1),
      patterns: Patterns,
    })
    .strict(),
  z.object({ action: z.literal('no_action'), reason: z.string().min(1) }).strict(),
]);

export type MaintainerOutput = z.infer<typeof MaintainerOutputSchema>;
export type ProposerOutput = z.infer<typeof ProposerOutputSchema>;

/** The harness, not the proposer, owns `version` (06 §3.4): reject any proposal that touches it. */
export function touchesVersion(p: ProposerOutput): boolean {
  const versionLine = /^version:/m;
  if (p.action === 'create') return versionLine.test(p.skill_md) || versionLine.test(p.purpose_md);
  if (p.action === 'patch') {
    return p.edits.some(
      (e) => versionLine.test(e.text) || ('target' in e && versionLine.test(e.target)),
    );
  }
  return false;
}
