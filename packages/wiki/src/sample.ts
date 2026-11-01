import { createHash } from 'node:crypto';
import { type RawRecord, truncateExcerpt } from '@rtrentjones/greenlight-shared';

/**
 * Raw-record sampling and truncation (vision 06 §3.2), shared by the maintainer bundle and the
 * proposer's trace listing. Everything here is a pure function of its inputs and the seed, so a
 * bundle built twice from the same raw store and seed holds the same records in the same order.
 *
 * Visibility comes first (06 §1.4): only field records and `train` bench records are ever
 * candidates. Val and test records are dropped before any ranking, so no limit, priority or seed
 * can surface one.
 */

export type Split = 'train' | 'val' | 'test';

/** The bench split of a record, or undefined for a field record. */
export const splitOf = (r: RawRecord): Split | undefined => r.bench?.split;

/** True for evidence an agent role may see: field records and train bench records (06 §1.4). */
export const isAgentVisible = (r: RawRecord): boolean =>
  r.kind !== 'bench' || r.bench?.split === 'train';

/** Numeric-aware version comparison ("10" > "9", "1.10" > "1.9"); non-numeric parts compare as
 * strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    const c = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : Math.sign(nx - ny) || 0;
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * The version of `skill` a record ran under: what the transcript observed (`skills.used`), else
 * what was installed. Undefined when the record names neither.
 */
export function skillVersionOf(r: RawRecord, skill: string): string | undefined {
  const used = r.skills.used === 'unknown' ? undefined : r.skills.used[skill];
  return used?.version ?? r.skills.installed[skill]?.version;
}

/** A record carries no skill attribution at all (bench rollouts stamp only a skill-set hash). */
export const unattributed = (r: RawRecord): boolean =>
  r.skills.used === 'unknown' && Object.keys(r.skills.installed).length === 0;

/**
 * Whether a record is evidence about `skill` (optionally `skill@version`): it ran under that skill,
 * or it carries no attribution at all and so cannot be excluded.
 */
export function matchesSkill(r: RawRecord, spec: string): boolean {
  const [skill = '', version] = spec.split('@');
  if (unattributed(r)) return true;
  const v = skillVersionOf(r, skill);
  return v !== undefined && (version === undefined || v === version);
}

/** The seeded tie-break key: a hash of seed and id, so the order is independent of input order. */
export const seededRank = (seed: string, id: string): string =>
  createHash('sha256').update(`${seed}\0${id}`).digest('hex');

export interface SampleOptions {
  /** Maximum failing records (default 5). */
  failing?: number;
  /** Maximum passing records (default 3). */
  passing?: number;
  /** Tie-break seed (06 §3.2: defaults to the bundle id, which the caller supplies). */
  seed: string;
  /** Restrict to evidence about this skill (`name` or `name@version`). */
  skill?: string;
  /** The cell of a record, for "passing in the same cell as a failing one"; defaults to its tool. */
  cellOf?: (r: RawRecord) => string;
}

export interface Sample {
  failing: RawRecord[];
  passing: RawRecord[];
}

/**
 * Samples at most `failing` failing and `passing` passing visible records, in priority order:
 *
 * 1. failing records whose `wikiHits` is empty (unexplained failures);
 * 2. failing records from the newest version of the skill in scope;
 * 3. passing records in the same cell as a sampled failing one;
 *
 * with ties broken by the seeded rank.
 */
export function sampleRecords(records: readonly RawRecord[], opts: SampleOptions): Sample {
  const maxFail = opts.failing ?? 5;
  const maxPass = opts.passing ?? 3;
  const cellOf = opts.cellOf ?? ((r: RawRecord) => r.tool);
  const skill = opts.skill?.split('@')[0];
  const pool = records.filter(
    (r) => isAgentVisible(r) && (opts.skill === undefined || matchesSkill(r, opts.skill)),
  );
  const rank = (r: RawRecord) => seededRank(opts.seed, r.rawId);

  const failingAll = pool.filter((r) => !r.passed);
  const versions = skill
    ? failingAll.flatMap((r) => {
        const v = skillVersionOf(r, skill);
        return v === undefined ? [] : [v];
      })
    : [];
  const newest = versions.sort(compareVersions).at(-1);
  const failKey = (r: RawRecord): [number, number, string] => [
    (r.wikiHits ?? []).length === 0 ? 0 : 1,
    newest !== undefined && skill && skillVersionOf(r, skill) === newest ? 0 : 1,
    rank(r),
  ];
  const failing = [...failingAll].sort((a, b) => compareKeys(failKey(a), failKey(b)));
  const pickedFail = failing.slice(0, maxFail);

  const failCells = new Set(pickedFail.map(cellOf));
  const passKey = (r: RawRecord): [number, string] => [failCells.has(cellOf(r)) ? 0 : 1, rank(r)];
  const passing = pool
    .filter((r) => r.passed)
    .sort((a, b) => compareKeys(passKey(a), passKey(b)))
    .slice(0, maxPass);
  return { failing: pickedFail, passing };
}

function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number | string;
    const y = b[i] as number | string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Parses `--sample <failing>:<passing>` ("5:3"). Throws on anything else. */
export function parseSampleSpec(spec: string): { failing: number; passing: number } {
  const m = /^(\d+):(\d+)$/.exec(spec);
  if (!m) throw new Error(`--sample must be "<failing>:<passing>", e.g. 5:3 (got "${spec}")`);
  return { failing: Number(m[1]), passing: Number(m[2]) };
}

const FAILING_LINE = /^\s*(FAIL|✘|✗)\b/;

/**
 * Bundle truncation (06 §3.2): the excerpt keeps the report's failing-check list, followed by the
 * last part of the remaining output, within `max` characters. When the list alone exceeds the
 * budget, it is cut head-first with a `…[truncated n chars]…` marker.
 */
export function bundleExcerpt(excerpt: string, max = 15_000): string {
  if (excerpt.length <= max) return excerpt;
  const lines = excerpt.split('\n');
  const list = lines.filter((l) => FAILING_LINE.test(l)).join('\n');
  const rest = lines.filter((l) => !FAILING_LINE.test(l)).join('\n');
  if (list.length + 1 >= max) return truncateExcerpt(list, max);
  return `${list}\n${truncateExcerpt(rest, max - list.length - 1)}`;
}
