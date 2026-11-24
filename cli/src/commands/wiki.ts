import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { newRawId } from '@rtrentjones/greenlight-shared';
import {
  BUNDLE_KEYS_DIR,
  type BundleContext,
  BundleLeakError,
  BundleSecretError,
  type CaptureEnv,
  CaptureError,
  type CaptureKind,
  type Finding,
  type LintContext,
  type OpenBundle,
  PROPOSAL_FILE,
  type Role,
  type SeamTerms,
  type SplitIndex,
  acceptedSkillSet,
  applyMaintainerOutput,
  awaitingIterations,
  buildMaintainerBundle,
  buildProposerBundle,
  captureRecord,
  checkProposal,
  fix,
  introducedErrors,
  lint,
  lintExitCode,
  listTraces,
  livenessSummary,
  loadRawStore,
  loadSkills,
  loadWiki,
  lookupPatterns,
  openBundle,
  parseSampleSpec,
  parseSplits,
  rawOff,
  readGateInput,
  readTarget,
  recordAccess,
  retainRecord,
  skillSetHash,
  toolContext,
  withWrites,
  writeBundle,
  writeChangeset,
} from '@rtrentjones/greenlight-wiki';
import { UsageError, parseFlags } from '../args';
import { frameworkWikiDir } from '../asset-paths';
import { findManifestPath, loadManifest, resolveEntry } from '../manifest';
import { MODULE_REF } from '../version';
import { INSTALLED_VERSION, hitLocation, lookupSources, wikiOff } from '../wiki-hits';

/**
 * `greenlight wiki …` (vision 07 §3.4, §3.6b, §3.6d, §3.7, §3.8). Thin wiring over
 * `@rtrentjones/greenlight-wiki`: lint, maintainer/proposer bundles, apply, and the read-only
 * interface a proposer sandbox uses. Exit codes follow 07 §0: 1 check failed, 2 usage, 3 missing
 * prerequisite, 4 refused by policy.
 */

export interface WikiIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo = (): WikiIo => ({
  cwd: process.cwd(),
  env: process.env,
  out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
  err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
});

const USAGE = `usage: greenlight wiki <subcommand>

EXPERIMENTAL: the wiki is new in 0.11 (Greenlight 2.0). Commands, page formats and exit codes may
change without notice.


  lint [--strict] [--fix] [--json] [--framework] [--root <dir>]
                       run the wiki lint rules (exit 1 on errors; --strict also on warnings)
  render [--root <dir>]
                       regenerate index.md and skill-impact.md (same as lint --fix)
  ingest [--sample a:b] [--incident <id>] [--seed <s>] [--skill <n>] [--tool <n>] [--out <dir>]
                       write a maintainer bundle (.greenlight/bundles/<id>/) and print its path
  ingest --apply <maintainer-output.json> [--dry-run]
                       validate and apply a MaintainerOutput atomically, then lint. Refused
                       (exit 4) while a \`bench iterate\` iteration waits for its maintainer:
                       that output goes to \`bench iterate --resume <id> --maintainer-output\`
  propose [--skill <name>] [--out <dir>]
                       write a proposer bundle (index, skill-impact, outcomes, PROMPT.md)
  propose --apply <proposer-output.json> [--bundle <dir>]
                       validate a ProposerOutput and record it as the bundle's proposal.json
  read <page-id | raw:<rawId> | skill:<name>> [--role maintainer|proposer] [--json]
  traces [--skill <name>[@v]] [--failed|--passing] [--tool <n>] [--limit n] [--json]
                       the read-only interface; val/test bench records are never served
  capture --manual --tool <name> --env <preview|beta|prod> --passed <true|false|unknown>
          --note <text> [--ref <EvidenceRef>]… [--sha <sha>]
                       record evidence gathered by hand (a drill, an incident) as a raw record
                       under .greenlight/raw, redacted, and print its raw id
  capture --kind <preview|ship|verify|keepalive|alert|session> --tool <name> --env <env>
          --passed <bool> [--sha <sha>] [--ref <ref>]… [--excerpt-file <path>] [--verify-json <path>]
                       the same, from files, for CI steps and alerts
  capture --retain <rawId>
                       copy a raw record to wiki/evidence/, where it is committed and immutable
  context <name> [--json]
                       what to read before touching a tool: its intent, liveness, the head of its
                       decisions, its manifest entry, the confirmed patterns for its cell and its
                       open alert issues. Never blocks: exits 0 when the tool has no pages yet
  lookup [--check <id|name>]… [--class <c>] [--cell <lane/target/data>] [--tool <name>]
         [--start] [--include-hypothesis] [--json]
                       confirmed patterns for a failing check, a class or a cell, best match
                       first, each with its fix. --tool takes the cell from the manifest;
                       --tool <name> --start is the same as context <name>

context, lookup and read also search the framework wiki the installed CLI carries. Incident pages
are never returned by context or lookup. GREENLIGHT_WIKI=off makes both print nothing and exit 0.

common: --root <wiki dir> (default wiki), --raw <raw dir> (default .greenlight/raw).
Inside a bundle, set GREENLIGHT_BUNDLE=<bundle dir> (or pass --bundle) so reads are logged.
Roles: the maintainer and proposer roles exist only inside a harness-issued bundle (its role is
verified against the key in .greenlight/bundle-keys/, or GREENLIGHT_BUNDLE_KEYS); without one,
reads run as role agent and --role maintainer|proposer is refused.`;

class Usage extends Error {}

export async function wikiCommand(args: string[], io: WikiIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'lint':
        return await lintCmd(rest, io, false);
      case 'render':
        return await lintCmd(['--fix', ...rest], io, true);
      case 'ingest':
        return await ingestCmd(rest, io);
      case 'propose':
        return proposeCmd(rest, io);
      case 'read':
        return readCmd(rest, io);
      case 'traces':
        return tracesCmd(rest, io);
      case 'capture':
        return captureCmd(rest, io);
      case 'context':
        return await contextCmd(rest, io);
      case 'lookup':
        return await lookupCmd(rest, io);
      case undefined:
      case 'help':
      case '--help':
        io.out(USAGE);
        return sub === undefined ? 2 : 0;
      default:
        io.err(`unknown wiki subcommand "${sub}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(msg);
    if (err instanceof Usage || err instanceof UsageError) return 2;
    if (err instanceof CaptureError) return 3;
    if (err instanceof BundleLeakError || err instanceof BundleSecretError) return 4;
    return withCode(err);
  }
}

// ---- shared ----------------------------------------------------------------------------------

const ROOT_FLAGS = ['--root', '--raw'] as const;

interface Paths {
  root: string;
  raw: string;
  skills: string;
  templates: string;
  /** Per-bundle keys; the runner keeps this outside every agent sandbox (06 §3.1). */
  keys: string;
}

function paths(io: WikiIo, values: Record<string, string>): Paths {
  return {
    root: resolve(io.cwd, values['--root'] ?? 'wiki'),
    raw: resolve(io.cwd, values['--raw'] ?? '.greenlight/raw'),
    skills: resolve(io.cwd, '.claude/skills'),
    templates: resolve(io.cwd, 'tools'),
    keys: resolve(io.cwd, io.env.GREENLIGHT_BUNDLE_KEYS || BUNDLE_KEYS_DIR),
  };
}

function requireWiki(p: Paths) {
  if (!existsSync(p.root)) {
    throw Object.assign(new Error(`no wiki at ${p.root} (pass --root <dir>)`), { code: 3 });
  }
  return loadWiki(p.root);
}

/** The framework repo ships only greenlight.config.example.ts; a wrapper has its own manifest. */
const isFrameworkRepo = (cwd: string): boolean =>
  existsSync(join(cwd, 'greenlight.config.example.ts')) &&
  !existsSync(join(cwd, 'greenlight.config.ts'));

/** LR-19 terms come from the owner's manifest, never from framework code (rule 15.2.1). */
async function seamTerms(cwd: string): Promise<SeamTerms | undefined> {
  const path = findManifestPath(cwd);
  if (!path || basename(path) !== 'greenlight.config.ts') return undefined;
  try {
    const { config } = await loadManifest(cwd);
    return { domains: [config.domain], toolNames: config.tools.map((t) => t.name) };
  } catch {
    return undefined;
  }
}

async function lintContext(io: WikiIo, framework: boolean, p: Paths): Promise<LintContext> {
  const kind = framework || isFrameworkRepo(io.cwd) ? 'framework' : 'project';
  return { kind, skills: loadSkills(p.skills), seam: await seamTerms(io.cwd) };
}

/**
 * `bench/splits.json` (framework repo): the authoritative split of every bench task. Undefined
 * when absent, in which case no bench raw record is ever served or bundled. A corrupt file is a
 * missing prerequisite (exit 3), never "no held-out tasks".
 */
function loadSplits(cwd: string): SplitIndex | undefined {
  const file = join(cwd, 'bench/splits.json');
  if (!existsSync(file)) return undefined;
  try {
    return parseSplits(readFileSync(file, 'utf8'));
  } catch (err) {
    throw Object.assign(new Error(`cannot read ${file}: ${(err as Error).message}`), { code: 3 });
  }
}

/** Held-out task ids from `bench/splits.json`, on top of the raw store's own. */
const heldOutTaskIds = (splits: SplitIndex | undefined): string[] =>
  [...(splits ?? [])].filter(([, s]) => s !== 'train').map(([id]) => id);

/**
 * The accepted skill set for `outcomes.md` (06 §1.5): from the latest merged or gated ledger state
 * (its gate input record under `<wiki>/evidence/eval/`), else the installed skill set's hash.
 */
function acceptedSkillSetFor(p: Paths, wiki: ReturnType<typeof loadWiki>): string | undefined {
  return acceptedSkillSet(wiki.ledger, (h) => readGateInput(p.root, h)) ?? skillSetHash(p.skills);
}

const withCode = (err: unknown): number =>
  typeof (err as { code?: unknown })?.code === 'number' ? (err as { code: number }).code : 1;

// ---- lint / render ---------------------------------------------------------------------------

async function lintCmd(args: string[], io: WikiIo, render: boolean): Promise<number> {
  const a = parseFlags(render ? 'wiki render' : 'wiki lint', args, {
    value: ROOT_FLAGS,
    boolean: ['--strict', '--fix', '--json', '--framework'],
  });
  const p = paths(io, a.values);
  let wiki: ReturnType<typeof loadWiki>;
  try {
    wiki = requireWiki(p);
  } catch (err) {
    io.err((err as Error).message);
    return withCode(err);
  }
  if (a.flags.has('--fix')) {
    const { writes } = fix(wiki);
    if (writes.length > 0) {
      writeChangeset(p.root, { writes });
      io.err(`fixed: ${writes.map((w) => w.path).join(', ')}`);
      wiki = loadWiki(p.root);
    }
  }
  const findings = lint(wiki, await lintContext(io, a.flags.has('--framework'), p));
  const code = lintExitCode(findings, { strict: a.flags.has('--strict') });
  if (a.flags.has('--json')) io.out(JSON.stringify({ findings }));
  else {
    for (const f of findings)
      io.err(`${f.severity === 'error' ? '✘' : '!'} ${f.rule} ${f.page}: ${f.message}`);
    io.err(
      code === 0
        ? `✔ wiki lint: ${wiki.pages.size} pages, ${findings.length} finding(s)`
        : `✘ wiki lint: ${findings.length} finding(s)`,
    );
  }
  return render && code !== 0 ? 1 : code;
}

// ---- ingest ----------------------------------------------------------------------------------

async function bundleContext(io: WikiIo, p: Paths): Promise<BundleContext> {
  let cells: string[] = [];
  if (findManifestPath(io.cwd)) {
    try {
      const { config } = await loadManifest(io.cwd);
      cells = [
        ...(config.blog ? [`${config.blog.lane}/${config.blog.target}/${config.blog.data}`] : []),
        ...config.tools.map((t) => `${t.lane}/${t.target}/${t.data}`),
      ];
      cells = [...new Set(cells)].sort();
    } catch {
      cells = [];
    }
  }
  const skills = Object.fromEntries(
    loadSkills(p.skills).map((s) => [s.name, s.version ?? 'unversioned']),
  );
  // Verify check ids per tool arrive with the verify check-id work (08 §6); empty until then.
  return { installed: MODULE_REF.replace(/^v/, ''), cells, verifyCheckIds: [], skills };
}

async function ingestCmd(args: string[], io: WikiIo): Promise<number> {
  const a = parseFlags('wiki ingest', args, {
    value: [
      ...ROOT_FLAGS,
      '--apply',
      '--sample',
      '--incident',
      '--seed',
      '--out',
      '--skill',
      '--tool',
    ],
    boolean: ['--dry-run', '--framework'],
  });
  const p = paths(io, a.values);
  if (a.values['--apply'] !== undefined) return ingestApply(a.values['--apply'], a, p, io);

  const wiki = requireWiki(p);
  const store = loadRawStore(p.raw);
  for (const e of store.errors) io.err(`! skipped raw ${e.file}: ${e.message}`);
  const id = newRawId();
  const dir = resolve(io.cwd, a.values['--out'] ?? join('.greenlight/bundles', id));
  const splits = loadSplits(io.cwd);
  const bundle = buildMaintainerBundle({
    id: a.values['--out'] ? basename(dir) : id,
    dir,
    wiki,
    records: store.records,
    context: await bundleContext(io, p),
    seed: a.values['--seed'],
    sample: a.values['--sample'] ? parseSampleSpec(a.values['--sample']) : undefined,
    skill: a.values['--skill'],
    tool: a.values['--tool'],
    incident: a.values['--incident'],
    heldOutTaskIds: heldOutTaskIds(splits),
    splits,
  });
  writeBundle(dir, bundle, { keysDir: p.keys });
  io.err(
    `maintainer bundle: ${bundle.manifest.rawIds.length} raw record(s), ${bundle.files.size} files`,
  );
  io.out(dir);
  return 0;
}

/** Re-exported: the multiset rule lives with lint (`@rtrentjones/greenlight-wiki`). */
export { introducedErrors };

async function ingestApply(
  file: string,
  a: ReturnType<typeof parseFlags>,
  p: Paths,
  io: WikiIo,
): Promise<number> {
  const wiki = requireWiki(p);
  let output: unknown;
  try {
    output = JSON.parse(readFileSync(resolve(io.cwd, file), 'utf8'));
  } catch (err) {
    io.err(`cannot read ${file}: ${(err as Error).message}`);
    return 3;
  }
  const actor = `maintainer:${io.env.GREENLIGHT_MODEL || 'unknown'}`;
  const applied = applyMaintainerOutput(wiki, output, { actor });
  if (!applied.ok) {
    io.err('✘ maintainer output rejected; nothing written:');
    for (const e of applied.errors.slice(0, 10)) io.err(`  ${e}`);
    return 1;
  }
  // Lint the scratch copy (06 §2.4). Only findings the change introduces reject it, so an
  // unrelated pre-existing problem cannot block every maintainer pass.
  const ctx = await lintContext(io, a.flags.has('--framework'), p);
  const scratch = withWrites(wiki, applied.changeset.writes);
  const introduced = introducedErrors(lint(wiki, ctx), lint(scratch, ctx));
  if (introduced.length > 0) {
    io.err('✘ maintainer output rejected by lint; nothing written:');
    for (const f of introduced.slice(0, 10)) io.err(`  ${f.rule} ${f.page}: ${f.message}`);
    return 1;
  }
  for (const c of applied.indexCorrections) io.err(`! index correction: ${c}`);
  if (a.flags.has('--dry-run')) {
    for (const w of applied.changeset.writes) io.out(`would write ${w.path}`);
    return 0;
  }
  // An iteration waiting for its maintainer applies the output itself (`bench iterate
  // --maintainer-output`), so the write is pinned and recorded in its state. Writing the wiki
  // directly would drift the pins the iteration resumes against.
  const waiting = awaitingIterations(join(io.cwd, '.greenlight')).find(
    (i) => i.step === 'maintainer',
  );
  if (waiting) {
    io.err(
      `✘ iteration ${waiting.iterationId} is waiting for this maintainer output; nothing written. The output is valid: hand it to the iteration with \`greenlight bench iterate --resume ${waiting.iterationId} --maintainer-output ${file} --agent "<agent id>"\`, which applies it`,
    );
    return 4;
  }
  writeChangeset(p.root, applied.changeset);
  for (const w of applied.changeset.writes) io.out(`wrote ${w.path}`);
  return 0;
}

// ---- propose ---------------------------------------------------------------------------------

function proposeCmd(args: string[], io: WikiIo): number {
  const a = parseFlags('wiki propose', args, {
    value: [...ROOT_FLAGS, '--apply', '--skill', '--out', '--bundle'],
  });
  const p = paths(io, a.values);
  const wiki = requireWiki(p);
  if (a.values['--apply'] !== undefined) {
    const file = resolve(io.cwd, a.values['--apply']);
    const bundleDir = resolve(
      io.cwd,
      a.values['--bundle'] ?? io.env.GREENLIGHT_BUNDLE ?? dirname(file),
    );
    let output: unknown;
    try {
      output = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      io.err(`cannot read ${a.values['--apply']}: ${(err as Error).message}`);
      return 3;
    }
    const checked = checkProposal({
      output,
      bundleDir,
      wiki,
      skillsDir: p.skills,
      templatesDir: p.templates,
      keysDir: p.keys,
      records: loadRawStore(p.raw).records,
      splits: loadSplits(io.cwd),
    });
    if (!checked.ok) {
      io.err('✘ proposal refused:');
      for (const e of checked.errors.slice(0, 10)) io.err(`  ${e}`);
      return checked.code;
    }
    const record = {
      proposalId: checked.proposalId,
      bundle: openBundle(bundleDir, p.keys).manifest.id,
      validatedAt: new Date().toISOString(),
      output: checked.proposal,
    };
    writeFileSync(join(bundleDir, PROPOSAL_FILE), `${JSON.stringify(record, null, 2)}\n`);
    io.err(`✔ proposal ${checked.proposalId} validated (${checked.proposal.action})`);
    io.out(join(bundleDir, PROPOSAL_FILE));
    return 0;
  }

  const skill = a.values['--skill'];
  const managed = loadSkills(p.skills).map((s) => s.name);
  if (skill !== undefined && !managed.includes(skill)) {
    io.err(`skill ${skill} is not a managed skill (${managed.join(', ') || 'none found'})`);
    return 3;
  }
  const store = loadRawStore(p.raw);
  for (const e of store.errors) io.err(`! skipped raw ${e.file}: ${e.message}`);
  const id = newRawId();
  const dir = resolve(io.cwd, a.values['--out'] ?? join('.greenlight/bundles', id));
  const splits = loadSplits(io.cwd);
  const bundle = buildProposerBundle({
    id: a.values['--out'] ? basename(dir) : id,
    dir,
    wiki,
    records: store.records,
    skills: skill ? [skill] : managed,
    skill,
    heldOutTaskIds: heldOutTaskIds(splits),
    splits,
    acceptedSkillSetHash: acceptedSkillSetFor(p, wiki),
  });
  writeBundle(dir, bundle, { keysDir: p.keys });
  io.out(dir);
  return 0;
}

// ---- read / traces ---------------------------------------------------------------------------

/**
 * The role in effect. Inside a bundle it is the bundle's role, read from its VERIFIED manifest
 * (`openBundle`); `--role` can only narrow a maintainer bundle, never widen. Without a bundle the
 * role is `agent`: `--role maintainer` or `--role proposer` is refused (exit 4), because those
 * roles exist only inside a harness-issued bundle, where every read is logged.
 */
function roleOf(
  io: WikiIo,
  values: Record<string, string>,
  p: Paths,
): { role: Role; bundle?: OpenBundle } {
  const named = values['--bundle'] ?? io.env.GREENLIGHT_BUNDLE;
  const flag = values['--role'];
  if (flag !== undefined && !['maintainer', 'proposer', 'agent'].includes(flag)) {
    throw new Usage(`--role must be maintainer, proposer or agent (got "${flag}")`);
  }
  if (named) {
    const bundle = openBundle(resolve(io.cwd, named), p.keys);
    const own = bundle.manifest.role;
    const role: Role = own === 'maintainer' && flag ? (flag as Role) : own;
    return { role, bundle };
  }
  if (flag !== undefined && flag !== 'agent') {
    throw Object.assign(
      new Error(
        `--role ${flag} needs a ${flag} bundle (--bundle <dir> or GREENLIGHT_BUNDLE): that role exists only inside a harness-issued bundle, where every read is logged`,
      ),
      { code: 4 },
    );
  }
  return { role: 'agent' };
}

function readCmd(args: string[], io: WikiIo): number {
  const a = parseFlags('wiki read', args, {
    value: [...ROOT_FLAGS, '--role', '--bundle'],
    boolean: ['--json'],
  });
  const ref = a.positional[0];
  if (!ref || a.positional.length > 1)
    throw new Usage('usage: greenlight wiki read <page-id|raw:<id>|skill:<name>>');
  const p = paths(io, a.values);
  const { role, bundle } = roleOf(io, a.values, p);
  const sources = {
    records: ref.startsWith('raw:') ? loadRawStore(p.raw).records : [],
    skillsDir: p.skills,
    splits: ref.startsWith('raw:') ? loadSplits(io.cwd) : undefined,
  };
  let result = readTarget(ref, role, {
    ...sources,
    wiki: existsSync(p.root) ? loadWiki(p.root) : undefined,
  });
  // 07 §3.6b: a page the project wiki does not have is read from the framework wiki.
  const framework = frameworkWikiDir();
  const isPage = !ref.startsWith('raw:') && !ref.startsWith('skill:');
  if (!result.ok && result.code === 3 && isPage && framework && resolve(framework) !== p.root) {
    const fallback = readTarget(ref, role, { ...sources, wiki: loadWiki(framework) });
    if (fallback.ok || fallback.code !== 3) result = fallback;
  }
  if (bundle) {
    recordAccess(bundle, {
      ts: new Date().toISOString(),
      command: 'read',
      target: ref,
      ...(result.ok ? {} : { refused: result.message }),
    });
  }
  if (!result.ok) {
    io.err(result.message);
    return result.code;
  }
  io.out(a.flags.has('--json') ? JSON.stringify(result.json) : result.text);
  return 0;
}

function tracesCmd(args: string[], io: WikiIo): number {
  const a = parseFlags('wiki traces', args, {
    value: [...ROOT_FLAGS, '--skill', '--tool', '--limit', '--role', '--bundle'],
    boolean: ['--failed', '--failing', '--passing', '--json'],
  });
  const failed = a.flags.has('--failed') || a.flags.has('--failing');
  if (failed && a.flags.has('--passing')) throw new Usage('--failed and --passing are exclusive');
  const limit = a.values['--limit'] === undefined ? 20 : Number(a.values['--limit']);
  if (!Number.isInteger(limit) || limit < 1) throw new Usage('--limit must be a positive integer');
  const p = paths(io, a.values);
  const { bundle } = roleOf(io, a.values, p);
  const rows = listTraces(loadRawStore(p.raw).records, {
    skill: a.values['--skill'],
    tool: a.values['--tool'],
    failed,
    passing: a.flags.has('--passing'),
    limit,
    splits: loadSplits(io.cwd),
  });
  if (bundle) {
    recordAccess(bundle, {
      ts: new Date().toISOString(),
      command: 'traces',
      target: args.join(' '),
    });
  }
  if (a.flags.has('--json')) {
    io.out(
      JSON.stringify(
        rows.map((r) => ({
          rawId: r.rawId,
          tool: r.tool,
          kind: r.kind,
          passed: r.passed,
          startedAt: r.startedAt,
        })),
      ),
    );
  } else {
    for (const r of rows) {
      io.out(
        `${r.rawId}  ${r.tool}  ${r.kind}${r.bench ? ` ${r.bench.task}` : ''}  ${r.passed ? 'passed' : 'failed'}  ${r.startedAt}`,
      );
    }
  }
  return 0;
}

// ---- context and lookup (07 §3.6, §3.6a) ------------------------------------------------------

interface ToolEntry {
  name: string;
  cell: string;
  manifest: Record<string, unknown>;
}

/** The manifest entry for `name`, or nothing when there is no manifest or no such entry. */
async function toolEntry(io: WikiIo, name: string): Promise<ToolEntry | undefined> {
  if (!findManifestPath(io.cwd)) return undefined;
  try {
    const { config } = await loadManifest(io.cwd);
    const entry = resolveEntry(config, name);
    const raw = name === 'blog' ? config.blog : config.tools.find((t) => t.name === name);
    return {
      name,
      cell: `${entry.lane}/${entry.target}/${entry.data ?? 'none'}`,
      manifest: { name, ...(raw as Record<string, unknown>) },
    };
  } catch {
    return undefined;
  }
}

/** Titles of the open keepalive alert issues that name the tool. Best effort: `gh` may be absent
 * or unauthenticated, and then the bundle says the alerts are unknown instead of failing. */
function openAlerts(io: WikiIo, name: string): { titles: string[]; note?: string } {
  if (io.env.GREENLIGHT_NO_GH === '1') return { titles: [], note: 'alerts not checked' };
  try {
    const out = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'open',
        '--label',
        'keepalive',
        '--json',
        'title',
        '--limit',
        '100',
      ],
      { cwd: io.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    );
    const titles = (JSON.parse(out) as { title: string }[])
      .map((i) => i.title)
      .filter((t) => t.toLowerCase().includes(name.toLowerCase()));
    return { titles };
  } catch {
    return { titles: [], note: 'alerts not checked (gh unavailable)' };
  }
}

async function contextCmd(args: string[], io: WikiIo): Promise<number> {
  const a = parseFlags('wiki context', args, { value: [...ROOT_FLAGS], boolean: ['--json'] });
  const name = a.positional[0];
  if (!name || a.positional.length > 1) throw new Usage('usage: greenlight wiki context <name>');
  if (wikiOff(io.env)) return 0;
  const p = paths(io, a.values);
  const sources = lookupSources(io.cwd, p.root);
  const project = sources.find((s) => s.origin === 'project')?.wiki;
  const framework = sources.find((s) => s.origin === 'framework')?.wiki;
  const entry = await toolEntry(io, name);
  const ctx = toolContext(project, framework ?? project, name, {
    cell: entry?.cell,
    installed: INSTALLED_VERSION,
  });
  const alerts = openAlerts(io, name);

  if (a.flags.has('--json')) {
    io.out(
      JSON.stringify({
        intent: ctx.intent ?? null,
        liveness: ctx.liveness ?? null,
        decisions: ctx.decisions ?? null,
        manifest: entry?.manifest ?? null,
        patterns: ctx.patterns,
        alerts: alerts.titles,
        ...(alerts.note ? { alertsNote: alerts.note } : {}),
      }),
    );
    return 0;
  }
  const section = (title: string, body: string | undefined) => {
    if (body !== undefined) io.out(`## ${title}\n\n${body.trim()}\n`);
  };
  io.out(`# ${name}: read before changing it\n`);
  section(`tools/${name}/intent.md`, ctx.intent);
  section(`tools/${name}/liveness.md`, ctx.liveness);
  section(`tools/${name}/decisions.md (first lines)`, ctx.decisions);
  section(
    'manifest entry',
    entry ? JSON.stringify(entry.manifest, null, 2) : `no entry "${name}" in a manifest here`,
  );
  if (ctx.patterns.length > 0) {
    const lines = ctx.patterns.map(
      (h) =>
        `- ${h.id} — ${h.title} (${h.origin === 'project' ? 'project wiki' : `greenlight wiki read ${h.id}`})${h.note ? ` [${h.note}]` : ''}`,
    );
    section(`confirmed patterns for ${entry?.cell ?? 'every cell'}`, lines.join('\n'));
  }
  section(
    'open alerts',
    alerts.note ?? (alerts.titles.length ? alerts.titles.map((t) => `- ${t}`).join('\n') : 'none'),
  );
  if (!ctx.hasPages) {
    io.out(`no project wiki for ${name}: run greenlight wiki lint --fix to stub it`);
  }
  return 0;
}

async function lookupCmd(args: string[], io: WikiIo): Promise<number> {
  const a = parseFlags('wiki lookup', args, {
    value: [...ROOT_FLAGS, '--class', '--cell', '--tool', '--role', '--skill'],
    list: ['--check'],
    boolean: ['--start', '--include-hypothesis', '--json'],
  });
  if (a.positional.length > 0) throw new Usage(`unexpected argument "${a.positional[0]}"`);
  if (a.values['--role'] !== undefined) {
    throw Object.assign(
      new Error(
        'wiki lookup --role is not built: the maintainer and proposer reading sets come from `wiki ingest` and `wiki propose` bundles',
      ),
      { code: 4 },
    );
  }
  const tool = a.values['--tool'];
  if (a.flags.has('--start')) {
    if (!tool) throw new Usage('--start needs --tool <name>');
    return contextCmd(
      [tool, ...(a.flags.has('--json') ? ['--json'] : []), ...rootArgs(a.values)],
      io,
    );
  }
  if (wikiOff(io.env)) return 0;
  const checks = a.lists['--check'] ?? [];
  const entry = tool ? await toolEntry(io, tool) : undefined;
  const cell = a.values['--cell'] ?? entry?.cell;
  if (cell !== undefined && !/^[a-z*]+\/[a-z*]+\/[a-z*]+$/.test(cell)) {
    throw new Usage(`--cell must be "lane/target/data" (got "${cell}")`);
  }
  if (checks.length === 0 && !a.values['--class'] && !cell) {
    throw new Usage('wiki lookup needs --check, --class, --cell or --tool');
  }
  const p = paths(io, a.values);
  const sources = lookupSources(io.cwd, p.root);
  const hits = lookupPatterns(sources, {
    checks,
    class: a.values['--class'],
    cell,
    installed: INSTALLED_VERSION,
    includeHypothesis: a.flags.has('--include-hypothesis'),
  });
  const project = sources.find((s) => s.origin === 'project')?.wiki;
  const liveness = tool ? livenessSummary(project, tool) : undefined;
  if (a.flags.has('--json')) {
    io.out(
      JSON.stringify({
        hits: hits.map((h) => ({
          id: h.id,
          score: h.score,
          path: h.origin === 'project' ? `wiki/${h.path}` : h.path,
          origin: h.origin,
          title: h.title,
          fix: h.fix,
          ...(h.note ? { note: h.note } : {}),
          ...(h.status === 'hypothesis' ? { status: h.status } : {}),
        })),
        ...(liveness ? { liveness } : {}),
      }),
    );
    return 0;
  }
  if (liveness) io.out(`${liveness}\n`);
  if (hits.length === 0) {
    io.out('no confirmed pattern matches');
    return 0;
  }
  for (const h of hits) {
    const flag = h.status === 'hypothesis' ? ' HYPOTHESIS — not guidance' : '';
    io.out(`${h.title}${flag}\n  ${h.id} (score ${h.score}) — ${hitLocation(h)}`);
    if (h.note) io.out(`  ${h.note}`);
    if (h.replaces) io.out(`  replaces ${h.replaces}`);
    if (h.fix) io.out(`\n${h.fix.replace(/^/gm, '  ')}\n`);
  }
  return 0;
}

const rootArgs = (values: Record<string, string>): string[] =>
  ROOT_FLAGS.flatMap((f) => (values[f] === undefined ? [] : [f, values[f] as string]));

// ---- capture (07 §3.5) ------------------------------------------------------------------------

const CAPTURE_KINDS = ['preview', 'ship', 'verify', 'keepalive', 'alert', 'session'] as const;
const CAPTURE_ENVS = ['preview', 'beta', 'prod'] as const;

function captureCmd(args: string[], io: WikiIo): number {
  const a = parseFlags('wiki capture', args, {
    value: [
      ...ROOT_FLAGS,
      '--kind',
      '--tool',
      '--env',
      '--passed',
      '--note',
      '--sha',
      '--excerpt-file',
      '--verify-json',
      '--retain',
    ],
    list: ['--ref'],
    boolean: ['--manual'],
  });
  if (a.positional.length > 0) throw new Usage(`unexpected argument "${a.positional[0]}"`);
  const p = paths(io, a.values);

  const retain = a.values['--retain'];
  if (retain !== undefined) {
    if (a.flags.has('--manual') || a.values['--kind']) {
      throw new Usage('--retain takes a raw id and no other capture flag');
    }
    const r = retainRecord(p.raw, p.root, retain);
    io.out(r.already ? `${r.path} (already retained)` : r.path);
    return 0;
  }

  const manual = a.flags.has('--manual');
  const kind = manual ? 'session' : a.values['--kind'];
  if (manual && a.values['--kind']) throw new Usage('--manual records kind "session"; drop --kind');
  if (!kind) throw new Usage('wiki capture needs --manual, --kind <kind> or --retain <rawId>');
  if (!(CAPTURE_KINDS as readonly string[]).includes(kind)) {
    throw new Usage(`--kind must be one of ${CAPTURE_KINDS.join(', ')} (got "${kind}")`);
  }
  const need = (flag: string): string => {
    const v = a.values[flag];
    if (v === undefined || v === '') throw new Usage(`wiki capture needs ${flag}`);
    return v;
  };
  const tool = need('--tool');
  const env = need('--env');
  if (!(CAPTURE_ENVS as readonly string[]).includes(env)) {
    throw new Usage(`--env must be one of ${CAPTURE_ENVS.join(', ')} (got "${env}")`);
  }
  const passedArg = need('--passed');
  if (!['true', 'false', 'unknown'].includes(passedArg)) {
    throw new Usage(`--passed must be true, false or unknown (got "${passedArg}")`);
  }
  const read = (flag: string): string | undefined => {
    const file = a.values[flag];
    if (file === undefined) return undefined;
    const abs = resolve(io.cwd, file);
    if (!existsSync(abs)) throw new CaptureError(`${flag}: ${abs} not found`);
    return readFileSync(abs, 'utf8');
  };
  let excerpt: string;
  if (manual) {
    if (a.values['--excerpt-file'] || a.values['--verify-json']) {
      throw new Usage('--manual takes --note, not --excerpt-file or --verify-json');
    }
    excerpt = need('--note');
  } else {
    if (a.values['--note']) throw new Usage('--note belongs to --manual; use --excerpt-file');
    excerpt = read('--excerpt-file') ?? '';
  }
  const verifyText = read('--verify-json');
  let verify: unknown;
  if (verifyText !== undefined) {
    try {
      verify = JSON.parse(verifyText);
    } catch {
      throw new CaptureError('--verify-json: the file is not valid JSON');
    }
  }
  // Checked after the command line, so a wrong invocation is still reported when capture is off.
  if (rawOff(io.env)) return 0;
  const record = captureRecord({
    cwd: io.cwd,
    rawDir: p.raw,
    tool,
    env: env as CaptureEnv,
    kind: kind as CaptureKind,
    passed: passedArg === 'unknown' ? undefined : passedArg === 'true',
    excerpt,
    refs: a.lists['--ref'] ?? [],
    gitSha: a.values['--sha'],
    verify,
    processEnv: io.env,
  });
  io.out(record.rawId);
  return 0;
}
