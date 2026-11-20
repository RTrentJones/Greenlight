import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProposerOutput } from '../../schema/io';
import { sealEvent } from '../../schema/ledger';
import { extractAssertion, parseAssertion } from './assertion';
import type { OutletContext } from './context';
import { tail } from './helpers';
import { loadRepros, runSandboxedRepro } from './repro';
import { runSandboxedCheckAll, snapshotDrift, treeSnapshot } from './sandbox';
import { defaultRunAssertion, withServed } from './serve';
import { Checkouts } from './trees';
import type { Evidence, OutletReason, OutletResult } from './types';

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
  const repro = ctx.runRepro ?? ((r, t) => runSandboxedRepro(ctx.repoRoot, r, t));
  let notes: string[] = [];
  const withNotes = (r: OutletResult): OutletResult => (notes.length > 0 ? { ...r, notes } : r);
  try {
    const base = await trees.open(ctx.base, 'base');
    if ('error' in base) return invalid(base.code, base.error);
    // The candidate is only READ (its diff against the base): never installed, never run.
    const cand = await trees.open(ctx.candidate, 'candidate', { install: false });
    if ('error' in cand) return invalid(cand.code, cand.error);
    const evidence: Evidence = { kind: 'repro', base: base.ref, candidate: cand.ref, reproTask };
    const evaluated = await trees.evaluated(base.dir, cand.dir);
    if ('error' in evaluated) return invalid(evaluated.code, evaluated.error, evidence);
    notes = evaluated.notes;
    // The pristine evaluated tree: nothing run on it may change it (06 §5.6).
    const pristine = treeSnapshot(evaluated.dir);
    const drifted = (when: string) => {
      const d = snapshotDrift(pristine, treeSnapshot(evaluated.dir));
      return d
        ? withNotes(
            invalid('candidate-mutated-tree', `the evaluated tree changed ${when}: ${d}`, evidence),
          )
        : null;
    };
    const noSandbox = (what: string, detail: string) =>
      withNotes(
        invalid(
          'no-sandbox',
          `${what} runs tree code only inside the docker sandbox: ${detail}`,
          evidence,
        ),
      );

    const reasons: OutletReason[] = [];
    for (const r of matching) {
      const onBase = await repro(r, base.dir);
      if (onBase.unavailable) return noSandbox(`the repro ${r.spec.id}`, tail(onBase.output));
      if (onBase.verdict === 'error') {
        return withNotes(
          invalid('repro-error', `${r.spec.id} on base: ${tail(onBase.output)}`, evidence),
        );
      }
      if (onBase.verdict === 'pass') {
        return withNotes(
          invalid(
            'repro-passes-on-base',
            `${r.spec.id} passes on base ${base.ref}: it does not reproduce the condition there`,
            evidence,
          ),
        );
      }
      reasons.push({ code: 'repro-fails-on-base', detail: `${r.spec.id}: ${tail(onBase.output)}` });
      const before = drifted(`before the repro ${r.spec.id}`);
      if (before) return before;
      const onCand = await repro(r, evaluated.dir);
      const after = drifted(`under the repro ${r.spec.id}`);
      if (after) return after;
      if (onCand.unavailable) return noSandbox(`the repro ${r.spec.id}`, tail(onCand.output));
      if (onCand.verdict === 'error') {
        return withNotes(
          invalid('repro-error', `${r.spec.id} on candidate: ${tail(onCand.output)}`, evidence),
        );
      }
      if (onCand.verdict === 'fail') {
        return withNotes(
          decided(
            p,
            ctx,
            false,
            [
              ...reasons,
              { code: 'repro-fails-on-candidate', detail: `${r.spec.id}: ${tail(onCand.output)}` },
            ],
            evidence,
          ),
        );
      }
      reasons.push({ code: 'repro-passes-on-candidate', detail: r.spec.id });
    }
    const suite = await (
      ctx.checkAll ??
      ((t) =>
        runSandboxedCheckAll(ctx.repoRoot, t, {
          verify: () => snapshotDrift(pristine, treeSnapshot(t)),
        }))
    )(evaluated.dir);
    const afterSuite = drifted('under check-all');
    if (afterSuite) return afterSuite;
    if (suite.mutated) {
      return withNotes(
        invalid(
          'candidate-mutated-tree',
          `the evaluated tree changed under check-all: ${suite.mutated}`,
          evidence,
        ),
      );
    }
    if (suite.unavailable) return noSandbox('check-all', suite.detail ?? 'unavailable');
    if (!suite.ok) {
      return withNotes(
        decided(
          p,
          ctx,
          false,
          [
            ...reasons,
            { code: 'check-all-failed', ...(suite.detail ? { detail: tail(suite.detail) } : {}) },
          ],
          evidence,
        ),
      );
    }
    reasons.push({ code: 'check-all-passed' });
    return withNotes(decided(p, ctx, true, reasons, evidence));
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
