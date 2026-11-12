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

// ---- JSON Schemas for the model (06 §4.8) ------------------------------------------------------
//
// The maintainer and proposer return their output as the arguments of a `finish` function call.
// Gemini's function declarations take an OpenAPI-style JSON Schema subset (type, properties,
// required, items, enum, description; no unions), so these are written by hand, in this one
// place, beside the zod schemas that remain the enforced contract. A test keeps the two in step:
// every top-level key of a zod schema is a property here, and nothing else is.

const PATCH_OP_PROPERTIES = {
  op: { type: 'string', enum: ['append', 'replace', 'insert_after'] },
  target: {
    type: 'string',
    description: 'replace / insert_after only: an exact substring occurring exactly once',
  },
  text: { type: 'string' },
} as const;

/** `MaintainerOutput` (08 §9.1) for the model; `MaintainerOutputSchema` is enforced. */
export const MAINTAINER_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    create_pages: {
      type: 'array',
      description: 'new pages, each the full file including frontmatter (status: hypothesis)',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, content: { type: 'string' } },
        required: ['id', 'content'],
      },
    },
    update_pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ops: {
            type: 'array',
            items: { type: 'object', properties: PATCH_OP_PROPERTIES, required: ['op', 'text'] },
          },
        },
        required: ['id', 'ops'],
      },
    },
    update_index: { type: 'string', description: 'REQUIRED: the complete index.md' },
    append_log: { type: 'string', description: 'REQUIRED: 2–6 lines, what changed and why' },
  },
  required: ['create_pages', 'update_pages', 'update_index', 'append_log'],
} as const;

/**
 * `ProposerOutput` (08 §9.2) for the model, flattened: `action` selects which of the other fields
 * apply (create: outlet, name, skill_md, purpose_md, patterns; patch: outlet, name, edits,
 * patterns; issue: outlet, title, body, patterns; no_action: reason). `normalizeProposerOutput`
 * drops the fields the chosen action does not take before `ProposerOutputSchema` validates it.
 */
export const PROPOSER_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'patch', 'issue', 'no_action'] },
    outlet: { type: 'string', enum: ['mechanism', 'doctor', 'template', 'verify', 'skill'] },
    name: { type: 'string', description: 'create/patch: the skill name or template path' },
    skill_md: { type: 'string', description: 'create: the full SKILL.md' },
    purpose_md: { type: 'string', description: 'create: the full PURPOSE.md' },
    edits: {
      type: 'array',
      description: 'patch: applied atomically; file is SKILL.md, PURPOSE.md or a template path',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, ...PATCH_OP_PROPERTIES },
        required: ['file', 'op', 'text'],
      },
    },
    title: { type: 'string', description: 'issue: the issue title' },
    body: { type: 'string', description: 'issue: problem, evidence ids, proposed check' },
    patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'create/patch/issue: the pattern ids that motivate the change',
    },
    reason: { type: 'string', description: 'no_action: why nothing should change' },
  },
  required: ['action'],
} as const;

/** The fields each action takes, as `ProposerOutputSchema` defines them. */
export const PROPOSER_ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create: ['action', 'outlet', 'name', 'skill_md', 'purpose_md', 'patterns'],
  patch: ['action', 'outlet', 'name', 'edits', 'patterns'],
  issue: ['action', 'outlet', 'title', 'body', 'patterns'],
  no_action: ['action', 'reason'],
};

/** Keeps only the fields the output's `action` takes (the flattened schema lets a model fill the
 * others with empty values), and drops a `target` from `append` edits. Anything that is not an
 * object with a known action is returned unchanged, for `ProposerOutputSchema` to reject. */
export function normalizeProposerOutput(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const keep = PROPOSER_ACTION_FIELDS[String(o.action)];
  if (!keep) return v;
  const out = Object.fromEntries(Object.entries(o).filter(([k]) => keep.includes(k)));
  if (Array.isArray(out.edits)) {
    out.edits = out.edits.map((e) => {
      if (e === null || typeof e !== 'object') return e;
      const { target, ...rest } = e as Record<string, unknown>;
      return (e as { op?: unknown }).op === 'append' ? rest : { ...rest, target };
    });
  }
  return out;
}
