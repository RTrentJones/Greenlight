import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { newRawId } from '@rtrentjones/greenlight-shared';
import {
  type BundleContext,
  BundleLeakError,
  BundleSecretError,
  type LintContext,
  PROPOSAL_FILE,
  type Role,
  type SeamTerms,
  applyMaintainerOutput,
  buildMaintainerBundle,
  buildProposerBundle,
  checkProposal,
  fix,
  lint,
  lintExitCode,
  listTraces,
  loadRawStore,
  loadSkills,
  loadWiki,
  parseSampleSpec,
  readBundleManifest,
  readTarget,
  recordAccess,
  withWrites,
  writeBundle,
  writeChangeset,
} from '@rtrentjones/greenlight-wiki';
import { parseFlags } from '../args';
import { findManifestPath, loadManifest } from '../manifest';
import { MODULE_REF } from '../version';

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

  lint [--strict] [--fix] [--json] [--framework] [--root <dir>]
                       run the wiki lint rules (exit 1 on errors; --strict also on warnings)
  render [--root <dir>]
                       regenerate index.md and skill-impact.md (same as lint --fix)
  ingest [--sample a:b] [--incident <id>] [--seed <s>] [--skill <n>] [--tool <n>] [--out <dir>]
                       write a maintainer bundle (.greenlight/bundles/<id>/) and print its path
  ingest --apply <maintainer-output.json> [--dry-run]
                       validate and apply a MaintainerOutput atomically, then lint
  propose [--skill <name>] [--out <dir>]
                       write a proposer bundle (index, skill-impact, outcomes, PROMPT.md)
  propose --apply <proposer-output.json> [--bundle <dir>]
                       validate a ProposerOutput and record it as the bundle's proposal.json
  read <page-id | raw:<rawId> | skill:<name>> [--role maintainer|proposer] [--json]
  traces [--skill <name>[@v]] [--failed|--passing] [--tool <n>] [--limit n] [--json]
                       the read-only interface; val/test bench records are never served

common: --root <wiki dir> (default wiki), --raw <raw dir> (default .greenlight/raw).
Inside a bundle, set GREENLIGHT_BUNDLE=<bundle dir> (or pass --bundle) so reads are logged.`;

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
    if (err instanceof Usage || msg.includes('unknown flag') || msg.includes('needs a value'))
      return 2;
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
}

function paths(io: WikiIo, values: Record<string, string>): Paths {
  return {
    root: resolve(io.cwd, values['--root'] ?? 'wiki'),
    raw: resolve(io.cwd, values['--raw'] ?? '.greenlight/raw'),
    skills: resolve(io.cwd, '.claude/skills'),
    templates: resolve(io.cwd, 'tools'),
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

/** Held-out task ids from `bench/splits.json` (framework repo), on top of the raw store's own. */
function heldOutTaskIds(cwd: string): string[] {
  const file = join(cwd, 'bench/splits.json');
  if (!existsSync(file)) return [];
  try {
    const splits = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    return Object.entries(splits)
      .filter(([, s]) => s !== 'train')
      .map(([id]) => id);
  } catch {
    return [];
  }
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
    heldOutTaskIds: heldOutTaskIds(io.cwd),
  });
  writeBundle(dir, bundle);
  io.err(
    `maintainer bundle: ${bundle.manifest.rawIds.length} raw record(s), ${bundle.files.size} files`,
  );
  io.out(dir);
  return 0;
}

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
  const key = (f: { rule: string; page: string; message: string }) =>
    `${f.rule}\0${f.page}\0${f.message}`;
  const before = new Set(lint(wiki, ctx).map(key));
  const scratch = withWrites(wiki, applied.changeset.writes);
  const introduced = lint(scratch, ctx).filter(
    (f) => f.severity === 'error' && !before.has(key(f)),
  );
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
    });
    if (!checked.ok) {
      io.err('✘ proposal refused:');
      for (const e of checked.errors.slice(0, 10)) io.err(`  ${e}`);
      return checked.code;
    }
    const record = {
      proposalId: checked.proposalId,
      bundle: readBundleManifest(bundleDir).id,
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
  const bundle = buildProposerBundle({
    id: a.values['--out'] ? basename(dir) : id,
    dir,
    wiki,
    records: store.records,
    skills: skill ? [skill] : managed,
    skill,
    heldOutTaskIds: heldOutTaskIds(io.cwd),
  });
  writeBundle(dir, bundle);
  io.out(dir);
  return 0;
}

// ---- read / traces ---------------------------------------------------------------------------

/** The role in effect: the bundle's (when one is named), else `--role`, else a building agent. */
function roleOf(io: WikiIo, values: Record<string, string>): { role: Role; bundle?: string } {
  const named = values['--bundle'] ?? io.env.GREENLIGHT_BUNDLE;
  const flag = values['--role'];
  if (flag !== undefined && !['maintainer', 'proposer', 'agent'].includes(flag)) {
    throw new Usage(`--role must be maintainer, proposer or agent (got "${flag}")`);
  }
  if (named) {
    const bundle = resolve(io.cwd, named);
    const manifest = readBundleManifest(bundle);
    // A bundle fixes the role; --role can only narrow a maintainer bundle, never widen.
    const role: Role = manifest.role === 'maintainer' && flag ? (flag as Role) : manifest.role;
    return { role, bundle };
  }
  return { role: (flag as Role | undefined) ?? 'agent' };
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
  const { role, bundle } = roleOf(io, a.values);
  const result = readTarget(ref, role, {
    wiki: existsSync(p.root) ? loadWiki(p.root) : undefined,
    records: ref.startsWith('raw:') ? loadRawStore(p.raw).records : [],
    skillsDir: p.skills,
  });
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
  const { bundle } = roleOf(io, a.values);
  const rows = listTraces(loadRawStore(p.raw).records, {
    skill: a.values['--skill'],
    tool: a.values['--tool'],
    failed,
    passing: a.flags.has('--passing'),
    limit,
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
