import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EvidenceRefSchema,
  RAW_ID_RE,
  type RawRecord,
  RawRecordSchema,
  installedSkills,
  newRawId,
  runIdentity,
  sha256,
  skillsUsedFromEnv,
  treeIdentity,
  truncateExcerpt,
} from '@rtrentjones/greenlight-shared';
import { flaggedLeaves, redactDeep, withholdLeaves } from './bench/runner/redact';
import { redact } from './redact';

/**
 * Raw capture outside the bench (vision 07 §3.5, 08 §5, roadmap M3-04): the record a `preview`,
 * `verify` or `ship` leaves behind, and the one a person writes by hand for a drill or an
 * incident. Every record carries the identity of 08 §5.1, so two runs are the same evidence only
 * when the tool's tree, the wrapper's verify config and the run attempt all agree.
 *
 * Capture redacts and never refuses: a value the detector still flags after redaction is withheld
 * and the record is written without it (08 §5.2).
 */

export const RAW_DIR = '.greenlight/raw';
export const EVIDENCE_DIR = 'evidence';

/** `GREENLIGHT_RAW=off` disables raw capture everywhere (07 §0). */
export const rawOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.GREENLIGHT_RAW === 'off';

export type CaptureKind = Exclude<RawRecord['kind'], 'bench'>;
export type CaptureEnv = Exclude<RawRecord['env'], 'bench'>;

export interface CaptureInput {
  /** The wrapper root: its HEAD is `wrapperRev.sha`, and its skills are the installed set. */
  cwd: string;
  /** The tool's own checkout, when it is a separate repository (a submodule). Default: `cwd`. */
  toolDir?: string;
  tool: string;
  env: CaptureEnv;
  kind: CaptureKind;
  /** `undefined` records the verdict as unknown and `passed: false`. */
  passed: boolean | undefined;
  /** Failing checks, a log tail or a note. Redacted and truncated here. */
  excerpt: string;
  refs?: readonly string[];
  /** The tool's verify config file, hashed into `wrapperRev.verifyConfigHash`. */
  verifyConfigPath?: string;
  /** The `verify --json` document. Stored redacted; its hash is of the unredacted text. */
  verify?: unknown;
  stages?: readonly Record<string, unknown>[];
  wikiHits?: readonly string[];
  /** A commit the caller knows better than the working tree does (`--sha`, a CI checkout). */
  gitSha?: string;
  startedAt?: Date;
  durationMs?: number;
  now?: Date;
  processEnv?: NodeJS.ProcessEnv;
}

export class CaptureError extends Error {}

const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL/i;

/** Values of secret-named environment variables: redacted wherever they appear, whatever their
 * shape, so a token the shape detector does not know still never reaches a record. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_NAME.test(k)) out.add(v);
  }
  return [...out];
}

function originRepo(dir: string): string {
  try {
    const url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    // not a repository, or no remote
  }
  return 'local/unknown';
}

/** Builds a validated record. Throws `CaptureError` on a malformed ref or sha. */
export function buildRawRecord(i: CaptureInput): RawRecord {
  const env = i.processEnv ?? process.env;
  const now = i.now ?? new Date();
  const toolDir = i.toolDir ?? i.cwd;
  const secrets = secretValues(env);
  const scrub = (text: string) => redact(text, secrets);

  const refs = [...(i.refs ?? [])];
  for (const ref of refs) {
    const r = EvidenceRefSchema.safeParse(ref);
    if (!r.success) {
      throw new CaptureError(`"${ref}" is not an evidence ref: ${r.error.issues[0]?.message}`);
    }
  }
  if (i.gitSha !== undefined && !/^[0-9a-f]{40}$/.test(i.gitSha)) {
    throw new CaptureError(`--sha must be a full 40-character commit sha (got "${i.gitSha}")`);
  }

  const tree = treeIdentity(toolDir);
  const wrapper = toolDir === i.cwd ? tree : treeIdentity(i.cwd);
  const configText =
    i.verifyConfigPath && existsSync(i.verifyConfigPath)
      ? readFileSync(i.verifyConfigPath)
      : undefined;
  // Redact, truncate, then redact again: truncation can cut a `key=value` so that only its tail
  // remains, and the tail alone must still be caught.
  const excerpt = truncateExcerpt(scrub(truncateExcerpt(scrub(i.excerpt))));
  const verifyText = i.verify === undefined ? undefined : JSON.stringify(i.verify);
  const startedAt = i.startedAt ?? now;

  const record: RawRecord = {
    tool: i.tool,
    env: i.env,
    sourceRepo: originRepo(toolDir),
    gitSha: i.gitSha ?? tree.gitSha,
    // A sha the caller supplied describes a commit, not this working tree.
    dirty: i.gitSha ? false : tree.dirty,
    ...(!i.gitSha && tree.treeHash ? { treeHash: tree.treeHash } : {}),
    wrapperRev: {
      sha: wrapper.gitSha,
      verifyConfigHash: configText ? sha256(configText) : null,
    },
    ...runIdentity(env),
    skills: { installed: installedSkills(i.cwd), used: skillsUsedFromEnv(env) },
    rawId: newRawId(now),
    kind: i.kind,
    passed: i.passed === true,
    startedAt: startedAt.toISOString(),
    durationMs: Math.max(0, Math.round(i.durationMs ?? now.getTime() - startedAt.getTime())),
    refs,
    retained: {
      verdict: i.passed === undefined ? 'unknown' : i.passed ? 'passed' : 'failed',
      excerpt,
      hashes: {
        excerpt: sha256(excerpt),
        ...(verifyText !== undefined ? { verify: sha256(verifyText) } : {}),
      },
      fetchedAt: now.toISOString(),
    },
    ...(i.stages ? { stages: redactWith(i.stages, secrets) as Record<string, unknown>[] } : {}),
    ...(i.verify !== undefined ? { verify: redactWith(i.verify, secrets) } : {}),
    ...(i.wikiHits?.length ? { wikiHits: [...i.wikiHits] } : {}),
  };
  const parsed = RawRecordSchema.parse(record);
  const flagged = flaggedLeaves(parsed);
  if (flagged.length > 0) withholdLeaves(parsed, new Set(flagged));
  return parsed;
}

/** `redactDeep` plus the literal secret values, on every string leaf. */
function redactWith(v: unknown, secrets: readonly string[]): unknown {
  if (typeof v === 'string') return redact(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactWith(x, secrets));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactWith(x, secrets)]));
  }
  return redactDeep(v);
}

/** Writes `<rawDir>/<rawId>.json` and returns its path. */
export function writeRawRecord(rawDir: string, record: RawRecord): string {
  mkdirSync(rawDir, { recursive: true });
  const file = join(rawDir, `${record.rawId}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return file;
}

/** Builds and writes one record under `<cwd>/.greenlight/raw` (or `rawDir`). */
export function captureRecord(i: CaptureInput & { rawDir?: string }): RawRecord {
  const record = buildRawRecord(i);
  writeRawRecord(i.rawDir ?? join(i.cwd, RAW_DIR), record);
  return record;
}

export interface RetainResult {
  path: string;
  /** True when the record was already retained with the same content. */
  already: boolean;
}

/**
 * Copies a raw record to `<wikiRoot>/evidence/<rawId>.json`, which is committed (08 §5.3). A
 * retained record is immutable: retaining it again is a no-op when the content matches, and an
 * error when it does not.
 */
export function retainRecord(rawDir: string, wikiRoot: string, rawId: string): RetainResult {
  if (!RAW_ID_RE.test(rawId)) throw new CaptureError(`"${rawId}" is not a raw id`);
  const from = join(rawDir, `${rawId}.json`);
  if (!existsSync(from)) throw new CaptureError(`raw record ${rawId} not found in ${rawDir}`);
  const text = readFileSync(from, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CaptureError(`raw record ${rawId} is not valid JSON`);
  }
  const parsed = RawRecordSchema.safeParse(json);
  if (!parsed.success || parsed.data.rawId !== rawId) {
    throw new CaptureError(`raw record ${rawId} does not match the raw record schema`);
  }
  if (flaggedLeaves(parsed.data).length > 0) {
    throw new CaptureError(
      `raw record ${rawId} holds a value the secret detector flags; it cannot be committed`,
    );
  }
  const dir = join(wikiRoot, EVIDENCE_DIR);
  const to = join(dir, `${rawId}.json`);
  if (existsSync(to)) {
    if (readFileSync(to, 'utf8') === text) return { path: to, already: true };
    throw new CaptureError(
      `${to} already exists with different content; a retained record is immutable`,
    );
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(from, to);
  return { path: to, already: false };
}
