import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { IsoDate } from '../../schema/common';
import { type RunnerImage, dockerAvailable, ensureRunnerImage } from '../sandbox';
import type { SandboxOptions } from './evaluated-tree';
import { errMsg, issues, tail } from './helpers';
import { runProcess } from './process';
import { dockerClientEnv, makeReadable, removeContainer, sandboxRunArgs, stampOf } from './sandbox';

// ---- trusted repros (bench/repro/<slug>/) ---------------------------------------------------

export const ReproSpecSchema = z
  .object({
    /** `repro/<slug>`, matching its folder. */
    id: z.string().regex(/^repro\/[a-z0-9][a-z0-9-]*$/),
    description: z.string().min(1),
    /** Wiki pattern ids this repro reproduces; selection intersects them with the proposal's. */
    patterns: z.array(z.string().min(1)).min(1),
    outlets: z.array(z.enum(['mechanism', 'doctor'])).min(1),
    /** The script, relative to the repro folder: `node <script> --tree <checkout>`; exit 0 =
     * passes (the condition is handled), 1 = fails (reproduced), anything else = error. */
    script: z.string().regex(/^[\w.-]+\.mjs$/),
    timeoutMs: z.number().int().min(1000).max(1_800_000).default(180_000),
    /** The human review that makes the repro trusted (06 §4.6). Null until reviewed: an
     * unreviewed repro is never evidence. */
    reviewed: z
      .object({ by: z.string().min(1), at: IsoDate })
      .strict()
      .nullable(),
  })
  .strict();
export type ReproSpec = z.infer<typeof ReproSpecSchema>;

export interface LoadedRepro {
  spec: ReproSpec;
  dir: string;
}

/** Every repro under `<benchDir>/repro/`, validated; a folder that does not match its id, or a
 * missing script, is a problem. */
export function loadRepros(benchDir: string): { repros: LoadedRepro[]; problems: string[] } {
  const root = join(benchDir, 'repro');
  const repros: LoadedRepro[] = [];
  const problems: string[] = [];
  if (!existsSync(root)) return { repros, problems };
  for (const slug of readdirSync(root).sort()) {
    const dir = join(root, slug);
    const file = join(dir, 'repro.json');
    if (!existsSync(file)) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`repro ${slug}: repro.json is not JSON: ${errMsg(e)}`);
      continue;
    }
    const r = ReproSpecSchema.safeParse(json);
    if (!r.success) {
      problems.push(`repro ${slug}: repro.json is invalid: ${issues(r.error)}`);
      continue;
    }
    if (r.data.id !== `repro/${slug}`) {
      problems.push(`repro ${slug}: id "${r.data.id}" does not match its folder`);
      continue;
    }
    if (!existsSync(join(dir, r.data.script))) {
      problems.push(`repro ${slug}: no ${r.data.script}`);
      continue;
    }
    repros.push({ spec: r.data, dir });
  }
  return { repros, problems };
}

export type ReproVerdict = 'pass' | 'fail' | 'error';

export interface ReproRun {
  verdict: ReproVerdict;
  output: string;
  /** No sandbox could run it (no docker, no runner image): neither a verdict nor an error. */
  unavailable?: boolean;
}

/**
 * Runs one trusted repro against `tree` inside the docker sandbox (`sandboxRunArgs`): the repro
 * folder is mounted read-only from the HARNESS tree at `/opt/gl-repro`, the tree read-only at its
 * host path, and `node /opt/gl-repro/<script> --tree <tree>` runs as uid 10000 with no network
 * and no harness environment. The verdict is the container's exit code (0 pass, 1 fail, else
 * error), which nothing the tree runs can write to a host file; the output is the container's
 * stdout/stderr, read by the host. Without docker or the runner image: `unavailable`.
 */
export async function runSandboxedRepro(
  harnessRoot: string,
  repro: LoadedRepro,
  tree: string,
  o: SandboxOptions = {},
): Promise<ReproRun> {
  const docker = o.docker ?? 'docker';
  if (!dockerAvailable(docker)) {
    return { verdict: 'error', output: 'docker is not available', unavailable: true };
  }
  let image: RunnerImage;
  try {
    image = o.image ?? ensureRunnerImage(join(harnessRoot, 'bench', 'runner'), { docker });
  } catch (e) {
    return { verdict: 'error', output: `no runner image: ${errMsg(e)}`, unavailable: true };
  }
  const dir = resolve(tree);
  makeReadable(dir);
  const name = `gl-repro-${stampOf(dir)}`;
  const args = sandboxRunArgs({
    name,
    image,
    tree: dir,
    outputs: [],
    mounts: ['-v', `${resolve(repro.dir)}:/opt/gl-repro:ro`],
    workdir: '/tmp',
    path: '/usr/local/bin:/usr/bin:/bin',
    memory: o.memory,
    cpus: o.cpus,
  });
  const res = await runProcess(
    docker,
    [...args, 'node', `/opt/gl-repro/${repro.spec.script}`, '--tree', dir],
    { cwd: tmpdir(), env: dockerClientEnv(), timeoutMs: repro.spec.timeoutMs },
  );
  if (res.timedOut) await removeContainer(docker, name);
  // 125: docker itself could not start the container; no verdict on the tree.
  if (res.code === 125) {
    return {
      verdict: 'error',
      output: `docker run failed: ${tail(res.output)}`,
      unavailable: true,
    };
  }
  const verdict: ReproVerdict =
    res.timedOut || res.code === null
      ? 'error'
      : res.code === 0
        ? 'pass'
        : res.code === 1
          ? 'fail'
          : 'error';
  return {
    verdict,
    output: res.timedOut ? `timed out after ${repro.spec.timeoutMs} ms\n${res.output}` : res.output,
  };
}
