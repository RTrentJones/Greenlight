import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EVIDENCE_REF_RE } from '@rtrentjones/greenlight-shared';
import { z } from 'zod';
import type { TaskSpec } from '../schema/bench';
import { IsoDate, KebabSlug } from '../schema/common';
import { type ProposerOutput, ProposerOutputSchema } from '../schema/io';
import { type EvidenceSchema, type LedgerEvent, sealEvent } from '../schema/ledger';

/**
 * Outlet evaluation for the outlets a human applies (vision 06 §3.5, §5.6; roadmap M2-02). The
 * skill outlet goes through the gate (gate.ts); everything else comes here:
 *
 * - **mechanism / doctor**: a `repro` grader (06 §4.6). A trusted reproduction, a fixture plus a
 *   script reviewed by a human, lives at `bench/repro/<slug>/{repro.json,run.mjs}` in the
 *   harness's own tree (`ctx.repoRoot`), never in the candidate, so a candidate cannot rewrite the
 *   test it is judged by. It runs against the base and the candidate trees. Accept iff it fails on
 *   base, passes on the candidate, and `pnpm run check-all` passes on the candidate.
 * - **verify**: an artifact check. The proposed assertion (a JSON `api` verify check in the issue
 *   body, or `ctx.assertionFile`) must fail against the faulty artifact and pass on the fixed one.
 * - **template**: not in M2 (it waits for M4); always `invalid`.
 *
 * `invalid` is never a result for the ledger, as at the gate (06 §4.8): the evaluation could not
 * show anything either way, so it carries no ledger event. Accept and reject carry a sealed
 * `candidate-accepted` / `candidate-rejected` event with `repro` or `artifact` evidence (08 §8).
 *
 * Proposer text is data, never code: the issue body contributes only a JSON assertion, which is
 * validated and restricted to `api` checks (no `test` mode, no `logsOnFailure` command).
 */

type Evidence = z.infer<typeof EvidenceSchema>;

/** A tree to evaluate: a commit of `ctx.repoRoot` (checked out with `git worktree add`, removed
 * afterwards), or an existing directory used as is. A directory's evidence ref is `ref` when given,
 * else its HEAD when it is a clean git checkout; a dirty, unreferenced directory cannot be
 * recomputed, so evaluating it is `invalid` (`unpinned-tree`). */
export type OutletTreeRef = { commit: string } | { dir: string; ref?: string };

export interface OutletContext {
  /** The harness's own checkout: the trusted repros (`bench/repro/`), the CLI that runs verify. */
  repoRoot: string;
  proposalId: string;
  /** mechanism / doctor: the commit the repro must fail on, and the candidate it must pass on. */
  base: OutletTreeRef;
  candidate: OutletTreeRef;
  /** The bench task specs. Reserved for the outlet regression guards of 06 §5.6 (same-class
   * replay tasks), which need rollouts and are not run in M2. */
  tasks: readonly TaskSpec[];
  /** Injectable clock for the ledger event's `ts`. */
  now: () => Date;
  /** `owner/repo` for commit evidence refs (default `RTrentJones/greenlight`). */
  sourceRepo?: string;
  /** true for a control-arm proposal (06 §10.2): labelled in the event, never merged. */
  control?: boolean;
  /** The opened issue (`issue:o/r#n`), recorded as `change.ref` when known. */
  issueRef?: string;
  /** Pin one repro by id (`repro/<slug>`); default: every reviewed repro whose `outlets` include
   * the proposal's outlet and whose `patterns` intersect the proposal's. */
  repro?: string;
  /** verify outlet: the faulty artifact (a historical commit or mutant tree) and the fixed one,
   * and how to serve each (argv run in the artifact tree with `PORT` set). */
  artifacts?: {
    faulty: OutletTreeRef;
    fixed: OutletTreeRef;
    serve: { command: string[]; readyPath?: string; readyTimeoutMs?: number };
  };
  /** verify outlet: a JSON file holding the assertion, instead of a block in the issue body. */
  assertionFile?: string;
  /** Installs a checked-out commit's dependencies (default: `pnpm install --frozen-lockfile
   * --prefer-offline --ignore-scripts`). Never run on a given directory. */
  prepareTree?: (tree: string) => Promise<void>;
  /** The framework suite on the candidate (default: `pnpm run check-all` in the tree). */
  checkAll?: (tree: string) => Promise<{ ok: boolean; detail?: string }>;
  /** verify outlet: runs the assertion against one served artifact (default: the harness CLI's
   * `greenlight verify --url <served> --spec <assertion>`). */
  runAssertion?: (
    spec: AssertionSpec,
    artifact: { dir: string; url: string },
  ) => Promise<{ passed: boolean; detail?: string }>;
}

export type OutletDecision = 'accept' | 'reject' | 'invalid';
export interface OutletReason {
  code: (typeof OUTLET_REASON_CODES)[number];
  detail?: string;
}

/** accept / reject carry evidence and a sealed `candidate-*` event; `invalid` never reaches the
 * ledger (as `GateDecision.ledgerEvent` is null when invalid), and has evidence only when both
 * trees were pinned. */
export type OutletResult =
  | {
      decision: 'accept' | 'reject';
      reasons: OutletReason[];
      evidence: Evidence;
      ledgerEvent: LedgerEvent;
    }
  | { decision: 'invalid'; reasons: OutletReason[]; evidence: Evidence | null; ledgerEvent: null };

export const OUTLET_REASON_CODES = [
  // accept
  'repro-fails-on-base',
  'repro-passes-on-candidate',
  'check-all-passed',
  'assertion-fails-on-faulty',
  'assertion-passes-on-fixed',
  // reject
  'repro-fails-on-candidate',
  'check-all-failed',
  'assertion-passes-on-faulty',
  'assertion-fails-on-fixed',
  // invalid
  'template-outlet-not-in-M2',
  'unsupported-outlet',
  'no-trusted-repro',
  'repro-unreviewed',
  'repro-passes-on-base',
  'repro-error',
  'unpinned-tree',
  'checkout-failed',
  'no-artifacts',
  'no-assertion',
  'assertion-invalid',
  'assertion-error',
] as const;

// ---- trusted repros (bench/repro/<slug>/) ---------------------------------------------------

export const ReproSpecSchema = z
  .object({
    /** `repro/<slug>`, matching its folder. */
    id: z.string().regex(/^repro\/[a-z0-9][a-z0-9-]*$/),
    description: z.string().min(1),
    /** Wiki pattern ids this repro reproduces; selection intersects them with the proposal's. */
    patterns: z.array(z.string().min(1)).min(1),
    outlets: z.array(z.enum(['mechanism', 'doctor'])).min(1),
    /** The script, relative to the repro folder: `node <script> --tree <checkout>`; exit 0 =
     * passes (the condition is handled), 1 = fails (reproduced), anything else = error. */
    script: z.string().regex(/^[\w.-]+\.mjs$/),
    timeoutMs: z.number().int().min(1000).max(1_800_000).default(180_000),
    /** The human review that makes the repro trusted (06 §4.6). Null until reviewed: an
     * unreviewed repro is never evidence. */
    reviewed: z
      .object({ by: z.string().min(1), at: IsoDate })
      .strict()
      .nullable(),
  })
  .strict();
export type ReproSpec = z.infer<typeof ReproSpecSchema>;

export interface LoadedRepro {
  spec: ReproSpec;
  dir: string;
}

/** Every repro under `<benchDir>/repro/`, validated; a folder that does not match its id, or a
 * missing script, is a problem. */
export function loadRepros(benchDir: string): { repros: LoadedRepro[]; problems: string[] } {
  const root = join(benchDir, 'repro');
  const repros: LoadedRepro[] = [];
  const problems: string[] = [];
  if (!existsSync(root)) return { repros, problems };
  for (const slug of readdirSync(root).sort()) {
    const dir = join(root, slug);
    const file = join(dir, 'repro.json');
    if (!existsSync(file)) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`repro ${slug}: repro.json is not JSON: ${errMsg(e)}`);
      continue;
    }
    const r = ReproSpecSchema.safeParse(json);
    if (!r.success) {
      problems.push(`repro ${slug}: repro.json is invalid: ${issues(r.error)}`);
      continue;
    }
    if (r.data.id !== `repro/${slug}`) {
      problems.push(`repro ${slug}: id "${r.data.id}" does not match its folder`);
      continue;
    }
    if (!existsSync(join(dir, r.data.script))) {
      problems.push(`repro ${slug}: no ${r.data.script}`);
      continue;
    }
    repros.push({ spec: r.data, dir });
  }
  return { repros, problems };
}

export type ReproVerdict = 'pass' | 'fail' | 'error';

/** Runs one repro against a tree in its own process group, with a scrubbed environment and a
 * throwaway HOME and cwd. */
export async function runRepro(
  repro: LoadedRepro,
  tree: string,
): Promise<{ verdict: ReproVerdict; output: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'greenlight-repro-run-'));
  try {
    const res = await runProcess(
      process.execPath,
      [join(repro.dir, repro.spec.script), '--tree', resolve(tree)],
      { cwd: scratch, env: scrubbedEnv(scratch), timeoutMs: repro.spec.timeoutMs },
    );
    const verdict: ReproVerdict =
      res.timedOut || res.code === null
        ? 'error'
        : res.code === 0
          ? 'pass'
          : res.code === 1
            ? 'fail'
            : 'error';
    return {
      verdict,
      output: res.timedOut
        ? `timed out after ${repro.spec.timeoutMs} ms\n${res.output}`
        : res.output,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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

// ---- evaluation -----------------------------------------------------------------------------

export async function evaluateOutlet(
  p: ProposerOutput & { action: 'issue' },
  ctx: OutletContext,
): Promise<OutletResult>;
/** A template proposal is a `patch`; the template rule waits for M4, so it is always invalid. */
export async function evaluateOutlet(
  p: ProposerOutput & { action: 'patch'; outlet: 'template' },
  ctx: OutletContext,
): Promise<OutletResult>;
export async function evaluateOutlet(
  p: ProposerOutput & ({ action: 'issue' } | { action: 'patch'; outlet: 'template' }),
  ctx: OutletContext,
): Promise<OutletResult> {
  const outlet: string = p.outlet;
  if (outlet === 'template') {
    return invalid('template-outlet-not-in-M2', 'the template rule (06 §5.6) lands in M4');
  }
  if (p.action !== 'issue') return invalid('unsupported-outlet', `${p.action}/${outlet}`);
  if (p.outlet === 'mechanism' || p.outlet === 'doctor') return evaluateRepro(p, ctx);
  if (p.outlet === 'verify') return evaluateVerify(p, ctx);
  return invalid('unsupported-outlet', outlet);
}

type IssueProposal = ProposerOutput & { action: 'issue' };

function invalid(code: OutletReason['code'], detail?: string, evidence: Evidence | null = null) {
  return {
    decision: 'invalid' as const,
    reasons: [{ code, ...(detail ? { detail } : {}) }],
    evidence,
    ledgerEvent: null,
  };
}

function decided(
  p: IssueProposal,
  ctx: OutletContext,
  accepted: boolean,
  reasons: OutletReason[],
  evidence: Evidence,
): OutletResult {
  const ledgerEvent = sealEvent({
    ts: ctx.now().toISOString(),
    proposalId: ctx.proposalId,
    stage: accepted ? 'candidate-accepted' : 'candidate-rejected',
    path: 'standard',
    ...(ctx.control ? { control: true } : {}),
    pattern: [...p.patterns],
    outlet: p.outlet,
    change: { kind: 'issue', ...(ctx.issueRef ? { ref: ctx.issueRef } : {}) },
    evidence,
    ...(accepted ? {} : { reason: reasons.map((r) => r.code).join(', ') }),
  });
  return { decision: accepted ? 'accept' : 'reject', reasons, evidence, ledgerEvent };
}

async function evaluateRepro(p: IssueProposal, ctx: OutletContext): Promise<OutletResult> {
  const loaded = loadRepros(join(ctx.repoRoot, 'bench'));
  const matching = loaded.repros.filter((r) =>
    ctx.repro
      ? r.spec.id === ctx.repro
      : r.spec.outlets.includes(p.outlet as 'mechanism' | 'doctor') &&
        r.spec.patterns.some((x) => p.patterns.includes(x)),
  );
  if (matching.length === 0) {
    const pinned = ctx.repro
      ? ` named ${ctx.repro}`
      : ` for outlet ${p.outlet} and ${p.patterns.join(', ')}`;
    const broken = loaded.problems.length > 0 ? ` (unloadable: ${loaded.problems.join('; ')})` : '';
    return invalid('no-trusted-repro', `no repro${pinned} under bench/repro/${broken}`);
  }
  const unreviewed = matching.filter((r) => r.spec.reviewed === null);
  if (unreviewed.length > 0) {
    return invalid(
      'repro-unreviewed',
      `${unreviewed.map((r) => r.spec.id).join(', ')}: a repro is trusted only once a human has reviewed it (set "reviewed")`,
    );
  }
  const reproTask = matching
    .map((r) => r.spec.id)
    .sort()
    .join(',');

  const trees = new Checkouts(ctx);
  try {
    const base = await trees.open(ctx.base, 'base');
    if ('error' in base) return invalid(base.code, base.error);
    const cand = await trees.open(ctx.candidate, 'candidate');
    if ('error' in cand) return invalid(cand.code, cand.error);
    const evidence: Evidence = { kind: 'repro', base: base.ref, candidate: cand.ref, reproTask };

    const reasons: OutletReason[] = [];
    for (const r of matching) {
      const onBase = await runRepro(r, base.dir);
      if (onBase.verdict === 'error') {
        return invalid('repro-error', `${r.spec.id} on base: ${tail(onBase.output)}`, evidence);
      }
      if (onBase.verdict === 'pass') {
        return invalid(
          'repro-passes-on-base',
          `${r.spec.id} passes on base ${base.ref}: it does not reproduce the condition there`,
          evidence,
        );
      }
      reasons.push({ code: 'repro-fails-on-base', detail: `${r.spec.id}: ${tail(onBase.output)}` });
      const onCand = await runRepro(r, cand.dir);
      if (onCand.verdict === 'error') {
        return invalid(
          'repro-error',
          `${r.spec.id} on candidate: ${tail(onCand.output)}`,
          evidence,
        );
      }
      if (onCand.verdict === 'fail') {
        return decided(
          p,
          ctx,
          false,
          [
            ...reasons,
            { code: 'repro-fails-on-candidate', detail: `${r.spec.id}: ${tail(onCand.output)}` },
          ],
          evidence,
        );
      }
      reasons.push({ code: 'repro-passes-on-candidate', detail: r.spec.id });
    }
    const suite = await (ctx.checkAll ?? defaultCheckAll)(cand.dir);
    if (!suite.ok) {
      return decided(
        p,
        ctx,
        false,
        [
          ...reasons,
          { code: 'check-all-failed', ...(suite.detail ? { detail: tail(suite.detail) } : {}) },
        ],
        evidence,
      );
    }
    reasons.push({ code: 'check-all-passed' });
    return decided(p, ctx, true, reasons, evidence);
  } finally {
    trees.close();
  }
}

async function evaluateVerify(p: IssueProposal, ctx: OutletContext): Promise<OutletResult> {
  if (!ctx.artifacts) {
    return invalid('no-artifacts', 'the verify outlet needs a faulty and a fixed artifact');
  }
  let text: string | null;
  if (ctx.assertionFile) {
    if (!existsSync(ctx.assertionFile)) {
      return invalid('no-assertion', `no assertion file at ${ctx.assertionFile}`);
    }
    text = readFileSync(ctx.assertionFile, 'utf8');
  } else {
    text = extractAssertion(p.body);
  }
  if (text === null) {
    return invalid(
      'no-assertion',
      'the issue body has no ```json verify block and no assertion file was given',
    );
  }
  const spec = parseAssertion(text);
  if ('error' in spec) return invalid('assertion-invalid', spec.error);
  const check = spec.checks.map((c) => c.id).join(',');

  const trees = new Checkouts(ctx);
  try {
    const faulty = await trees.open(ctx.artifacts.faulty, 'faulty');
    if ('error' in faulty) return invalid(faulty.code, faulty.error);
    const fixed = await trees.open(ctx.artifacts.fixed, 'fixed');
    if ('error' in fixed) return invalid(fixed.code, fixed.error);
    const evidence: Evidence = { kind: 'artifact', check, faulty: faulty.ref, fixed: fixed.ref };
    const run = ctx.runAssertion ?? ((s, a) => defaultRunAssertion(ctx.repoRoot, s, a));
    const serve = ctx.artifacts.serve;

    const onFaulty = await withServed(faulty.dir, serve, (url) =>
      run(spec, { dir: faulty.dir, url }),
    );
    if ('error' in onFaulty)
      return invalid('assertion-error', `faulty: ${onFaulty.error}`, evidence);
    const onFixed = await withServed(fixed.dir, serve, (url) => run(spec, { dir: fixed.dir, url }));
    if ('error' in onFixed) return invalid('assertion-error', `fixed: ${onFixed.error}`, evidence);

    const reasons: OutletReason[] = [
      onFaulty.passed
        ? { code: 'assertion-passes-on-faulty', detail: `${check} does not reject ${faulty.ref}` }
        : {
            code: 'assertion-fails-on-faulty',
            ...(onFaulty.detail ? { detail: tail(onFaulty.detail) } : {}),
          },
      onFixed.passed
        ? { code: 'assertion-passes-on-fixed' }
        : {
            code: 'assertion-fails-on-fixed',
            ...(onFixed.detail ? { detail: tail(onFixed.detail) } : {}),
          },
    ];
    return decided(p, ctx, !onFaulty.passed && onFixed.passed, reasons, evidence);
  } finally {
    trees.close();
  }
}

// ---- trees ----------------------------------------------------------------------------------

type Opened =
  | { dir: string; ref: string }
  | { error: string; code: 'unpinned-tree' | 'checkout-failed' };

/** Opens trees for one evaluation and removes every worktree it added on `close()`. */
class Checkouts {
  private readonly added: string[] = [];
  private readonly scratch: string[] = [];
  constructor(private readonly ctx: OutletContext) {}

  private get repo(): string {
    return this.ctx.sourceRepo ?? 'RTrentJones/greenlight';
  }

  async open(t: OutletTreeRef, label: string): Promise<Opened> {
    if ('dir' in t) {
      const dir = resolve(t.dir);
      if (!existsSync(dir))
        return { error: `${label}: no directory ${dir}`, code: 'checkout-failed' };
      if (t.ref !== undefined) {
        if (!EVIDENCE_REF_RE.test(t.ref)) {
          return { error: `${label}: "${t.ref}" is not an evidence ref`, code: 'unpinned-tree' };
        }
        return { dir, ref: t.ref };
      }
      const head = cleanHead(dir);
      if (!head) {
        return {
          error: `${label}: ${dir} is not a clean git checkout and has no ref, so the result could not be recomputed`,
          code: 'unpinned-tree',
        };
      }
      return { dir, ref: `commit:${this.repo}@${head}` };
    }
    let sha: string;
    try {
      sha = git(this.ctx.repoRoot, ['rev-parse', '--verify', `${t.commit}^{commit}`]);
    } catch (e) {
      return {
        error: `${label}: ${t.commit} is not a commit: ${errMsg(e)}`,
        code: 'checkout-failed',
      };
    }
    const root = mkdtempSync(join(tmpdir(), `greenlight-outlet-${label}-`));
    this.scratch.push(root);
    const dir = join(root, 'tree');
    try {
      git(this.ctx.repoRoot, ['worktree', 'add', '--detach', dir, sha]);
      this.added.push(dir);
      await (this.ctx.prepareTree ?? defaultPrepareTree)(dir);
    } catch (e) {
      return {
        error: `${label}: could not check out ${sha}: ${errMsg(e)}`,
        code: 'checkout-failed',
      };
    }
    return { dir, ref: `commit:${this.repo}@${sha}` };
  }

  close(): void {
    for (const dir of this.added) {
      try {
        git(this.ctx.repoRoot, ['worktree', 'remove', '--force', dir]);
      } catch {
        // removed below; prune drops the registration
      }
    }
    for (const s of this.scratch) rmSync(s, { recursive: true, force: true });
    if (this.added.length > 0) {
      try {
        git(this.ctx.repoRoot, ['worktree', 'prune']);
      } catch {
        // best effort
      }
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

/** HEAD of a clean git checkout rooted at `dir`, else null. */
function cleanHead(dir: string): string | null {
  try {
    if (resolve(git(dir, ['rev-parse', '--show-toplevel'])) !== dir) return null;
    if (git(dir, ['status', '--porcelain', '--untracked-files=normal']) !== '') return null;
    return git(dir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

async function defaultPrepareTree(tree: string): Promise<void> {
  const res = await runProcess(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'],
    { cwd: tree, env: { ...process.env } as Record<string, string>, timeoutMs: 600_000 },
  );
  if (res.code !== 0) throw new Error(`pnpm install failed:\n${tail(res.output)}`);
}

async function defaultCheckAll(tree: string): Promise<{ ok: boolean; detail?: string }> {
  const res = await runProcess('pnpm', ['run', 'check-all'], {
    cwd: tree,
    env: { ...process.env, CI: '1' } as Record<string, string>,
    timeoutMs: 3_600_000,
  });
  return { ok: res.code === 0 && !res.timedOut, detail: res.output };
}

// ---- serving an artifact and running verify -------------------------------------------------

async function withServed<T>(
  dir: string,
  serve: NonNullable<OutletContext['artifacts']>['serve'],
  fn: (url: string) => Promise<T>,
): Promise<T | { error: string }> {
  const [bin, ...args] = serve.command;
  if (!bin) return { error: 'serve.command is empty' };
  const port = await freeLocalPort();
  const home = mkdtempSync(join(tmpdir(), 'greenlight-artifact-home-'));
  const proc = spawn(bin === 'node' ? process.execPath : bin, args, {
    cwd: dir,
    env: { ...scrubbedEnv(home), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  const append = (b: Buffer) => {
    out = (out + b.toString()).slice(-8000);
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  proc.once('error', (e) => {
    append(Buffer.from(`spawn error: ${e.message}\n`));
    exited = true;
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + (serve.readyTimeoutMs ?? 15_000);
    for (;;) {
      if (exited) return { error: `the artifact exited before listening:\n${tail(out)}` };
      try {
        await fetch(url + (serve.readyPath ?? '/'), { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        if (Date.now() > deadline)
          return { error: `the artifact did not listen in time:\n${tail(out)}` };
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn(url);
    } catch (e) {
      return { error: errMsg(e) };
    }
  } finally {
    killGroup(proc.pid);
    rmSync(home, { recursive: true, force: true });
  }
}

async function defaultRunAssertion(
  repoRoot: string,
  spec: AssertionSpec,
  artifact: { url: string },
): Promise<{ passed: boolean; detail?: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'greenlight-assertion-'));
  try {
    const specPath = join(scratch, 'proposed.config.mjs');
    // A JSON literal only: the proposer's text is never evaluated as code.
    writeFileSync(specPath, `export default ${JSON.stringify(spec, null, 2)};\n`);
    const home = join(scratch, 'home');
    mkdirSync(home);
    const res = await runProcess(
      process.execPath,
      [
        '--import',
        tsxLoader(repoRoot),
        join(repoRoot, 'cli', 'src', 'bin.ts'),
        'verify',
        '--url',
        artifact.url,
        '--spec',
        specPath,
      ],
      { cwd: scratch, env: scrubbedEnv(home), timeoutMs: 120_000 },
    );
    if (res.timedOut) throw new Error(`verify timed out:\n${tail(res.output)}`);
    if (res.code !== 0 && res.code !== 1)
      throw new Error(`verify errored (${res.code}):\n${tail(res.output)}`);
    return { passed: res.code === 0, detail: res.output };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function tsxLoader(repoRoot: string): string {
  const loader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (!existsSync(loader))
    throw new Error(`no tsx under ${repoRoot}/node_modules (run pnpm install)`);
  return `file://${loader}`;
}

// ---- processes ------------------------------------------------------------------------------

function scrubbedEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TZ: 'UTC' };
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((res) => {
    let out = '';
    let timedOut = false;
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const append = (b: Buffer) => {
      out = (out + b.toString()).slice(-64_000);
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(proc.pid);
    }, opts.timeoutMs);
    proc.once('error', (e) => {
      clearTimeout(timer);
      res({ code: null, output: `${out}spawn error: ${e.message}\n`, timedOut });
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      killGroup(proc.pid);
      res({ code, output: out, timedOut });
    });
  });
}

function freeLocalPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

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

// ---- helpers --------------------------------------------------------------------------------

function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const s = String((e as { stderr: unknown }).stderr ?? '').trim();
    if (s) return s;
  }
  return e instanceof Error ? e.message : String(e);
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function tail(s: string, lines = 15): string {
  return s.trimEnd().split('\n').slice(-lines).join('\n');
}
