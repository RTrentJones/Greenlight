import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Evidence identity and raw records (vision 08 §5). `(tool, gitSha)` alone cannot tell apart two
 * dirty-tree previews at one HEAD, a wrapper verify-config change without a tool commit, retries,
 * or which skills the agent actually used — so every piece of evidence carries an
 * `EvidenceIdentity`, and every raw record keeps `RetainedEvidence` because references rot.
 *
 * Every schema is strict: an unknown field is an error, matching the verify harness's stance that
 * a silently-ignored field is an assertion that never runs.
 */

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** `"<scheme>:<locator>"` (vision 08 §3.1). */
export const EVIDENCE_REF_RE =
  /^(issue|pr):[\w.-]+\/[\w.-]+#\d+$|^commit:[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}$|^run:[\w.-]+\/[\w.-]+\/\d+$|^raw:\d{8}T\d{6}Z-[0-9a-f]{8}$|^tracer:[\w-]+$|^post:https?:\/\/\S+$/;

export const EvidenceRefSchema = z
  .string()
  .regex(
    EVIDENCE_REF_RE,
    'evidence ref must be issue:o/r#n, pr:o/r#n, commit:o/r@sha, run:o/r/id, raw:<rawId>, tracer:<id> or post:<url>',
  );

const SkillStampSchema = z
  .object({ version: z.string().min(1), contentHash: z.string().regex(SHA256) })
  .strict();

export const EvidenceIdentitySchema = z
  .object({
    tool: z.string().min(1),
    env: z.enum(['preview', 'beta', 'prod', 'bench']),
    sourceRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'sourceRepo must be "<owner>/<repo>"'),
    gitSha: z.string().regex(SHA40).nullable(),
    dirty: z.boolean(),
    treeHash: z.string().regex(SHA256).optional(),
    wrapperRev: z
      .object({
        sha: z.string().regex(SHA40).nullable(),
        verifyConfigHash: z.string().regex(SHA256).nullable(),
      })
      .strict(),
    runId: z.string().min(1),
    attempt: z.number().int().min(1),
    changeId: z.string().min(1).optional(),
    artifactId: z.string().min(1).optional(),
    skills: z
      .object({
        installed: z.record(z.string(), SkillStampSchema),
        used: z.union([z.record(z.string(), SkillStampSchema), z.literal('unknown')]),
      })
      .strict(),
  })
  .strict();

/** The dirty⇔treeHash rule, shared by every schema that embeds an identity. */
function refineIdentity(v: { dirty: boolean; treeHash?: string }, ctx: z.RefinementCtx): void {
  if (v.dirty && !v.treeHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['treeHash'],
      message: 'treeHash is required when dirty',
    });
  }
  if (!v.dirty && v.treeHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['treeHash'],
      message: 'treeHash is only valid when dirty',
    });
  }
}

export const RetainedEvidenceSchema = z
  .object({
    verdict: z.enum(['passed', 'failed', 'unknown']),
    excerpt: z.string().max(15_000),
    hashes: z
      .object({
        excerpt: z.string().regex(SHA256),
        verify: z.string().regex(SHA256).optional(),
        transcript: z.string().regex(SHA256).optional(),
        diff: z.string().regex(SHA256).optional(),
      })
      .strict(),
    fetchedAt: z.string().datetime(),
  })
  .strict();

export const AgentSchema = z
  .object({
    vendor: z.enum(['greenlight-harness', 'gemini-cli', 'claude', 'codex', 'other']),
    version: z.string().optional(),
    model: z.string().optional(),
    servedBy: z.string().optional(),
    sessionRef: z.string().optional(),
  })
  .strict();

export const RAW_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export const RawRecordSchema = EvidenceIdentitySchema.extend({
  rawId: z.string().regex(RAW_ID_RE),
  kind: z.enum(['preview', 'ship', 'verify', 'keepalive', 'alert', 'bench', 'session']),
  passed: z.boolean(),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  agent: AgentSchema.optional(),
  bench: z
    .object({
      task: z.string().min(1),
      split: z.enum(['train', 'val', 'test']),
      model: z.string().min(1),
      mode: z.enum(['isolation', 'production']),
      skillSetHash: z.string().regex(SHA256),
      evaluationId: z.string().min(1),
      run: z.number().int().min(1),
      seed: z.string().min(1),
    })
    .strict()
    .optional(),
  refs: z.array(EvidenceRefSchema),
  retained: RetainedEvidenceSchema,
  stages: z.array(z.record(z.string(), z.unknown())).optional(),
  verify: z.unknown().optional(),
  wikiHits: z.array(z.string()).optional(),
})
  .strict()
  .superRefine((v, ctx) => {
    refineIdentity(v, ctx);
    if ((v.kind === 'bench') !== (v.bench !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bench'],
        message: 'bench is required iff kind is "bench"',
      });
    }
    if (v.kind === 'bench' && v.env !== 'bench') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['env'],
        message: 'a bench record has env "bench"',
      });
    }
  });

export const IdentitySchema = EvidenceIdentitySchema.superRefine(refineIdentity);

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type EvidenceIdentity = z.infer<typeof EvidenceIdentitySchema>;
export type RetainedEvidence = z.infer<typeof RetainedEvidenceSchema>;
export type RawRecord = z.infer<typeof RawRecordSchema>;
export type SkillStamp = z.infer<typeof SkillStampSchema>;

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** `"<YYYYMMDD>T<HHMMSS>Z-<8 hex>"`, unique by its random suffix (vision 08 §5.2). */
export function newRawId(now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `${ts}-${randomBytes(4).toString('hex')}`;
}

/** Excerpts are bounded at the paper's per-log budget: keep the TAIL (where failures surface), and
 * mark the cut so a reader never mistakes a truncated log for a complete one. */
export function truncateExcerpt(text: string, max = 15_000): string {
  if (text.length <= max) return text;
  const marker = `…[truncated ${text.length - max} chars]…\n`;
  return marker + text.slice(text.length - (max - marker.length));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The working tree's identity: HEAD, whether it is dirty, and — when it is — a content hash over
 * every tracked file plus untracked files that are not ignored, so two dirty previews at one HEAD
 * are distinguishable (vision 08 §5.1). `gitSha` is null outside a repository. */
export function treeIdentity(cwd: string): {
  gitSha: string | null;
  dirty: boolean;
  treeHash?: string;
} {
  let head: string;
  try {
    head = git(cwd, ['rev-parse', 'HEAD']).trim();
  } catch {
    return { gitSha: null, dirty: false };
  }
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=all']).trim();
  if (status === '') return { gitSha: head, dirty: false };
  const files = git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .sort();
  const h = createHash('sha256');
  for (const f of files) {
    const p = join(cwd, f);
    h.update(f);
    h.update('\0');
    // A tracked file deleted in the working tree hashes as absent rather than throwing.
    h.update(existsSync(p) ? readFileSync(p) : Buffer.from('<deleted>'));
    h.update('\0');
  }
  return { gitSha: head, dirty: true, treeHash: h.digest('hex') };
}

/** Every managed skill on disk with its version and content hash (vision 08 §7). Reads
 * `.claude/skills/<name>/SKILL.md`, and `.agents/skills/<name>/SKILL.md` when present (M7). When a
 * skill exists in both trees, the `.claude` copy wins; `doctor` reports any divergence (DR-14). */
export function installedSkills(cwd: string = process.cwd()): Record<string, SkillStamp> {
  const out: Record<string, SkillStamp> = {};
  for (const root of ['.agents/skills', '.claude/skills']) {
    const dir = resolve(cwd, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const version = text.match(/^version:\s*["']?([\w.-]+)/m)?.[1] ?? 'unversioned';
      out[name] = { version, contentHash: sha256(text) };
    }
  }
  return out;
}

/** `skills.used`: only what an agent wrapper actually observed, via `GREENLIGHT_SKILLS_USED` (a JSON
 * object of name → { version, contentHash }). Absent or malformed ⇒ `'unknown'`, never "all
 * installed" (vision 08 §5.1). */
export function skillsUsedFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, SkillStamp> | 'unknown' {
  const raw = env.GREENLIGHT_SKILLS_USED;
  if (!raw) return 'unknown';
  try {
    const parsed = z.record(z.string(), SkillStampSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The run identity of the current process: the CI run (GitHub Actions) or a fresh local id. */
export function runIdentity(env: NodeJS.ProcessEnv = process.env): {
  runId: string;
  attempt: number;
} {
  if (env.GITHUB_RUN_ID) {
    const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? '1', 10);
    return {
      runId: `gha:${env.GITHUB_RUN_ID}`,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    };
  }
  return { runId: `local:${randomBytes(8).toString('hex')}`, attempt: 1 };
}
