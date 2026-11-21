#!/usr/bin/env tsx
/**
 * Seam check — enforces hard rule 15.2.1 (docs/archive/greenlight-v1.md §15.2):
 * no personal value (domain, email, real tokens) may appear in a FRAMEWORK file.
 * Every framework file must read such values from the manifest at runtime.
 *
 * This is what keeps "the clonable baseline" free of "my personal setup".
 * Docs (*.md) and the local manifest are intentionally NOT scanned — they may
 * legitimately reference the real domain.
 *
 * Exit non-zero on any hit. Run via `pnpm check-seam`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SeamTerms, lint } from '../packages/wiki/src/lint';
import { loadWiki } from '../packages/wiki/src/load';

const ROOT = process.cwd();

/** This file is the detector — it necessarily names the forbidden strings, so it is exempt. */
const SELF = fileURLToPath(import.meta.url);

/** Directories / files that are part of the shippable framework. */
const FRAMEWORK_PATHS = [
  'cli',
  'packages',
  'apps',
  'infra',
  'scripts',
  'tools',
  '.github/workflows',
  'greenlight.config.example.ts',
];

/** Never descend into these. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.git', 'coverage']);

/**
 * Forbidden personal strings. NOTE: the npm scope `@rtrentjones` is the
 * framework's published identity and is allowed — only the personal *domain*
 * and *email* are forbidden in framework code.
 */
const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /rtrentjones\.dev/i, label: 'personal domain (rtrentjones.dev)' },
  { pattern: /rtrentjones@gmail\.com/i, label: 'personal email' },
];

/**
 * The owner's personal values for the framework wiki (LR-19, vision 04 §5). Wiki pages are
 * markdown, which the line scan above skips, and their `evidence` refs may legitimately name the
 * owner's repositories and blog — so `wiki/` is checked with the LR-19 rule itself, which exempts
 * exactly the evidence fields. This file is the one place allowed to name these values.
 */
export const OWNER_SEAM_TERMS: SeamTerms = {
  domains: ['rtrentjones.dev'],
  emails: ['rtrentjones@gmail.com'],
  toolNames: ['heistmind', 'bamcp', 'polyphony', 'tracer', 'muse', 'pg_kafka', 'pg-kafka'],
};

/** LR-19 findings on the framework wiki at `<root>/wiki`, as printable lines. */
export function wikiSeamViolations(root: string): string[] {
  const dir = resolve(root, 'wiki');
  if (!existsSync(dir)) return [];
  return lint(loadWiki(dir), { kind: 'framework', seam: OWNER_SEAM_TERMS })
    .filter((f) => f.rule === 'LR-19')
    .map((f) => `  wiki/${f.page}  ${f.message} (LR-19)`);
}

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|yml|yaml|tf|tfvars|toml|sh|env|txt)$/;

function walk(path: string, out: string[]): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return; // path doesn't exist yet (e.g. infra/ before Phase 5)
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(join(path, entry), out);
    }
  } else if (st.isFile() && path !== SELF && TEXT_EXT.test(path)) {
    out.push(path);
  }
}

function main(): void {
  const files: string[] = [];
  for (const p of FRAMEWORK_PATHS) walk(join(ROOT, p), files);

  const violations: string[] = wikiSeamViolations(ROOT);
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) {
          violations.push(`  ${relative(ROOT, file)}:${i + 1}  ${label}\n    > ${line.trim()}`);
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error(
      `✘ Seam check failed — personal data found in ${violations.length} framework location(s):\n`,
    );
    console.error(violations.join('\n\n'));
    console.error(
      '\nFramework files must read personal values from the manifest, not hardcode them (rule 15.2.1).',
    );
    process.exit(1);
  }

  console.log(
    `✔ Seam check passed — scanned ${files.length} framework files and the framework wiki, no personal data.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main();
