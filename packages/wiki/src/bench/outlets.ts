import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EVIDENCE_REF_RE } from '@rtrentjones/greenlight-shared';
import { z } from 'zod';
import type { TaskSpec } from '../schema/bench';
import { IsoDate, KebabSlug } from '../schema/common';
import { type ProposerOutput, ProposerOutputSchema } from '../schema/io';
import { type EvidenceSchema, type LedgerEvent, sealEvent } from '../schema/ledger';
import { AGENT_UID, type RunnerImage, dockerAvailable, ensureRunnerImage } from './sandbox';

/**
 * Outlet evaluation for the outlets a human applies (vision 06 §3.5, §5.6; roadmap M2-02). The
 * skill outlet goes through the gate (gate.ts); everything else comes here:
 *
 * - **mechanism / doctor**: a `repro` grader (06 §4.6). A trusted reproduction, a fixture plus a
 *   script reviewed by a human, lives at `bench/repro/<slug>/{repro.json,run.mjs}` in the
 *   harness's own tree (`ctx.repoRoot`), never in the candidate, so a candidate cannot rewrite the
 *   test it is judged by. It runs against the base and the candidate trees. Accept iff it fails on
 *   base, passes on the candidate, and the harness's `check-all` commands pass on the candidate.
 *   The candidate is never run as it stands: the evaluated tree is a fresh copy of the BASE with
 *   the candidate's diff overlaid (`buildEvaluatedTree`), and a diff that touches the harness's
 *   own configuration (`HARNESS_CONFIG_PATHS`: any package.json, the lockfile and workspace,
 *   .npmrc/.pnpmfile, turbo/vitest/biome/tsconfig/depcruise configs, `scripts/`, `.github/`,
 *   `bench/`) is `invalid` (`candidate-touches-harness-config`). Dependencies come from the base
 *   lockfile only (`--frozen-lockfile --ignore-scripts --ignore-pnpmfile`, registry pinned);
 *   a candidate's `node_modules`, `.git`, `.turbo` and `*.tsbuildinfo` are never copied.
 *   check-all then runs inside the docker sandbox (`runSandboxedCheckAll`: uid 10000, read-only
 *   root, `--network none`, no capabilities, only the evaluated tree mounted, a fresh `.git` with
 *   no remote and no credentials, no harness environment). Without docker the outlet is
 *   `invalid` (`no-sandbox`): candidate code never runs unsandboxed.
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
  /** Installs a tree's dependencies from its (base) lockfile: a checked-out base commit, and the
   * evaluated tree (default: `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
   * --ignore-pnpmfile --config.registry=<DEFAULT_REGISTRY>`, in `installEnv()`: no secrets). Never
   * run on a given directory, and never on the candidate as it stands. */
  prepareTree?: (tree: string) => Promise<void>;
  /** The framework suite on the evaluated tree (default: `runSandboxedCheckAll`, the HARNESS
   * tree's `check-all` commands inside the docker sandbox; `unavailable` when there is no
   * sandbox, which makes the evaluation `invalid`). Tests inject it. */
  checkAll?: (tree: string) => Promise<CheckAllResult>;
  /** verify outlet: runs the assertion against one served artifact (default: the harness CLI's
   * `greenlight verify --url <served> --spec <assertion>`). */
  runAssertion?: (
    spec: AssertionSpec,
    artifact: { dir: string; url: string },
  ) => Promise<{ passed: boolean; detail?: string }>;
}

export interface CheckAllResult {
  ok: boolean;
  detail?: string;
  /** No sandbox could run the suite (no docker, no runner image): neither a pass nor a fail. */
  unavailable?: boolean;
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
  'candidate-touches-harness-config',
  'candidate-unsafe-tree',
  'no-sandbox',
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
    // The candidate is only READ (its diff against the base): never installed, never run.
    const cand = await trees.open(ctx.candidate, 'candidate', { install: false });
    if ('error' in cand) return invalid(cand.code, cand.error);
    const evidence: Evidence = { kind: 'repro', base: base.ref, candidate: cand.ref, reproTask };
    const evaluated = await trees.evaluated(base.dir, cand.dir);
    if ('error' in evaluated) return invalid(evaluated.code, evaluated.error, evidence);

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
      const onCand = await runRepro(r, evaluated.dir);
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
    const suite = await (ctx.checkAll ?? ((t) => runSandboxedCheckAll(ctx.repoRoot, t)))(
      evaluated.dir,
    );
    if (suite.unavailable) {
      return invalid(
        'no-sandbox',
        `check-all runs candidate code only inside the docker sandbox: ${suite.detail ?? 'unavailable'}`,
        evidence,
      );
    }
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

  /** The evaluated tree: a fresh copy of `baseDir` with the candidate's diff overlaid, its
   * dependencies installed from the base lockfile, and a fresh `.git` (no remote, no config). */
  async evaluated(
    baseDir: string,
    candDir: string,
  ): Promise<
    | { dir: string }
    | {
        error: string;
        code: 'candidate-touches-harness-config' | 'candidate-unsafe-tree' | 'checkout-failed';
      }
  > {
    const root = mkdtempSync(join(tmpdir(), 'greenlight-outlet-evaluated-'));
    this.scratch.push(root);
    const dir = join(root, 'tree');
    const built = buildEvaluatedTree(baseDir, candDir, dir);
    if ('refused' in built) {
      return built.refused === 'harness-config'
        ? {
            error: `the candidate changes the harness's own configuration (${built.paths.slice(0, 10).join(', ')}${built.paths.length > 10 ? ', …' : ''}); such a change is reviewed by a human, never evaluated`,
            code: 'candidate-touches-harness-config',
          }
        : {
            error: `the candidate tree has a link that leaves it: ${built.paths.join(', ')}`,
            code: 'candidate-unsafe-tree',
          };
    }
    try {
      await (this.ctx.prepareTree ?? defaultPrepareTree)(dir);
      freshGit(dir);
    } catch (e) {
      return { error: `evaluated tree: ${errMsg(e)}`, code: 'checkout-failed' };
    }
    return { dir };
  }

  async open(t: OutletTreeRef, label: string, o: { install?: boolean } = {}): Promise<Opened> {
    if ('dir' in t) {
      const dir = resolve(t.dir);
      if (!existsSync(dir))
        return { error: `${label}: no directory ${dir}`, code: 'checkout-failed' };
      if (t.ref !== undefined) {
        if (!EVIDENCE_REF_RE.test(t.ref)) {
          return { error: `${label}: "${t.ref}" is not an evidence ref`, code: 'unpinned-tree' };
        }
        // A commit ref names that commit only when the directory IS it: a clean checkout whose
        // HEAD is the named sha. Anything else would put an unverifiable commit in the evidence.
        const named = /^commit:[\w.-]+\/[\w.-]+@([0-9a-f]{7,40})$/.exec(t.ref)?.[1];
        if (named !== undefined) {
          const at = cleanHead(dir);
          if (!at || !at.startsWith(named)) {
            return {
              error: `${label}: ${dir} is ${at ? `at ${at}` : 'not a clean git checkout'}, not the ${t.ref} it is named as`,
              code: 'unpinned-tree',
            };
          }
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
      if (o.install !== false) await (this.ctx.prepareTree ?? defaultPrepareTree)(dir);
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
export function cleanHead(dir: string): string | null {
  try {
    if (resolve(git(dir, ['rev-parse', '--show-toplevel'])) !== dir) return null;
    if (git(dir, ['status', '--porcelain', '--untracked-files=normal']) !== '') return null;
    return git(dir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/** Environment variables a dependency install may need (the store, the proxy, CA bundles) and
 * nothing else: no API key or token of the harness reaches a candidate tree's install. */
const INSTALL_ENV_ALLOW = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'PNPM_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];

export function installEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { CI: '1' };
  for (const k of INSTALL_ENV_ALLOW) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The registry every install uses: the harness's default, never one a tree configures. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

async function defaultPrepareTree(tree: string): Promise<void> {
  // --ignore-scripts and --ignore-pnpmfile: nothing of the tree's runs during the install; the
  // registry is the harness's, whatever the tree's .npmrc says.
  const res = await runProcess(
    'pnpm',
    [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      `--config.registry=${DEFAULT_REGISTRY}`,
    ],
    { cwd: tree, env: installEnv(), timeoutMs: 600_000 },
  );
  if (res.code !== 0) throw new Error(`pnpm install failed:\n${tail(res.output)}`);
}

// ---- the evaluated tree: base + the candidate's diff ------------------------------------------

/**
 * Paths a candidate may not change (vision 06 §5.6): everything that decides what the install,
 * check-all and the bench run, so a candidate cannot rewrite the suite it is judged by. Matched on
 * the repo-relative posix path; a basename rule applies at any depth.
 */
export const HARNESS_CONFIG_PATHS: readonly { rule: string; re: RegExp }[] = [
  { rule: 'package.json', re: /(^|\/)package\.json$/ },
  { rule: 'pnpm-lock.yaml', re: /(^|\/)pnpm-lock\.yaml$/ },
  { rule: 'pnpm-workspace.yaml', re: /(^|\/)pnpm-workspace\.yaml$/ },
  { rule: '.npmrc', re: /(^|\/)\.npmrc$/ },
  { rule: '.pnpmfile.cjs', re: /(^|\/)\.pnpmfile\.c?js$/ },
  { rule: 'turbo.json', re: /(^|\/)turbo\.jsonc?$/ },
  { rule: 'vitest.config.*', re: /(^|\/)vite(st)?\.(config|workspace)\.[\w.]+$/ },
  { rule: 'biome.json*', re: /(^|\/)biome\.jsonc?$/ },
  { rule: 'tsconfig*.json', re: /(^|\/)tsconfig[^/]*\.json$/ },
  { rule: '.dependency-cruiser.cjs', re: /(^|\/)\.dependency-cruiser\.[cm]?js$/ },
  { rule: 'scripts/**', re: /^scripts\// },
  { rule: '.github/**', re: /^\.github\// },
  { rule: 'bench/**', re: /^bench\// },
];

/** Never copied from either tree: dependencies, git state, and build caches a candidate could
 * plant (a turbo cache hit or a tsbuildinfo would skip the very check it records). */
const NEVER_COPIED_DIRS = new Set(['node_modules', '.git', '.turbo']);
const neverCopied = (name: string, isDir: boolean) =>
  isDir ? NEVER_COPIED_DIRS.has(name) : name === '.git' || name.endsWith('.tsbuildinfo');

export type TreeEntry =
  | { kind: 'file'; hash: string; exec: boolean }
  | { kind: 'link'; target: string };

/** Every file and link of a tree, by repo-relative posix path (`neverCopied` names skipped). */
export function listTreeEntries(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (neverCopied(name, st.isDirectory())) continue;
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink())
        out.set(r, { kind: 'link', target: readlinkSync(join(root, r)) });
      else if (st.isFile()) {
        const hash = createHash('sha256')
          .update(readFileSync(join(root, r)))
          .digest('hex');
        out.set(r, { kind: 'file', hash, exec: (st.mode & 0o111) !== 0 });
      }
      // sockets, fifos, devices: never part of a tree
    }
  };
  walk('');
  return out;
}

const sameEntry = (a: TreeEntry | undefined, b: TreeEntry | undefined) =>
  !!a &&
  !!b &&
  (a.kind === 'file'
    ? b.kind === 'file' && a.hash === b.hash && a.exec === b.exec
    : b.kind === 'link' && a.target === b.target);

/** The candidate's diff against the base: every path added or changed, and every one removed. */
export function candidateDiff(
  baseDir: string,
  candDir: string,
): {
  changed: string[];
  removed: string[];
  base: Map<string, TreeEntry>;
  candidate: Map<string, TreeEntry>;
} {
  const base = listTreeEntries(baseDir);
  const candidate = listTreeEntries(candDir);
  const changed = [...candidate.keys()].filter((p) => !sameEntry(base.get(p), candidate.get(p)));
  const removed = [...base.keys()].filter((p) => !candidate.has(p));
  return { changed, removed, base, candidate };
}

/** The paths that touch the harness's configuration (`HARNESS_CONFIG_PATHS`). */
export function harnessConfigTouches(paths: readonly string[]): string[] {
  return paths.filter((p) => HARNESS_CONFIG_PATHS.some((r) => r.re.test(p)));
}

/**
 * Writes `dest`: a copy of the base tree with the candidate's diff overlaid. Refuses, writing
 * nothing, a diff that touches the harness's configuration or adds a link that points out of the
 * tree. Neither tree's `node_modules`, `.git`, `.turbo` or tsbuildinfo is copied.
 */
export function buildEvaluatedTree(
  baseDir: string,
  candDir: string,
  dest: string,
):
  | { ok: true; changed: string[]; removed: string[] }
  | { refused: 'harness-config' | 'unsafe-link'; paths: string[] } {
  const d = candidateDiff(baseDir, candDir);
  const touched = harnessConfigTouches([...d.changed, ...d.removed]);
  if (touched.length > 0) return { refused: 'harness-config', paths: touched };
  const escapes = (p: string, target: string) =>
    isAbsolute(target) || relative('.', join(dirname(p), target)).split('/')[0] === '..';
  const badLinks = d.changed.filter((p) => {
    const e = d.candidate.get(p);
    return e?.kind === 'link' && escapes(p, e.target);
  });
  if (badLinks.length > 0) return { refused: 'unsafe-link', paths: badLinks };
  mkdirSync(dest, { recursive: true });
  const place = (from: string, rel: string, e: TreeEntry) => {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (e.kind === 'link') symlinkSync(e.target, to);
    else {
      copyFileSync(join(from, rel), to);
      chmodSync(to, e.exec ? 0o755 : 0o644);
    }
  };
  const changed = new Set(d.changed);
  for (const [rel, e] of d.base) {
    if (d.candidate.has(rel) && !changed.has(rel)) place(baseDir, rel, e);
  }
  for (const rel of d.changed) place(candDir, rel, d.candidate.get(rel) as TreeEntry);
  return { ok: true, changed: d.changed, removed: d.removed };
}

/** A fresh repository holding `dir` as one commit: no remote, and neither the system nor the
 * global config (so no harness credential or extraheader), for checks that need a git tree. */
function freshGit(dir: string): void {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'greenlight-bench',
    GIT_AUTHOR_EMAIL: 'bench@greenlight.invalid',
    GIT_COMMITTER_NAME: 'greenlight-bench',
    GIT_COMMITTER_EMAIL: 'bench@greenlight.invalid',
  };
  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-q', '--no-verify', '--allow-empty', '-m', 'evaluated tree']);
}

/**
 * The framework suite's commands, from the HARNESS tree's `package.json` (`scripts["check-all"]`),
 * never the candidate's: a candidate that rewrites `"check-all": "true"` (or any script it chains)
 * is judged by the harness's suite all the same. `pnpm <script>` / `pnpm run <script>` steps are
 * expanded through the harness's scripts until only leaf commands remain.
 */
export function checkAllCommands(harnessRoot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const top = scripts['check-all'];
  if (!top) throw new Error(`no check-all script in ${harnessRoot}/package.json`);
  const expand = (cmd: string, depth: number): string[] =>
    cmd
      .split('&&')
      .map((x) => x.trim())
      .filter(Boolean)
      .flatMap((part) => {
        const m = /^pnpm\s+(?:run\s+)?([\w:.-]+)$/.exec(part);
        const sub = m ? scripts[m[1] as string] : undefined;
        if (sub === undefined) return [part];
        if (depth > 8) throw new Error(`check-all expands too deep at ${part}`);
        return expand(sub, depth + 1);
      });
  return expand(top, 0);
}

/**
 * The `pnpm` inside the check-all sandbox: `pnpm run <script>` and `--version` only (what turbo
 * needs), reading the script from the package.json in its cwd. The host's pnpm (a glibc binary in
 * CI) never enters the container, and nothing installs there: the network is off.
 */
const SANDBOX_PNPM = String.raw`#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--config.'));
if (args[0] === '--version' || args[0] === '-v') { console.log(process.env.GL_PNPM_VERSION || '10.0.0'); process.exit(0); }
const rest = args[0] === 'run' || args[0] === 'run-script' ? args.slice(1) : args;
const name = rest[0];
const pkgFile = join(process.cwd(), 'package.json');
const scripts = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')).scripts || {} : {};
if (!name || scripts[name] === undefined) { console.error('sandbox pnpm: no script "' + name + '" in ' + pkgFile); process.exit(1); }
const bins = [];
for (let d = process.cwd(); ; d = dirname(d)) { const b = join(d, 'node_modules', '.bin'); if (existsSync(b)) bins.push(b); if (dirname(d) === d) break; }
const q = (s) => "'" + s.split("'").join("'\\''") + "'";
const cmd = [scripts[name], ...rest.slice(1).filter((a) => a !== '--').map(q)].join(' ');
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env: { ...process.env, PATH: [...bins, process.env.PATH].join(':'), npm_lifecycle_event: name } });
process.exit(r.status === null ? 1 : r.status);
`;

export interface SandboxedCheckAllOptions {
  docker?: string;
  /** The runner image (default: `ensureRunnerImage(<harness>/bench/runner)`). */
  image?: RunnerImage;
  /** Per command (default 1 h). */
  timeoutMs?: number;
  memory?: string;
  cpus?: string;
}

/** Makes the evaluated tree writable by the sandbox's uid: every directory, and every file
 * outside node_modules (whose files are hard links into the pnpm store and stay as they are). */
function openTreeTo(root: string): void {
  const walk = (dir: string, inModules: boolean) => {
    chmodSync(dir, 0o777);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, inModules || name === 'node_modules');
      else if (st.isFile() && !inModules) chmodSync(p, st.mode | 0o666);
    }
  };
  walk(root, false);
}

const DOCKER_CLIENT_ENV = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

/**
 * The harness's check-all commands (`checkAllCommands(harnessRoot)`) on the evaluated `tree`,
 * each in a fresh container of the bench runner image: uid 10000 (group shim, so git runs),
 * `--network none`, `--read-only` root, `--cap-drop ALL`, `no-new-privileges`, pid/memory/cpu
 * limits, tmpfs HOME and /tmp, and exactly one writable bind mount, the tree, at its host path
 * (pnpm's .bin shims name absolute paths). Two read-only helpers: the `pnpm run` shim and a git
 * system config that trusts the tree. No harness environment variable enters the container (the
 * docker client's own environment is not forwarded). Without docker or the runner image the
 * result is `unavailable`, never a pass or a fail.
 */
export async function runSandboxedCheckAll(
  harnessRoot: string,
  tree: string,
  o: SandboxedCheckAllOptions = {},
): Promise<CheckAllResult> {
  const docker = o.docker ?? 'docker';
  if (!dockerAvailable(docker)) {
    return { ok: false, unavailable: true, detail: 'docker is not available' };
  }
  let image: RunnerImage;
  try {
    image = o.image ?? ensureRunnerImage(join(harnessRoot, 'bench', 'runner'), { docker });
  } catch (e) {
    return { ok: false, unavailable: true, detail: `no runner image: ${errMsg(e)}` };
  }
  const commands = checkAllCommands(harnessRoot);
  const dir = resolve(tree);
  const harnessPkg = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const pnpmVersion = /^pnpm@([\w.-]+)/.exec(harnessPkg.packageManager ?? '')?.[1] ?? '10.0.0';
  const clientEnv: Record<string, string> = {};
  for (const k of DOCKER_CLIENT_ENV) {
    const v = process.env[k];
    if (v !== undefined) clientEnv[k] = v;
  }
  const aux = mkdtempSync(join(tmpdir(), 'greenlight-check-all-aux-'));
  const runArgs = (name: string) => [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '4096',
    '--memory',
    o.memory ?? '6g',
    '--cpus',
    o.cpus ?? '2',
    '-u',
    `${AGENT_UID}:${image.shimUid}`,
    '--tmpfs',
    '/tmp:rw,exec,mode=1777,size=2g',
    '--tmpfs',
    `/home/agent:rw,exec,mode=0700,uid=${AGENT_UID},gid=${AGENT_UID},size=256m`,
    '-v',
    `${dir}:${dir}`,
    '-v',
    `${join(aux, 'bin')}:/opt/gl-bin:ro`,
    '-v',
    `${join(aux, 'git.cfg')}:/etc/gitconfig:ro`,
    '-w',
    dir,
    '-e',
    'HOME=/home/agent',
    '-e',
    'TZ=UTC',
    '-e',
    'TURBO_TELEMETRY_DISABLED=1',
    '-e',
    `GL_PNPM_VERSION=${pnpmVersion}`,
    '-e',
    `PATH=/opt/gl-bin:${dir}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    image.tag,
  ];
  const stamp = createHash('sha256')
    .update(`${dir}${Date.now()}${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
  const dockerRun = (name: string, script: string, timeoutMs: number) =>
    runProcess(docker, [...runArgs(name), 'sh', '-c', script], {
      cwd: aux,
      env: clientEnv,
      timeoutMs,
    });
  try {
    mkdirSync(join(aux, 'bin'));
    writeFileSync(join(aux, 'bin', 'pnpm'), SANDBOX_PNPM, { mode: 0o755 });
    writeFileSync(join(aux, 'git.cfg'), '[safe]\n\tdirectory = *\n', { mode: 0o644 });
    chmodSync(aux, 0o755);
    chmodSync(join(aux, 'bin'), 0o755);
    openTreeTo(dir);
    let detail = '';
    let i = 0;
    for (const cmd of commands) {
      const name = `gl-check-all-${stamp}-${i++}`;
      const res = await dockerRun(name, `umask 000; ${cmd}`, o.timeoutMs ?? 3_600_000);
      if (res.timedOut) {
        await runProcess(docker, ['rm', '-f', name], {
          cwd: aux,
          env: clientEnv,
          timeoutMs: 60_000,
        });
      }
      detail = `$ ${cmd}\n${res.output}`;
      // 125: docker itself could not start the container; that is no verdict on the candidate.
      if (res.code === 125) {
        return { ok: false, unavailable: true, detail: `docker run failed: ${tail(res.output)}` };
      }
      if (res.code !== 0 || res.timedOut) return { ok: false, detail };
    }
    return { ok: true, detail };
  } finally {
    // What the sandbox's uid created must stay removable by the host user.
    await dockerRun(
      `gl-check-all-${stamp}-fix`,
      `find ${shq(dir)} -user ${AGENT_UID} -exec chmod a+rwX {} + 2>/dev/null; true`,
      120_000,
    );
    rmSync(aux, { recursive: true, force: true });
  }
}

const shq = (s: string) => `'${s.split("'").join(`'\\''`)}'`;

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
