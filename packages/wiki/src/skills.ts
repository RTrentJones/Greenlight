import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LintSkill } from './lint';
import { splitFrontmatter } from './parse';

/**
 * Managed skills on disk, as lint (LR-11, LR-12) and bundles (`context.json`) need them: each
 * `<dir>/<name>/SKILL.md` with its `version`, and its `PURPOSE.md` sidecar (08 §2.2) when present.
 * A frontmatter block that does not parse yields no version, which LR-12 then reports.
 */

function frontmatter(path: string): Record<string, unknown> | undefined {
  try {
    const { yaml } = splitFrontmatter(path, readFileSync(path, 'utf8'));
    const data = parseYaml(yaml) as unknown;
    return data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

export function loadSkills(dir: string): LintSkill[] {
  if (!existsSync(dir)) return [];
  const out: LintSkill[] = [];
  for (const name of readdirSync(dir).sort()) {
    const skillFile = join(dir, name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const skill: LintSkill = { name, version: str(frontmatter(skillFile)?.version) };
    const purposeFile = join(dir, name, 'PURPOSE.md');
    if (existsSync(purposeFile)) {
      const fm = frontmatter(purposeFile) ?? {};
      const cites = Array.isArray(fm.cites)
        ? fm.cites.flatMap((c) => {
            const id = str((c as { id?: unknown } | null)?.id);
            return id ? [{ id }] : [];
          })
        : [];
      skill.purpose = { path: `${name}/PURPOSE.md`, version: str(fm.version), cites };
    }
    out.push(skill);
  }
  return out;
}
