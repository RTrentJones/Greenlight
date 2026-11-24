import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VerifyReport } from '@rtrentjones/greenlight-verify';
import {
  type LookupHit,
  type LookupSource,
  failureLinks,
  loadWiki,
} from '@rtrentjones/greenlight-wiki';
import { frameworkWikiDir } from './asset-paths';
import { MODULE_REF } from './version';

/**
 * The on-failure hook (vision 05 §3, 07 §2.4 step 2, FR-LOOP-02 and FR-LOOP-08): a failing gate
 * names the confirmed patterns whose `catches.checkSignature` matches a failing check, in the same
 * output, so the agent reads the known fix before changing anything.
 *
 * The framework wiki is read from the installed package. It is not materialized into the wrapper,
 * so a framework page is named by id and read with `greenlight wiki read <id>`.
 */

/** The framework version the wiki's `affects` ranges are compared with. */
export const INSTALLED_VERSION = MODULE_REF.replace(/^v/, '');

/** `GREENLIGHT_WIKI=off` disables every wiki hook (07 §0); the bench runner sets it. */
export const wikiOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.GREENLIGHT_WIKI === 'off';

/** The project wiki (when the directory exists) and the framework wiki, project first. A wiki that
 * cannot be loaded is left out: a hook never blocks the gate it annotates. */
export function lookupSources(cwd: string, projectRoot = 'wiki'): LookupSource[] {
  const sources: LookupSource[] = [];
  const project = resolve(cwd, projectRoot);
  const framework = frameworkWikiDir();
  const add = (dir: string, origin: LookupSource['origin']) => {
    try {
      if (existsSync(dir)) sources.push({ wiki: loadWiki(dir), origin });
    } catch {
      // Unreadable wiki: no links, and `wiki lint` is where the problem is reported.
    }
  };
  add(project, 'project');
  if (framework && resolve(framework) !== project) add(framework, 'framework');
  return sources;
}

/** Every failing check's id and name, without duplicates. */
export function failingChecks(reports: readonly VerifyReport[]): string[] {
  const out = new Set<string>();
  for (const r of reports) {
    for (const c of r.checks) {
      if (c.pass) continue;
      if (c.id) out.add(c.id);
      out.add(c.name);
    }
  }
  return [...out];
}

export const WIKI_BLOCK_LIMIT = 3;

export function wikiHitsFor(
  reports: readonly VerifyReport[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; sources?: readonly LookupSource[] } = {},
): LookupHit[] {
  if (wikiOff(opts.env)) return [];
  const failing = failingChecks(reports);
  if (failing.length === 0) return [];
  const sources = opts.sources ?? lookupSources(opts.cwd ?? process.cwd());
  return failureLinks(sources, failing, { installed: INSTALLED_VERSION }).slice(
    0,
    WIKI_BLOCK_LIMIT,
  );
}

/** Where a hit can be read: a path for a project page, a command for a framework page. */
export const hitLocation = (hit: Pick<LookupHit, 'id' | 'path' | 'origin'>): string =>
  hit.origin === 'project' ? `wiki/${hit.path}` : `greenlight wiki read ${hit.id}`;

/** The `wiki:` block that ends a failing human report; empty when nothing matched. */
export function wikiBlockLines(hits: readonly LookupHit[]): string[] {
  if (hits.length === 0) return [];
  return [
    '',
    'wiki: read these before changing anything',
    ...hits.map(
      (h) => `  see: ${h.id} — ${h.title} (${hitLocation(h)})${h.note ? ` [${h.note}]` : ''}`,
    ),
  ];
}

/** Prints the block for failing reports and returns the linked page ids. Never throws. */
export function printWikiBlock(
  reports: readonly VerifyReport[],
  log: (s: string) => void = console.log,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  try {
    const hits = wikiHitsFor(reports, opts);
    for (const line of wikiBlockLines(hits)) log(line);
    return hits.map((h) => h.id);
  } catch {
    return [];
  }
}
