/**
 * Release approval (vision 18 §3): an owner-signed git tag that authorizes ONE production
 * operation, for one tool at one commit (and one artifact, when it was built first), once, for a
 * limited time.
 *
 * The owner creates an annotated, SSH-signed tag `release/<tool>/<sha12>-<nonce8>` on the exact
 * commit; its message is a `ReleaseApproval` JSON payload. `prepareApproval` builds that payload
 * and the tag name and never signs anything. Every production job starts by calling
 * `verifyApproval`, which:
 *
 * 1. finds the approval tags for this tool and commit;
 * 2. verifies each tag's signature against the allowed-signers list (the
 *    `GREENLIGHT_RELEASE_SIGNERS` Actions secret, which an agent identity cannot write);
 * 3. checks the payload against the job: tool, sha, repo, env, expiry, HEAD, artifact;
 * 4. checks that the nonce has not been consumed, then consumes it.
 *
 * A pushed tag proves nothing until this accepts it: an agent can create a ref, and it cannot
 * produce a signature that verifies.
 *
 * On success the job exports `GREENLIGHT_RELEASE_AUTHORIZED=<tool>@<sha>[#<artifact>]` (§3.1a).
 * Production operations call `assertReleaseAuthorized` and refuse without it. That variable is
 * defence in depth, not the boundary: a process holding production credentials could set it. The
 * boundary is that only the protected job holds those credentials and that it verifies first.
 *
 * Signatures: SSH only (`git tag -s` with `gpg.format ssh`). An allowed-signers file is an SSH
 * concept; a GPG-signed tag is refused with a message that says so.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RELEASE_AUTHORIZED_ENV = 'GREENLIGHT_RELEASE_AUTHORIZED';
export const RELEASE_SIGNERS_ENV = 'GREENLIGHT_RELEASE_SIGNERS';
/** The longest an approval may live (18 §3.1). */
export const MAX_APPROVAL_HOURS = 72;

export interface ReleaseApproval {
  v: 1;
  /** Manifest name. */
  tool: string;
  /** The 40-hex commit approved. */
  sha: string;
  /** `<owner>/<repo>` holding the commit. */
  repo: string;
  /** Immutable artifact id when built before approval: an OCI image digest, a Worker version id,
   * or a Vercel prebuilt output hash. */
  artifact?: string;
  env: 'prod';
  /** ISO timestamp, at most `MAX_APPROVAL_HOURS` after creation. */
  expiresAt: string;
  /** 8 hex characters, also in the tag name; single use. */
  nonce: string;
  /** Required for promotion-policy, workflow, signer or CODEOWNERS edits (18 §7). */
  policyChange?: true;
  /** sha256 of `retire/<tool>.json` when approving a retirement (10 §5.4). */
  retire?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{8}$/;
const TOOL_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const KNOWN_KEYS = new Set([
  'v',
  'tool',
  'sha',
  'repo',
  'artifact',
  'env',
  'expiresAt',
  'nonce',
  'policyChange',
  'retire',
]);

/** Parses and validates a tag message as a `ReleaseApproval`. Unknown keys are refused: a payload
 * is signed text, and a field nothing checks should not ride along under the signature. */
export function parseApproval(
  message: string,
): { ok: true; approval: ReleaseApproval } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return { ok: false, errors: ['the tag message is not JSON'] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['the tag message is not a JSON object'] };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  if (o.v !== 1) errors.push('v must be 1');
  if (typeof o.tool !== 'string' || !TOOL_RE.test(o.tool)) errors.push('tool is not a tool name');
  if (typeof o.sha !== 'string' || !SHA_RE.test(o.sha)) errors.push('sha is not a 40-hex commit');
  if (typeof o.repo !== 'string' || !REPO_RE.test(o.repo)) errors.push('repo is not owner/name');
  if (o.env !== 'prod') errors.push('env must be "prod"');
  if (typeof o.nonce !== 'string' || !NONCE_RE.test(o.nonce)) errors.push('nonce is not 8 hex');
  if (typeof o.expiresAt !== 'string' || Number.isNaN(Date.parse(o.expiresAt))) {
    errors.push('expiresAt is not a timestamp');
  }
  if (o.artifact !== undefined && (typeof o.artifact !== 'string' || o.artifact.length === 0)) {
    errors.push('artifact must be a non-empty string');
  }
  if (o.policyChange !== undefined && o.policyChange !== true) {
    errors.push('policyChange, when present, must be true');
  }
  if (
    o.retire !== undefined &&
    (typeof o.retire !== 'string' || !/^[0-9a-f]{64}$/.test(o.retire))
  ) {
    errors.push('retire must be a sha256');
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, approval: o as unknown as ReleaseApproval };
}

export const approvalTagName = (tool: string, sha: string, nonce: string): string =>
  `release/${tool}/${sha.slice(0, 12)}-${nonce}`;

/** The tag-name prefix every approval for this tool and commit shares. */
export const approvalTagPrefix = (tool: string, sha: string): string =>
  `release/${tool}/${sha.slice(0, 12)}-`;

export interface PrepareInput {
  tool: string;
  sha: string;
  repo: string;
  artifact?: string;
  policyChange?: boolean;
  retire?: string;
  /** Lifetime in hours; default 24, at most `MAX_APPROVAL_HOURS`. */
  expiresInHours?: number;
  now?: Date;
  /** For tests: a fixed nonce. */
  nonce?: string;
}

/** Builds the payload and tag name the OWNER signs. Holds no key and signs nothing. */
export function prepareApproval(i: PrepareInput): { approval: ReleaseApproval; tag: string } {
  const hours = i.expiresInHours ?? 24;
  if (!(hours > 0) || hours > MAX_APPROVAL_HOURS) {
    throw new Error(`an approval lives at most ${MAX_APPROVAL_HOURS} hours (got ${hours})`);
  }
  const nonce = i.nonce ?? randomBytes(4).toString('hex');
  const approval: ReleaseApproval = {
    v: 1,
    tool: i.tool,
    sha: i.sha,
    repo: i.repo,
    ...(i.artifact ? { artifact: i.artifact } : {}),
    env: 'prod',
    expiresAt: new Date((i.now ?? new Date()).getTime() + hours * 3_600_000).toISOString(),
    nonce,
    ...(i.policyChange ? { policyChange: true as const } : {}),
    ...(i.retire ? { retire: i.retire } : {}),
  };
  const parsed = parseApproval(JSON.stringify(approval));
  if (!parsed.ok) throw new Error(`cannot prepare an approval: ${parsed.errors.join('; ')}`);
  return { approval, tag: approvalTagName(i.tool, i.sha, nonce) };
}

/** What the production job is about to do. */
export interface ApprovalJob {
  tool: string;
  /** The commit the job is deploying. */
  sha: string;
  repo: string;
  /** The job's checked-out HEAD. */
  headSha: string;
  /** The artifact id the job will deploy, when it knows one. */
  artifact?: string;
  now?: Date;
}

/** Why a (signature-verified) payload does not authorize this job; empty when it does. */
export function approvalProblems(a: ReleaseApproval, tag: string, job: ApprovalJob): string[] {
  const out: string[] = [];
  if (tag !== approvalTagName(a.tool, a.sha, a.nonce)) {
    out.push(
      `the tag name does not match its payload (expected ${approvalTagName(a.tool, a.sha, a.nonce)})`,
    );
  }
  if (a.tool !== job.tool) out.push(`approved tool "${a.tool}", job tool "${job.tool}"`);
  if (a.sha !== job.sha)
    out.push(`approved sha ${a.sha.slice(0, 12)}, job sha ${job.sha.slice(0, 12)}`);
  if (a.repo.toLowerCase() !== job.repo.toLowerCase()) {
    out.push(`approved repo ${a.repo}, job repo ${job.repo}`);
  }
  if (job.headSha !== a.sha) {
    out.push(
      `the job's HEAD is ${job.headSha.slice(0, 12)}, not the approved ${a.sha.slice(0, 12)}`,
    );
  }
  const now = (job.now ?? new Date()).getTime();
  const expires = Date.parse(a.expiresAt);
  if (!(expires > now)) out.push(`the approval expired at ${a.expiresAt}`);
  // An approval cannot be minted with a far-future expiry to sidestep the lifetime cap: the
  // remaining life can never exceed the cap either.
  if (expires - now > MAX_APPROVAL_HOURS * 3_600_000) {
    out.push(`expiresAt is more than ${MAX_APPROVAL_HOURS} hours away`);
  }
  if (a.artifact !== undefined && job.artifact === undefined) {
    out.push(`the approval binds artifact ${a.artifact}, and the job names none`);
  }
  if (a.artifact !== undefined && job.artifact !== undefined && a.artifact !== job.artifact) {
    out.push(`approved artifact ${a.artifact}, job artifact ${job.artifact}`);
  }
  return out;
}

/** `<tool>@<sha>[#<artifact>]`: the value of `GREENLIGHT_RELEASE_AUTHORIZED`. */
export const authorizedValue = (a: Pick<ReleaseApproval, 'tool' | 'sha' | 'artifact'>): string =>
  `${a.tool}@${a.sha}${a.artifact ? `#${a.artifact}` : ''}`;

export function parseAuthorized(
  value: string | undefined,
): { tool: string; sha: string; artifact?: string } | null {
  const m = /^([a-z0-9][a-z0-9-]*)@([0-9a-f]{40})(?:#(.+))?$/.exec(value ?? '');
  if (!m) return null;
  return { tool: m[1] as string, sha: m[2] as string, ...(m[3] ? { artifact: m[3] } : {}) };
}

export class ReleaseNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseNotAuthorizedError';
  }
}

/**
 * The guard a production operation calls (18 §3.1a). Throws unless `GREENLIGHT_RELEASE_AUTHORIZED`
 * names this tool at this commit (and this artifact, when the approval bound one).
 */
export function assertReleaseAuthorized(
  op: { tool: string; sha: string; artifact?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const got = parseAuthorized(env[RELEASE_AUTHORIZED_ENV]);
  const want = authorizedValue(op);
  if (!got) {
    throw new ReleaseNotAuthorizedError(
      `production operation refused: ${RELEASE_AUTHORIZED_ENV} is not set. Only the protected production job sets it, after verifying an owner-signed approval for ${want} (greenlight release verify)`,
    );
  }
  if (got.tool !== op.tool || got.sha !== op.sha) {
    throw new ReleaseNotAuthorizedError(
      `production operation refused: authorized ${got.tool}@${got.sha.slice(0, 12)}, operation is ${op.tool}@${op.sha.slice(0, 12)}`,
    );
  }
  // An approval that binds an artifact authorizes exactly that one. One that binds none covers the
  // tool at the commit, whatever the operation builds from it.
  if (got.artifact !== undefined && got.artifact !== op.artifact) {
    throw new ReleaseNotAuthorizedError(
      `production operation refused: authorized artifact ${got.artifact ?? '(none)'}, operation artifact ${op.artifact ?? '(none)'}`,
    );
  }
}

// ---- git ---------------------------------------------------------------------------------------

function git(repoDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0' },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Approval tags for this tool and commit that exist in the repository, sorted. */
export function listApprovalTags(repoDir: string, tool: string, sha: string): string[] {
  const r = git(repoDir, ['tag', '--list', `${approvalTagPrefix(tool, sha)}*`]);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

/**
 * True when `tag` is an annotated tag whose SSH signature verifies against `allowedSigners` (the
 * text of an allowed-signers file). The signer's principal is not constrained beyond being in
 * that file: the file IS the owner's list.
 */
export function verifyTagSignature(
  repoDir: string,
  tag: string,
  allowedSigners: string,
): { ok: true } | { ok: false; reason: string } {
  const type = git(repoDir, ['cat-file', '-t', `refs/tags/${tag}`]).stdout.trim();
  if (type !== 'tag') {
    return { ok: false, reason: 'not an annotated tag (a lightweight tag carries no signature)' };
  }
  const body = git(repoDir, ['cat-file', 'tag', `refs/tags/${tag}`]).stdout;
  if (body.includes('-----BEGIN PGP SIGNATURE-----')) {
    return { ok: false, reason: 'GPG-signed; approvals are verified as SSH signatures only' };
  }
  if (!body.includes('-----BEGIN SSH SIGNATURE-----')) {
    return { ok: false, reason: 'the tag is not signed' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'greenlight-signers-'));
  try {
    const file = join(dir, 'allowed_signers');
    writeFileSync(file, allowedSigners.endsWith('\n') ? allowedSigners : `${allowedSigners}\n`, {
      mode: 0o600,
    });
    // The verifier's configuration is stated here and nowhere else: user and system git config are
    // ignored, so an ambient `gpg.ssh.program` or allowed-signers file cannot decide the outcome.
    const r = git(
      repoDir,
      [
        '-c',
        'gpg.format=ssh',
        '-c',
        'gpg.ssh.program=ssh-keygen',
        '-c',
        `gpg.ssh.allowedSignersFile=${file}`,
        'verify-tag',
        `refs/tags/${tag}`,
      ],
      { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    );
    return r.status === 0
      ? { ok: true }
      : { ok: false, reason: 'the signature does not verify against the allowed signers' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The message of an annotated tag, without its signature block. */
export function tagMessage(repoDir: string, tag: string): string {
  const body = git(repoDir, ['cat-file', 'tag', `refs/tags/${tag}`]).stdout;
  const start = body.indexOf('\n\n');
  const text = start === -1 ? '' : body.slice(start + 2);
  const sig = text.indexOf('-----BEGIN SSH SIGNATURE-----');
  return (sig === -1 ? text : text.slice(0, sig)).trim();
}

export const headSha = (repoDir: string): string =>
  git(repoDir, ['rev-parse', 'HEAD']).stdout.trim();

// ---- nonce -------------------------------------------------------------------------------------

/** Where consumed nonces are recorded. An approval is single use (18 §3.1 step 5). */
export interface NonceStore {
  consumed(nonce: string): Promise<boolean>;
  consume(approval: ReleaseApproval, tag: string): Promise<void>;
}

/**
 * Consumed nonces as GitHub Deployments in the `production` environment, written by the protected
 * job's token (`deployments: write`). An agent identity lacks that permission, so it can neither
 * forge a consumption nor erase one.
 */
export function githubDeploymentNonces(o: {
  repo: string;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}): NonceStore {
  const api = (o.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const f = o.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${o.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'greenlight-release',
  };
  const task = (nonce: string) => `greenlight-release:${nonce}`;
  return {
    async consumed(nonce) {
      const r = await f(
        `${api}/repos/${o.repo}/deployments?environment=production&task=${encodeURIComponent(task(nonce))}&per_page=1`,
        { headers },
      );
      if (!r.ok) throw new Error(`cannot read deployments (${r.status}); the nonce is unchecked`);
      return ((await r.json()) as unknown[]).length > 0;
    },
    async consume(approval, tag) {
      const r = await f(`${api}/repos/${o.repo}/deployments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ref: approval.sha,
          environment: 'production',
          task: task(approval.nonce),
          auto_merge: false,
          required_contexts: [],
          description: `greenlight release ${approval.tool}`.slice(0, 140),
          payload: { tag, ...approval },
        }),
      });
      if (!r.ok) throw new Error(`cannot record the consumed nonce (${r.status})`);
    },
  };
}

/** A nonce store for one process, for tests and dry runs. */
export function memoryNonces(seen: Set<string> = new Set()): NonceStore {
  return {
    consumed: async (n) => seen.has(n),
    consume: async (a) => {
      seen.add(a.nonce);
    },
  };
}

// ---- verification ------------------------------------------------------------------------------

export interface VerifyInput {
  repoDir: string;
  tool: string;
  /** The commit being deployed; defaults to the checked-out HEAD. */
  sha?: string;
  repo: string;
  artifact?: string;
  /** The allowed-signers text (`GREENLIGHT_RELEASE_SIGNERS`). */
  allowedSigners: string;
  nonces: NonceStore;
  now?: Date;
  /** Check everything and leave the nonce unconsumed. */
  dryRun?: boolean;
}

export type VerifyResult =
  | { ok: true; tag: string; approval: ReleaseApproval; authorized: string }
  | { ok: false; reason: string; tags: { tag: string; problems: string[] }[] };

/**
 * Verifies that an owner-signed approval authorizes this job, and consumes it. The first tag that
 * passes every check is used; when none does, each tag is listed with why it was refused.
 */
export async function verifyApproval(i: VerifyInput): Promise<VerifyResult> {
  if (!i.allowedSigners.trim()) {
    return { ok: false, reason: `${RELEASE_SIGNERS_ENV} is empty: no signer is trusted`, tags: [] };
  }
  const head = headSha(i.repoDir);
  const sha = i.sha ?? head;
  if (!SHA_RE.test(sha)) return { ok: false, reason: `"${sha}" is not a commit sha`, tags: [] };
  const tags = listApprovalTags(i.repoDir, i.tool, sha);
  if (tags.length === 0) {
    return {
      ok: false,
      reason: `no approval tag ${approvalTagPrefix(i.tool, sha)}* exists for this commit (was it fetched?)`,
      tags: [],
    };
  }
  const refused: { tag: string; problems: string[] }[] = [];
  for (const tag of tags) {
    const sig = verifyTagSignature(i.repoDir, tag, i.allowedSigners);
    if (!sig.ok) {
      refused.push({ tag, problems: [sig.reason] });
      continue;
    }
    const parsed = parseApproval(tagMessage(i.repoDir, tag));
    if (!parsed.ok) {
      refused.push({ tag, problems: parsed.errors });
      continue;
    }
    const a = parsed.approval;
    const problems = approvalProblems(a, tag, {
      tool: i.tool,
      sha,
      repo: i.repo,
      headSha: head,
      artifact: i.artifact,
      now: i.now,
    });
    if (problems.length === 0 && (await i.nonces.consumed(a.nonce))) {
      problems.push(`nonce ${a.nonce} was already consumed: an approval is single use`);
    }
    if (problems.length > 0) {
      refused.push({ tag, problems });
      continue;
    }
    if (!i.dryRun) await i.nonces.consume(a, tag);
    return { ok: true, tag, approval: a, authorized: authorizedValue(a) };
  }
  return { ok: false, reason: 'no approval tag authorizes this job', tags: refused };
}
