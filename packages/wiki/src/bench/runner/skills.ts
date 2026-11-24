import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedSkills } from '@rtrentjones/greenlight-shared';
import type { Skill, TranscriptEntry } from '../../llm/react';

/** A skill a task declares that is not in the skills directory. A rollout without the skill
 * under test measures something else, so this is a harness error, never a graded 0. */
export class MissingSkillError extends Error {}

export function loadSkillsFor(skillsDir: string, names: readonly string[]): Skill[] {
  return names.map((name) => {
    const f = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(f))
      throw new MissingSkillError(
        `skill "${name}" is declared by the task but ${join(skillsDir, name, 'SKILL.md')} does not exist`,
      );
    return { name, content: readFileSync(f, 'utf8') };
  });
}

/** `skills.used`: the skills injected into the prompt, plus any SKILL.md the agent read. */
export function usedSkills(
  transcript: readonly TranscriptEntry[],
  installed: Record<string, { version: string; contentHash: string }>,
  injected: readonly string[],
) {
  const used = new Set(injected);
  for (const e of transcript) {
    if (e.kind !== 'tool_call') continue;
    const text = JSON.stringify(e.args);
    for (const m of text.matchAll(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/g))
      used.add(m[1] as string);
  }
  return Object.fromEntries(
    [...used]
      .filter((n) => installed[n])
      .map((n) => [n, installed[n] as { version: string; contentHash: string }]),
  );
}

/** `installedSkills` of the exported tree without following anything out of it: only real
 * directories and regular SKILL.md files under 1 MB are read, through a private copy. */
export function treeSkills(tree: string): ReturnType<typeof installedSkills> {
  const mirror = mkdtempSync(join(tmpdir(), 'greenlight-skills-'));
  const st = (p: string) => {
    try {
      return lstatSync(p);
    } catch {
      return undefined;
    }
  };
  try {
    for (const root of ['.agents/skills', '.claude/skills']) {
      let dir = tree;
      let ok = true;
      for (const part of root.split('/')) {
        dir = join(dir, part);
        if (!st(dir)?.isDirectory()) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const name of readdirSync(dir)) {
        if (!st(join(dir, name))?.isDirectory()) continue;
        const file = join(dir, name, 'SKILL.md');
        const f = st(file);
        if (!f?.isFile() || f.size > 1024 * 1024) continue;
        mkdirSync(join(mirror, root, name), { recursive: true });
        copyFileSync(file, join(mirror, root, name, 'SKILL.md'));
      }
    }
    return installedSkills(mirror);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}
