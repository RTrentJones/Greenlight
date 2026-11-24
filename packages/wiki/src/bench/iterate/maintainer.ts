import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { z } from 'zod';
import {
  buildMaintainerBundle,
  loadRawStore,
  maintainerRolePrompt,
  writeBundle,
} from '../../bundle';
import { type LintContext, introducedErrors, lint } from '../../lint';
import { isExternalRole } from '../../llm';
import { RequestBudget } from '../../llm/limits';
import { runReact } from '../../llm/react';
import { type Wiki, loadWiki, withWrites } from '../../load';
import { applyMaintainerOutput, writeChangeset } from '../../patch';
import {
  MAINTAINER_OUTPUT_JSON_SCHEMA,
  type MaintainerOutput,
  MaintainerOutputSchema,
} from '../../schema';
import { type Ctx, type StepOutcome, heldOut, readIf, recordByHash, stop } from './context';
import {
  awaitAgent,
  bundleFileTools,
  bundleIssued,
  chargeSpend,
  defaultContext,
  handbackLines,
  markBundleFailed,
  readSubmission,
  refuseSubmission,
  resumable,
  roleClient,
  zodIssue,
  zodIssues,
} from './roles';
import { sha } from './state';
import { type IterationState, MAX_SUBMISSIONS } from './types';

// ---- step 2: maintainer -----------------------------------------------------------------------

interface Prepared {
  ok: boolean;
  errors: string[];
  writes: { path: string; content: string }[];
  indexCorrections: string[];
}

/** `applyMaintainerOutput` on the current wiki, then the lint findings the output introduces
 * (06 §2.4): nothing is written. */
function prepareMaintainer(c: Ctx, wiki: Wiki, output: unknown, actor: string): Prepared {
  const applied = applyMaintainerOutput(wiki, output, {
    actor,
    now: c.now(),
    lint: c.o.lint ?? { kind: 'framework' },
  });
  if (!applied.ok) return { ok: false, errors: applied.errors, writes: [], indexCorrections: [] };
  const ctx: LintContext = { ...(c.o.lint ?? { kind: 'framework' }) };
  const introduced = introducedErrors(
    lint(wiki, ctx),
    lint(withWrites(wiki, applied.changeset.writes), ctx),
  );
  if (introduced.length > 0) {
    return {
      ok: false,
      errors: introduced.map((f) => `${f.rule} ${f.page}: ${f.message}`),
      writes: [],
      indexCorrections: [],
    };
  }
  return {
    ok: true,
    errors: [],
    writes: applied.changeset.writes,
    indexCorrections: applied.indexCorrections,
  };
}

/** Applies a stored, validated output exactly once: when every file it writes already holds its
 * content, it was applied by an earlier (interrupted) invocation. */
function applyStoredMaintainer(c: Ctx): StepOutcome {
  const m = c.s.maintainer;
  const wikiRoot = c.o.wikiRoot;
  const onDisk = (m.writes ?? []).every(
    (w) =>
      existsSync(join(wikiRoot, w.path)) && sha(readIf(join(wikiRoot, w.path)) ?? '') === w.sha256,
  );
  if (!(m.writes && m.writes.length > 0 && onDisk)) {
    const output = JSON.parse(readFileSync(m.outputFile as string, 'utf8')) as unknown;
    const p = prepareMaintainer(c, loadWiki(wikiRoot), output, maintainerActor(m));
    if (!p.ok) {
      m.status = 'failed';
      m.message = `the stored maintainer output no longer applies: ${p.errors.slice(0, 3).join('; ')}`;
      return stop(c, 'maintainer', 'failed', m.message, 1);
    }
    m.writes = p.writes.map((w) => ({ path: w.path, sha256: sha(w.content) }));
    m.indexCorrections = p.indexCorrections;
    c.save();
    writeChangeset(wikiRoot, { writes: p.writes });
  }
  m.applied = true;
  m.status = 'done';
  m.message = `applied: ${(m.writes ?? []).map((w) => w.path).join(', ')}`;
  c.save();
  return { ok: true };
}

/** The `actor` of the maintainer's log entry (06 §2.4): the model the harness called, or the
 * external agent that handed the output in. */
const maintainerActor = (m: IterationState['maintainer']): string =>
  `maintainer:${m.agent ?? m.model}`;

/** `MaintainerOutput` plus everything `applyMaintainerOutput` and lint refuse (06 §2.4): the one
 * validation of a maintainer output, whoever produced it. */
const maintainerSchema = (c: Ctx, actor: string) =>
  MaintainerOutputSchema.superRefine((v, ctx) => {
    const p = prepareMaintainer(c, loadWiki(c.o.wikiRoot), v, actor);
    for (const e of p.errors) zodIssue(ctx, e);
  });

/** Builds and writes the next maintainer bundle of the iteration (06 §2.1). PROMPT.md names the
 * bundle as `bundle` for the harness loop (its tools mount it there) and by its real path for an
 * external agent. */
function writeMaintainerBundle(c: Ctx, external: boolean) {
  const o = c.o;
  const m = c.s.maintainer;
  const train = recordByHash(o.wikiRoot, c.s.train.record as string);
  const store = loadRawStore(join(c.stateDir, 'raw'));
  const trainIds = new Set(train.outcomes.map((x) => x.rawId));
  const records = store.records.filter((r) => trainIds.has(r.rawId) || r.kind !== 'bench');
  const missing = [...trainIds].filter((id) => !store.records.some((r) => r.rawId === id));
  if (missing.length > 0) {
    const note = `maintainer: ${missing.length} train raw record(s) of ${train.hash.slice(0, 12)} are not in ${join(c.stateDir, 'raw')}`;
    if (!c.s.notes.includes(note)) c.s.notes.push(note);
    c.log(note);
  }
  m.attempts += 1;
  const bundleId = `${c.s.iterationId}-maintainer-${m.attempts}`;
  const bundleDir = join(c.dir, 'bundles', bundleId);
  const bundle = buildMaintainerBundle({
    id: bundleId,
    dir: external ? bundleDir : 'bundle',
    ...(external ? { handback: handbackLines(c, 'maintainer', bundleDir) } : {}),
    wiki: loadWiki(o.wikiRoot),
    records,
    context: o.context ?? defaultContext(o),
    sample: { failing: 5, passing: 3 },
    ...(c.s.settings.scope !== 'all' ? { skill: c.s.settings.scope } : {}),
    incidents: c.s.settings.incidents,
    heldOutTaskIds: heldOut(c.splits, store.records),
    ...(c.splits ? { splits: c.splits } : {}),
    now: c.now(),
  });
  rmSync(bundleDir, { recursive: true, force: true });
  writeBundle(bundleDir, bundle, { keysDir: c.keysDir });
  m.bundleId = bundleId;
  m.bundleDir = relative(c.dir, bundleDir);
  m.rawIds = bundle.manifest.rawIds;
  return { bundleId, bundleDir, bundle };
}

/** Stores a validated output in the iteration directory, then applies it exactly once. */
function storeAndApplyMaintainer(c: Ctx, output: MaintainerOutput): StepOutcome {
  const m = c.s.maintainer;
  const outputFile = join(c.dir, 'maintainer-output.json');
  writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`);
  m.outputFile = outputFile;
  m.applied = false;
  c.save();
  return applyStoredMaintainer(c);
}

export async function stepMaintainer(c: Ctx): Promise<StepOutcome> {
  const m = c.s.maintainer;
  if (m.outputFile && !m.applied) return applyStoredMaintainer(c);
  if (isExternalRole(c.config, 'maintainer')) return stepMaintainerExternal(c);
  const maxSteps = c.s.settings.agentMaxSteps.maintainer;
  const call = await roleClient(c, 'maintainer', maxSteps);
  if ('short' in call) {
    m.status = 'deferred';
    m.message = call.short;
    return stop(c, 'maintainer', 'deferred', `maintainer: ${call.short}`, 1);
  }
  const { bundleId, bundleDir, bundle } = writeMaintainerBundle(c, false);
  m.source = 'harness';
  m.model = call.modelId;
  c.save();
  const finishSchema = maintainerSchema(c, maintainerActor(m));
  const r = await runReact<MaintainerOutput>({
    client: call.client,
    skills: [],
    rolePrompt: maintainerRolePrompt('bundle'),
    task: [
      `Your maintainer bundle is mounted at bundle/ (${bundle.manifest.files.length} files, ${bundle.manifest.rawIds.length} raw record(s)${c.s.settings.incidents.length ? `, ${c.s.settings.incidents.length} incident(s)` : ''}).`,
      'Read it with read_file and list_dir. Submit your MaintainerOutput as the arguments of `finish`; a rejected submission comes back with its errors, and you have three.',
    ].join('\n'),
    tools: bundleFileTools(bundleDir),
    finish: {
      description: 'Submit the MaintainerOutput (08 §9.1) as the arguments.',
      parameters: MAINTAINER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      schema: finishSchema as unknown as z.ZodType<MaintainerOutput>,
    },
    maxSteps,
    budget: new RequestBudget(call.cap),
    maxFinishAttempts: MAX_SUBMISSIONS,
  });
  // The bundle stays for the hand-off and the artifact upload.
  chargeSpend(c, call.modelId, r, 'maintainer');
  if (!r.ok || !r.result) {
    const kind = r.error?.kind;
    const why = `${kind}: ${r.error?.message ?? 'no output'}${r.error?.issues?.length ? ` (${r.error.issues.slice(0, 3).join('; ')})` : ''}`;
    if (resumable(kind)) {
      m.status = 'deferred';
      m.message = why;
      return stop(c, 'maintainer', 'deferred', `maintainer: ${why}`, 1);
    }
    if (kind === 'finish_invalid' || kind === 'step_limit') markBundleFailed(c, bundleId, why);
    m.status = 'failed';
    m.message = why;
    return stop(c, 'maintainer', 'failed', `maintainer: ${why}`, 1);
  }
  return storeAndApplyMaintainer(c, r.result);
}

/** The maintainer step when the role is external: the same bundle, no model call, no quota. */
function stepMaintainerExternal(c: Ctx): StepOutcome {
  const m = c.s.maintainer;
  const file = c.o.maintainerOutput;
  // A maintainer output is validated against the wiki, not the bundle, so a handed-in file is
  // judged even when the bundle directory is gone.
  if (m.status !== 'awaiting-external' || (file === undefined && !bundleIssued(c, 'maintainer'))) {
    // First entry, a bundle that failed, or one that is gone: issue a fresh bundle and wait.
    writeMaintainerBundle(c, true);
    m.source = 'external';
    m.model = undefined;
    m.agent = undefined;
    m.submissions = 0;
    m.issues = undefined;
    return awaitAgent(c, 'maintainer');
  }
  if (file === undefined) return awaitAgent(c, 'maintainer');
  const agent = c.o.agent as string;
  const read = readSubmission(file, 'maintainer');
  if (!read.ok) return refuseSubmission(c, 'maintainer', read.issues);
  const parsed = maintainerSchema(c, `maintainer:${agent}`).safeParse(read.value);
  if (!parsed.success) return refuseSubmission(c, 'maintainer', zodIssues(parsed.error));
  m.agent = agent;
  m.issues = undefined;
  m.status = 'pending';
  return storeAndApplyMaintainer(c, parsed.data);
}
