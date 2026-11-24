import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecrets, redact } from '@rtrentjones/greenlight-shared';

/** Every text file under `dir` (at most 1 MB each): what the task itself shows the agent. */
export function fixtureTexts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && lstatSync(p).size <= 1024 * 1024) out.push(readFileSync(p, 'utf8'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * The send guard for a rollout (06 §4.8): `findSecrets`, minus values the task's own fixture
 * shows in the clear. The detector reads CONTEXT: a fixture's publishable key
 * (`sb_publishable_…_fixture_anon`) is clean as `"anonKey": "…"` in `targets.json`, but the same
 * value is flagged in the model's own `curl -H "apikey: …"`, and the next request was refused,
 * which stopped the whole evaluation over a value the harness itself had handed the model.
 *
 * A flagged value is let through only when it occurs verbatim in a fixture text (or the brief)
 * AND the detector does not flag it there. A value the detector flags in the fixture itself (a
 * real token committed to a fixture by mistake) is still refused, as is any value that is not in
 * the fixture at all.
 */
export function fixtureAwareDetector(texts: readonly string[]): (text: string) => unknown[] {
  const flaggedInFixture = new Set<string>();
  for (const t of texts)
    for (const f of findSecrets(t)) flaggedInFixture.add(t.slice(f.index, f.index + f.length));
  const shown = (value: string) =>
    value.length >= 8 &&
    !flaggedInFixture.has(value) &&
    texts.some((t) => t.includes(value)) &&
    ![...flaggedInFixture].some((bad) => bad.includes(value) || value.includes(bad));
  return (text) => findSecrets(text).filter((f) => !shown(text.slice(f.index, f.index + f.length)));
}

/** Every string leaf redacted (stored transcripts never keep a flagged value). */
export function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/** Paths of every string leaf the detector flags. Scanning the parsed value, not its JSON text,
 * matters: JSON escaping turns a newline into a literal `\n`, so a line such as
 * `github_token = var.keepalive_github_token` stops looking like a code expression and is
 * flagged in the serialized form although it is clean as the string it is (2026-11-04 drill). */
export function flaggedLeaves(v: unknown, path = '$'): string[] {
  if (typeof v === 'string') return findSecrets(v).length > 0 ? [path] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => flaggedLeaves(x, `${path}[${i}]`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => flaggedLeaves(x, `${path}.${k}`));
  return [];
}

/** Replaces each flagged string leaf (by the paths `flaggedLeaves` returns) in place. */
export function withholdLeaves(v: unknown, paths: Set<string>, path = '$'): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const p = `${path}[${i}]`;
      if (typeof x === 'string' && paths.has(p))
        v[i] = '[withheld: flagged by the secret detector]';
      else withholdLeaves(x, paths, p);
    });
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) {
      const p = `${path}.${k}`;
      if (typeof x === 'string' && paths.has(p))
        o[k] = '[withheld: flagged by the secret detector]';
      else withholdLeaves(x, paths, p);
    }
  }
}

/** The rollout artifacts that hold agent-written text besides the transcript. */
export const REDACTED_ARTIFACTS = ['trajectory.jsonl', 'diff.patch', 'output.json'] as const;

/**
 * Redacts the stored copies of a rollout's trajectory, diff and maintainer output in place (08
 * §5.2: raw capture redacts). Call it only once grading is done: the grader reads the originals.
 * JSON and JSONL are redacted leaf by leaf so they stay parseable; anything else as text.
 */
export function redactArtifacts(dir: string): void {
  const json = (text: string) => JSON.stringify(redactDeep(JSON.parse(text)));
  for (const name of REDACTED_ARTIFACTS) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    let out: string;
    try {
      if (name.endsWith('.jsonl'))
        out = text
          .split('\n')
          .map((l) => (l.trim() ? json(l) : l))
          .join('\n');
      else if (name.endsWith('.json'))
        out = `${JSON.stringify(redactDeep(JSON.parse(text)), null, 2)}\n`;
      else out = redact(text);
    } catch {
      out = redact(text);
    }
    if (out !== text) writeFileSync(file, out);
  }
}
