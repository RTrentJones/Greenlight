import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type RunnerAssets, hashTree } from '@rtrentjones/greenlight-wiki';

/**
 * The two builds a bench rollout needs (vision 06 §4.2), made from the framework checkout:
 * - `cli/greenlight.mjs`: the greenlight CLI as ONE file (every dependency inlined except jiti,
 *   which is copied next to it with its own dist, and the lazy optional playwright/anthropic). It
 *   is the only part of the repo mounted into a rollout container (read-only, `/opt/real/greenlight`, runnable only through the recorder),
 *   so `greenlight preview` works inside the sandbox with no install and no source checkout.
 * - `grade/bench-grade.mjs`: the grading driver and grader child (grade.ts), mounted into the
 *   grading container.
 * Built with esbuild (a dev dependency of the checkout, through tsup), deterministically and with
 * paths relative to the repo root, so `hashTree(cliDir)` is a stable part of `depsHash`.
 */

const BANNER =
  "import { createRequire as __glCreateRequire } from 'node:module'; const require = __glCreateRequire(import.meta.url);";

interface Esbuild {
  build(o: Record<string, unknown>): Promise<unknown>;
}

function loadEsbuild(repoRoot: string): Esbuild {
  const req = createRequire(join(repoRoot, 'package.json'));
  try {
    return createRequire(req.resolve('tsup'))('esbuild') as Esbuild;
  } catch {
    return req('esbuild') as Esbuild;
  }
}

export async function buildBenchAssets(repoRoot: string, outDir?: string): Promise<RunnerAssets> {
  const out = outDir ?? mkdtempSync(join(tmpdir(), 'greenlight-bench-assets-'));
  const esbuild = loadEsbuild(repoRoot);
  const common = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    absWorkingDir: repoRoot,
    banner: { js: BANNER },
    logLevel: 'silent',
    legalComments: 'none',
  };
  const cliDir = join(out, 'cli');
  const gradeDir = join(out, 'grade');
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(gradeDir, { recursive: true });
  await esbuild.build({
    ...common,
    entryPoints: ['cli/src/bin.ts'],
    outfile: join(cliDir, 'greenlight.mjs'),
    external: ['playwright', '@anthropic-ai/sdk', 'jiti'],
  });
  const cliReq = createRequire(join(repoRoot, 'cli', 'package.json'));
  const jitiDir = dirname(cliReq.resolve('jiti/package.json'));
  cpSync(jitiDir, join(cliDir, 'node_modules', 'jiti'), { recursive: true, dereference: true });
  await esbuild.build({
    ...common,
    entryPoints: ['cli/src/bench-grade-entry.ts'],
    outfile: join(gradeDir, 'bench-grade.mjs'),
    external: ['playwright', '@anthropic-ai/sdk'],
  });
  const version = (
    JSON.parse(readFileSync(join(repoRoot, 'cli', 'package.json'), 'utf8')) as { version: string }
  ).version;
  const lockfile = join(repoRoot, 'pnpm-lock.yaml');
  return {
    cliDir,
    cliBuildHash: hashTree(cliDir),
    greenlightVersion: version,
    gradeBundle: join(gradeDir, 'bench-grade.mjs'),
    lockfile: existsSync(lockfile) ? lockfile : join(repoRoot, 'package.json'),
  };
}
