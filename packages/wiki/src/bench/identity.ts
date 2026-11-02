import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { skillSetHash } from '../bundle';
import {
  type BaselineIdentity,
  BaselineIdentitySchema,
  type IdentityTask,
  type TaskSpec,
  identityTasks,
} from '../schema/bench';
import { canonicalJson } from '../schema/common';

/**
 * BaselineIdentity (vision 06 §1.5, 08 §10.3): the hashes that pin every input of an evaluation, so
 * a baseline and a candidate are compared only when nothing but the skill set differs, and a cached
 * train evaluation is reused only when nothing at all differs.
 *
 * Every hash is a sha256 over a deterministic byte stream:
 * - a FILE TREE hashes each entry in sorted relative-path order as `f\0<path>\0<sha256 of bytes>\n`
 *   (files) or `l\0<path>\0<link target>\n` (symlinks); directories contribute through their
 *   entries, so an empty directory is invisible; a missing tree hashes as the literal `absent`;
 * - a TASK contributes `<id>\0` + the hashes of `task.json`, `brief.md` and the `fixture/` tree;
 * - lists are taken in task-id order (byte order), never file-system order.
 */

/** The runner's own version: its prompt scaffolding, tool set and sandbox contract. Part of
 * `harness.runnerVersion`; bump it on any change that could change an agent's behaviour. */
export const RUNNER_VERSION = '0.2.1';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function walk(dir: string, rel: string, out: string[]): void {
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const r = rel === '' ? name : `${rel}/${name}`;
    const st = lstatSync(join(dir, r));
    if (st.isSymbolicLink()) out.push(`l\0${r}\0${readlinkSync(join(dir, r))}\n`);
    else if (st.isDirectory()) walk(dir, r, out);
    else if (st.isFile()) out.push(`f\0${r}\0${sha256(readFileSync(join(dir, r)))}\n`);
  }
}

/** sha256 over a file tree (or one file); `absent` when the path does not exist. */
export function hashTree(path: string): string {
  if (!existsSync(path)) return sha256('absent');
  if (lstatSync(path).isFile()) return sha256(`f\0\0${sha256(readFileSync(path))}\n`);
  const lines: string[] = [];
  walk(path, '', lines);
  return sha256(lines.join(''));
}

const fileHash = (p: string) => (existsSync(p) ? sha256(readFileSync(p)) : sha256('absent'));
const byId = (ids: readonly string[]) => [...new Set(ids)].sort();

/** Over the task summaries (canonical JSON), then `task.json` + `brief.md` + `fixture/` of every
 * task, in id order. */
export function taskSetHash(
  benchDir: string,
  taskIds: readonly string[],
  summary: readonly IdentityTask[] = [],
): string {
  const h = createHash('sha256');
  h.update(`${canonicalJson(summary)}\n`);
  for (const id of byId(taskIds)) {
    const dir = join(benchDir, 'tasks', id);
    h.update(`${id}\0${fileHash(join(dir, 'task.json'))}\0${fileHash(join(dir, 'brief.md'))}\0`);
    h.update(`${hashTree(join(dir, 'fixture'))}\n`);
  }
  return h.digest('hex');
}

/** Over the whole `splits.json` (canonical JSON) and each selected task's `state`. */
export function splitsHash(
  benchDir: string,
  tasks: readonly Pick<TaskSpec, 'id' | 'state'>[],
): string {
  const file = join(benchDir, 'splits.json');
  const splits = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null;
  const states = Object.fromEntries(
    [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => [t.id, t.state]),
  );
  return sha256(canonicalJson({ splits, states }));
}

/** Over everything that decides a verdict for these tasks: `graders/<id>/`, `mutants/<id>/` and
 * `references/<id>/` per task, plus the shared grader implementations `graders/_lib/` and the
 * grader-side fake stores `fixtures/` (a grader loads both). */
export function graderSetHash(benchDir: string, taskIds: readonly string[]): string {
  const h = createHash('sha256');
  h.update(`_lib\0${hashTree(join(benchDir, 'graders', '_lib'))}\n`);
  h.update(`fixtures\0${hashTree(join(benchDir, 'fixtures'))}\n`);
  for (const id of byId(taskIds)) {
    for (const part of ['graders', 'mutants', 'references']) {
      h.update(`${part}/${id}\0${hashTree(join(benchDir, part, id))}\n`);
    }
  }
  return h.digest('hex');
}

/** Over the bench runner's lockfile and the installed greenlight: its version and the content hash
 * of the CLI build mounted into the sandbox (what `greenlight preview` actually runs). */
export function depsHash(input: {
  lockfile: string;
  greenlightVersion: string;
  cliBuildHash: string;
}): string {
  return sha256(
    canonicalJson({
      lockfile: fileHash(input.lockfile),
      greenlight: input.greenlightVersion,
      cliBuild: input.cliBuildHash,
    }),
  );
}

/** The managed skill set (08 §10.3), as the proposer and gate name it: `skillSetHash` of
 * bundle.ts (canonical JSON of every skill's SKILL.md and PURPOSE.md, by name). An empty skill
 * directory hashes as the empty set. */
export function skillSetHashOf(skillsDir: string): string {
  return skillSetHash(skillsDir) ?? sha256(canonicalJson([]));
}

export interface IdentityInput {
  benchDir: string;
  /** Every task of the evaluated split (all states), not just the selected ones: a change to any
   * of them re-baselines (06 §1.5). */
  tasks: readonly Pick<TaskSpec, 'id' | 'kind' | 'state' | 'modes' | 'graders'>[];
  skillsDir: string;
  lockfile: string;
  greenlightVersion: string;
  cliBuildHash: string;
  /** `docker image inspect` id of the runner image, or `process` for the local process sandbox. */
  imageDigest: string;
  agent: { vendor: string; version: string };
  /** The evaluated model ids, in `bench/models.json` order. */
  models: readonly string[];
  mode: 'isolation' | 'production';
  /** REQUIRED in production mode (M3); null in isolation. */
  wikiSnapshotHash?: string | null;
  proxyPolicyHash?: string | null;
  runnerVersion?: string;
  /** The rollout limits (`harness.limits`): max ReAct steps, the per-rollout request cap, and the
   * rollout timeout override in minutes (null: each task's own `timeoutMin`). */
  limits: NonNullable<BaselineIdentity['harness']['limits']>;
}

export function computeIdentity(i: IdentityInput): BaselineIdentity {
  const ids = i.tasks.map((t) => t.id);
  const tasks = identityTasks(i.tasks);
  return BaselineIdentitySchema.parse({
    taskSetHash: taskSetHash(i.benchDir, ids, tasks),
    tasks,
    splitsHash: splitsHash(i.benchDir, i.tasks),
    graderSetHash: graderSetHash(i.benchDir, ids),
    depsHash: depsHash(i),
    harness: {
      runnerVersion: i.runnerVersion ?? RUNNER_VERSION,
      imageDigest: i.imageDigest,
      limits: { ...i.limits },
    },
    agent: { vendor: i.agent.vendor, version: i.agent.version },
    models: [...i.models],
    skillSetHash: skillSetHashOf(i.skillsDir),
    mode: i.mode,
    wikiSnapshotHash: i.mode === 'isolation' ? null : (i.wikiSnapshotHash ?? null),
    proxyPolicyHash: i.proxyPolicyHash ?? null,
  });
}

/** True when two identities are equal in every field (the train-cache rule, 06 §1.5). */
export function sameIdentity(a: BaselineIdentity, b: BaselineIdentity): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
