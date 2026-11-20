import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import {
  PROPOSAL_FILE,
  PROPOSER_PROMPT,
  buildProposerBundle,
  checkProposal,
  listTraces,
  loadRawStore,
  openBundle,
  readTarget,
  recordAccess,
  writeBundle,
} from '../../bundle';
import { type LintContext, introducedErrors, lint } from '../../lint';
import { isExternalRole } from '../../llm';
import { RequestBudget } from '../../llm/limits';
import { type ReactTool, runReact } from '../../llm/react';
import { loadWiki } from '../../load';
import {
  PROPOSER_OUTPUT_JSON_SCHEMA,
  type ProposerOutput,
  ProposerOutputSchema,
  normalizeProposerOutput,
  sealEvent,
} from '../../schema';
import { loadSkills } from '../../skills';
import {
  type Ctx,
  type StepOutcome,
  heldOut,
  ledgerEvents,
  stop,
  uniqueProposalId,
} from './context';
import { materializeCandidate } from './evaluate';
import {
  awaitAgent,
  bundleFileTools,
  bundleIssued,
  chargeSpend,
  externalBundleDir,
  handbackLines,
  readSubmission,
  refuseSubmission,
  resumable,
  roleClient,
  zodIssue,
  zodIssues,
} from './roles';
import { MAX_SUBMISSIONS } from './types';

// ---- step 4: proposer -------------------------------------------------------------------------

function proposerTools(c: Ctx, bundleDir: string): ReactTool[] {
  const o = c.o;
  const bundle = openBundle(bundleDir, c.keysDir);
  const records = () => loadRawStore(join(c.stateDir, 'raw')).records;
  const files = bundleFileTools(bundleDir).filter((t) => t.name === 'read_file');
  return [
    ...files,
    {
      name: 'wiki_read',
      description:
        '`greenlight wiki read <ref>`: a wiki page id, raw:<rawId> (an execution trace) or skill:<name> (SKILL.md and PURPOSE.md). Every read is logged.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
      run: (a) => {
        const ref = String(a.ref ?? '');
        const result = readTarget(ref, 'proposer', {
          wiki: loadWiki(o.wikiRoot),
          records: ref.startsWith('raw:') ? records() : [],
          skillsDir: o.skillsDir,
          ...(c.splits ? { splits: c.splits } : {}),
        });
        recordAccess(bundle, {
          ts: c.now().toISOString(),
          command: 'read',
          target: ref,
          ...(result.ok ? {} : { refused: result.message }),
        });
        if (!result.ok) throw new Error(result.message);
        return result.text;
      },
    },
    {
      name: 'wiki_traces',
      description:
        '`greenlight wiki traces`: raw ids of execution traces you may read, newest first (field and training records only).',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          failed: { type: 'boolean' },
          passing: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
      run: (a) => {
        const limit =
          Number.isInteger(a.limit) && (a.limit as number) > 0 ? (a.limit as number) : 20;
        const rows = listTraces(records(), {
          ...(typeof a.skill === 'string' && a.skill ? { skill: a.skill } : {}),
          failed: a.failed === true,
          passing: a.passing === true,
          limit,
          ...(c.splits ? { splits: c.splits } : {}),
        });
        const args = [
          ...(typeof a.skill === 'string' && a.skill ? ['--skill', a.skill] : []),
          ...(a.failed === true ? ['--failed'] : []),
          ...(a.passing === true ? ['--passing'] : []),
          '--limit',
          String(limit),
        ];
        recordAccess(bundle, {
          ts: c.now().toISOString(),
          command: 'traces',
          target: args.join(' '),
        });
        return rows
          .map(
            (r) =>
              `${r.rawId}  ${r.tool}  ${r.kind}${r.bench ? ` ${r.bench.task}` : ''}  ${r.passed ? 'passed' : 'failed'}  ${r.startedAt}`,
          )
          .join('\n');
      },
    },
  ];
}

/** Lint LR-11/LR-12 on a candidate skill set: only findings the change introduces count. */
function skillLintErrors(c: Ctx, candidateSkills: string): string[] {
  const wiki = loadWiki(c.o.wikiRoot);
  const ctx = (dir: string): LintContext => ({ kind: 'framework', skills: loadSkills(dir) });
  return introducedErrors(lint(wiki, ctx(c.o.skillsDir)), lint(wiki, ctx(candidateSkills)))
    .filter((f) => f.rule === 'LR-11' || f.rule === 'LR-12')
    .map((f) => `${f.rule} ${f.page}: ${f.message}`);
}

/** Builds and writes the next proposer bundle of the iteration (06 §3.1). It holds `index.md`,
 * `skill-impact.md`, `outcomes.md`, `PROMPT.md`, `bundle.json` and an empty `access.jsonl`: never
 * a raw record. Traces are served only by the logged `wiki read raw:<id>`. */
function writeProposerBundle(c: Ctx, external: boolean) {
  const o = c.o;
  const p = c.s.proposer;
  const store = loadRawStore(join(c.stateDir, 'raw'));
  const managed = loadSkills(o.skillsDir).map((s) => s.name);
  const scope = c.s.settings.scope;
  p.attempts += 1;
  const bundleId = `${c.s.iterationId}-proposer-${p.attempts}`;
  const bundleDir = join(c.dir, 'bundles', bundleId);
  const bundle = buildProposerBundle({
    id: bundleId,
    dir: external ? bundleDir : 'bundle',
    ...(external ? { handback: handbackLines(c, 'proposer', bundleDir) } : {}),
    wiki: loadWiki(o.wikiRoot),
    records: store.records,
    skills: scope === 'all' ? managed : [scope],
    ...(scope !== 'all' ? { skill: scope } : {}),
    heldOutTaskIds: heldOut(c.splits, store.records),
    ...(c.splits ? { splits: c.splits } : {}),
    acceptedSkillSetHash: c.s.acceptedSkillSetHash,
    now: c.now(),
  });
  rmSync(bundleDir, { recursive: true, force: true });
  writeBundle(bundleDir, bundle, { keysDir: c.keysDir });
  p.bundleId = bundleId;
  p.bundleDir = relative(c.dir, bundleDir);
  return { bundleId, bundleDir };
}

/** `ProposerOutput` plus `checkProposal` (the bundle's verified access log included) and the
 * scratch lint of 06 §3.4: the one validation of a proposal, whoever produced it. `checkedId()`
 * is the content id of the last output that passed. */
function proposerSchema(c: Ctx, bundleDir: string) {
  const o = c.o;
  let checkedId: string | undefined;
  const schema = z
    .preprocess(normalizeProposerOutput, ProposerOutputSchema)
    .superRefine((v, ctx) => {
      const checked = checkProposal({
        output: v,
        bundleDir,
        wiki: loadWiki(o.wikiRoot),
        skillsDir: o.skillsDir,
        templatesDir: c.templatesDir,
        keysDir: c.keysDir,
        records: loadRawStore(join(c.stateDir, 'raw')).records,
        ...(c.splits ? { splits: c.splits } : {}),
        scope: c.s.settings.scope,
      });
      if (!checked.ok) {
        for (const e of checked.errors) zodIssue(ctx, e);
        return;
      }
      const errors: string[] = [];
      if (v.action === 'create' || (v.action === 'patch' && v.outlet === 'skill')) {
        // 06 §3.4: the change is applied to a scratch skill set and linted before any rollout.
        const scratch = join(c.dir, 'candidates', '.lint');
        const made = materializeCandidate(o.skillsDir, v, scratch);
        errors.push(...(made.ok ? skillLintErrors(c, scratch) : made.errors));
        rmSync(scratch, { recursive: true, force: true });
      }
      for (const e of errors) zodIssue(ctx, e);
      if (errors.length === 0) checkedId = checked.proposalId;
    });
  return { schema, checkedId: () => checkedId };
}

/** Records a validated proposal: `proposal.json` in the bundle and the iteration directory, the
 * state, and for `no_action` the sealed event. */
function acceptProposal(
  c: Ctx,
  proposal: ProposerOutput,
  checkedId: string,
  bundleDir: string,
): StepOutcome {
  const p = c.s.proposer;
  const scope = c.s.settings.scope;
  const proposalId = uniqueProposalId(checkedId, ledgerEvents(c.o.wikiRoot), c.s.iterationId);
  const record = {
    proposalId,
    bundle: p.bundleId,
    validatedAt: c.now().toISOString(),
    ...(p.agent ? { agent: p.agent } : {}),
    output: proposal,
  };
  writeFileSync(join(bundleDir, PROPOSAL_FILE), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(c.dir, 'proposal.json'), `${JSON.stringify(record, null, 2)}\n`);
  p.proposal = proposal;
  p.proposalId = proposalId;
  // Distinct reads, as checkProposal counts them (a re-read of one trace is one read).
  p.rawReads = [
    ...new Set(
      readFileSync(join(bundleDir, 'access.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { command: string; target: string; refused?: string })
        .filter((e) => e.command === 'read' && !e.refused && e.target.startsWith('raw:'))
        .map((e) => e.target),
    ),
  ];
  p.status = 'done';
  p.message = `${proposal.action}${'outlet' in proposal ? ` (${proposal.outlet})` : ''}: ${proposalId}`;
  if (proposal.action === 'no_action') {
    c.s.evaluate.kind = 'no-action';
    c.s.evaluate.event = sealEvent({
      ts: c.now().toISOString(),
      proposalId,
      stage: 'no-action',
      ...(scope !== 'all' ? { skill: scope } : {}),
      change: { kind: 'no_action' },
      reason: proposal.reason,
    });
    c.s.evaluate.status = 'done';
  }
  c.save();
  return { ok: true };
}

export async function stepProposer(c: Ctx): Promise<StepOutcome> {
  const p = c.s.proposer;
  if (isExternalRole(c.config, 'proposer')) return stepProposerExternal(c);
  const maxSteps = c.s.settings.agentMaxSteps.proposer;
  const call = await roleClient(c, 'proposer', maxSteps);
  if ('short' in call) {
    p.status = 'deferred';
    p.message = call.short;
    return stop(c, 'proposer', 'deferred', `proposer: ${call.short}`, 1);
  }
  const { bundleDir } = writeProposerBundle(c, false);
  p.source = 'harness';
  p.model = call.modelId;
  c.save();

  const check = proposerSchema(c, bundleDir);
  const r = await runReact<ProposerOutput>({
    client: call.client,
    skills: [],
    rolePrompt: PROPOSER_PROMPT.replaceAll('{{dir}}', 'bundle'),
    task: [
      'Your proposer bundle is mounted at bundle/ (index.md, skill-impact.md, outcomes.md).',
      'The read-only commands are tools: `wiki_read` is `greenlight wiki read <ref>` and `wiki_traces` is `greenlight wiki traces`; read_file reads the bundle.',
      'Submit your ProposerOutput as the arguments of `finish`; a rejected submission comes back with its errors, and you have three.',
    ].join('\n'),
    tools: proposerTools(c, bundleDir),
    finish: {
      description: 'Submit the ProposerOutput (08 §9.2) as the arguments.',
      parameters: PROPOSER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      schema: check.schema as unknown as z.ZodType<ProposerOutput>,
    },
    maxSteps,
    budget: new RequestBudget(call.cap),
    maxFinishAttempts: MAX_SUBMISSIONS,
  });
  chargeSpend(c, call.modelId, r, 'proposer');
  const checkedId = check.checkedId();
  if (!r.ok || !r.result || !checkedId) {
    const kind = r.error?.kind;
    const why = `${kind}: ${r.error?.message ?? 'no output'}${r.error?.issues?.length ? ` (${r.error.issues.slice(0, 3).join('; ')})` : ''}`;
    p.status = resumable(kind) ? 'deferred' : 'failed';
    p.message = why;
    return stop(
      c,
      'proposer',
      p.status === 'deferred' ? 'deferred' : 'failed',
      `proposer: ${why}`,
      1,
    );
  }
  return acceptProposal(c, r.result, checkedId, bundleDir);
}

/** The proposer step when the role is external: the same bundle, no model call, no quota. The
 * agent reads through `greenlight wiki read|traces --bundle <dir>` (another process; the bundle's
 * key is in `.greenlight/bundle-keys/`, where that CLI looks), so the access log `checkProposal`
 * verifies is written by the CLI, never by the agent. */
function stepProposerExternal(c: Ctx): StepOutcome {
  const p = c.s.proposer;
  const file = c.o.proposal;
  if (p.status !== 'awaiting-external' || !bundleIssued(c, 'proposer')) {
    // First entry, a failed bundle, or one this harness cannot open (its key is per machine): a
    // fresh bundle with an empty access log. A file handed in with it is not judged against it.
    const stale = p.status === 'awaiting-external';
    writeProposerBundle(c, true);
    p.source = 'external';
    p.model = undefined;
    p.agent = undefined;
    p.submissions = 0;
    p.issues = undefined;
    if (!stale) return awaitAgent(c, 'proposer');
    const note = `the earlier proposer bundle could not be opened here (its key is per machine), so ${p.bundleId} was issued; its access log starts empty`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    return awaitAgent(
      c,
      'proposer',
      undefined,
      `${note}.${file !== undefined ? ' The submitted file was NOT judged and counts as no attempt: read through the new bundle, then submit again.' : ''}`,
    );
  }
  if (file === undefined) return awaitAgent(c, 'proposer');
  const bundleDir = externalBundleDir(c, 'proposer');
  const read = readSubmission(file, 'proposer');
  if (!read.ok) return refuseSubmission(c, 'proposer', read.issues);
  const check = proposerSchema(c, bundleDir);
  const parsed = check.schema.safeParse(read.value);
  const checkedId = check.checkedId();
  if (!parsed.success) return refuseSubmission(c, 'proposer', zodIssues(parsed.error));
  if (!checkedId) return refuseSubmission(c, 'proposer', ['the proposal did not pass its checks']);
  p.agent = c.o.agent as string;
  p.issues = undefined;
  return acceptProposal(c, parsed.data as ProposerOutput, checkedId, bundleDir);
}
