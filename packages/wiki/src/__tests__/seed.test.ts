import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EVIDENCE_REF_RE } from '@rtrentjones/greenlight-shared';
import { describe, expect, it } from 'vitest';
import { OWNER_SEAM_TERMS, wikiSeamViolations } from '../../../../scripts/check-seam';
import { fix, lint, lintExitCode } from '../lint';
import { loadWiki } from '../load';
import { loadSkills } from '../skills';

// 13 §2.2 "seeds pass actual lint": the committed framework wiki (roadmap M1-02), not a copy.

const REPO = resolve(__dirname, '../../../..');
const SEED = join(REPO, 'wiki');
const wiki = loadWiki(SEED);
const ctx = {
  kind: 'framework' as const,
  skills: loadSkills(join(REPO, '.claude/skills')),
  seam: OWNER_SEAM_TERMS,
};

// Each confirmation is justified in log.md against deployed red→green evidence (04 §4). The
// keepalive and compute-replacement pages have no such evidence yet (re-review 2026-11-01).
const CONFIRMED = [
  'pattern/dcr-disabled-silently',
  'pattern/settle-greenlights-previous-deploy',
  'pattern/spec-typo-disables-assertion',
];
const HYPOTHESES = [
  'pattern/keepalive-probe-cached',
  'pattern/keepalive-probe-misses-postgres',
  'pattern/neon-never-sleeps',
  'pattern/probe-touches-wrong-layer',
  'pattern/unplanned-compute-replacement',
];

describe('framework wiki seed', () => {
  it('passes wiki lint --strict with no findings at all', () => {
    expect(wiki.pageErrors).toEqual([]);
    const findings = lint(wiki, ctx);
    expect(findings).toEqual([]);
    expect(lintExitCode(findings, { strict: true })).toBe(0);
  });

  it('is fully generated: lint --fix has nothing to change (index, skill-impact)', () => {
    expect(fix(wiki).writes).toEqual([]);
    expect(readFileSync(join(SEED, 'ledger.jsonl'), 'utf8')).toBe('');
  });

  it('seeds exactly the three confirmed patterns and the named hypotheses (15 §8.1)', () => {
    const status = (s: string) =>
      [...wiki.pages.values()]
        .filter((p) => p.frontmatter.type === 'pattern' && p.frontmatter.status === s)
        .map((p) => p.id)
        .sort();
    expect(status('confirmed')).toEqual(CONFIRMED);
    expect(status('hypothesis')).toEqual(HYPOTHESES);
  });

  it('every confirmed pattern satisfies LR-05 with well-formed, resolved (non-TODO) evidence', () => {
    for (const id of CONFIRMED) {
      const fm = wiki.pages.get(id)?.frontmatter;
      if (fm?.type !== 'pattern') throw new Error(`${id} missing`);
      expect(fm.evidence.length).toBeGreaterThan(0);
      for (const ref of fm.evidence) expect(ref).toMatch(EVIDENCE_REF_RE);
      expect(fm.catches).toBeDefined();
      expect(fm.remediation.some((r) => r.verified)).toBe(true);
    }
    expect(readFileSync(join(SEED, 'patterns/neon-never-sleeps.md'), 'utf8')).not.toMatch(/TODO/);
  });

  it('records every confirmation in log.md with its evidence (04 §4)', () => {
    for (const id of CONFIRMED) expect(wiki.log).toContain(id);
  });

  it('incident patterns name only pages that exist', () => {
    for (const p of wiki.pages.values()) {
      if (p.frontmatter.type !== 'incident') continue;
      for (const id of p.frontmatter.patterns) expect(wiki.pages.has(id)).toBe(true);
    }
  });

  it('check-seam covers wiki/: a planted owner tool name in prose fails LR-19', () => {
    const root = mkdtempSync(join(tmpdir(), 'gl-seam-'));
    try {
      cpSync(SEED, join(root, 'wiki'), { recursive: true });
      expect(wikiSeamViolations(root)).toEqual([]);
      const file = join(root, 'wiki/patterns/neon-never-sleeps.md');
      const tool = OWNER_SEAM_TERMS.toolNames?.[2] as string;
      writeFileSync(file, `${readFileSync(file, 'utf8')}\nSeen first on ${tool}.\n`);
      expect(wikiSeamViolations(root).join()).toMatch(/patterns\/neon-never-sleeps\.md.*LR-19/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
