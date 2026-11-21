import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '../../ledger';
import { hashTree, skillSetHashOf } from '../identity';
import { safeGit } from '../outlets';
import {
  ITERATION_STEPS,
  type IterateOptions,
  IterationError,
  type IterationPins,
  type IterationState,
  type IterationStep,
} from './types';

// ---- paths and persistence --------------------------------------------------------------------

export const iterationDir = (stateDir: string, id: string): string =>
  join(stateDir, 'bench', 'iterations', id);
export const iterationStatePath = (stateDir: string, id: string): string =>
  join(iterationDir(stateDir, id), 'state.json');

export const ITERATION_ID_RE = /^iter-[A-Za-z0-9._-]{1,100}$/;

const StateHeaderSchema = z
  .object({
    v: z.literal(1),
    iterationId: z.string().regex(ITERATION_ID_RE),
    status: z.enum(['running', 'deferred', 'blocked', 'failed', 'complete', 'awaiting-agent']),
    step: z.enum(ITERATION_STEPS),
    settings: z.object({ scope: z.string(), sandbox: z.enum(['docker', 'process']) }).passthrough(),
    acceptedSkillSetHash: z.string(),
  })
  .passthrough();

export function loadIterationState(stateDir: string, id: string): IterationState {
  if (!ITERATION_ID_RE.test(id)) throw new IterationError(`"${id}" is not an iteration id`, 2);
  const file = iterationStatePath(stateDir, id);
  if (!existsSync(file)) throw new IterationError(`no iteration ${id} at ${file}`, 2);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new IterationError(
      `${file} is not JSON (${(e as Error).message}); the iteration cannot be resumed from it. Restore the file, or start a new iteration`,
      3,
    );
  }
  const header = StateHeaderSchema.safeParse(json);
  if (!header.success) {
    throw new IterationError(
      `${file} is not an iteration state this version reads (${header.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}); start a new iteration`,
      3,
    );
  }
  return json as IterationState;
}

/**
 * The iterations under `stateDir` that are stopped waiting for an external agent, with the step
 * they wait at. Read-only and tolerant (an unreadable state is skipped): it backs a guard, not a
 * decision. `wiki ingest --apply` uses it to refuse writing the wiki behind an iteration's back.
 */
export function awaitingIterations(
  stateDir: string,
): { iterationId: string; step: IterationStep }[] {
  const dir = join(stateDir, 'bench', 'iterations');
  if (!existsSync(dir)) return [];
  const out: { iterationId: string; step: IterationStep }[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (!ITERATION_ID_RE.test(id) || !existsSync(iterationStatePath(stateDir, id))) continue;
    try {
      const s = loadIterationState(stateDir, id);
      if (s.status === 'awaiting-agent') out.push({ iterationId: id, step: s.step });
    } catch {
      // Not a state this version reads: nothing to guard.
    }
  }
  return out;
}

export function saveState(stateDir: string, s: IterationState, now: Date): void {
  s.updatedAt = now.toISOString();
  const file = iterationStatePath(stateDir, s.iterationId);
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A process's start time on this host (Linux `/proc/<pid>/stat` field 22, in clock ticks since
 * boot), or null where it cannot be read. With the pid it names one process: a reused pid has
 * another start time. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

interface LockHolder {
  host?: unknown;
  pid?: unknown;
  start?: unknown;
  token?: unknown;
}

/**
 * One process per iteration: `.lock` in the iteration directory, holding `{host, pid, start,
 * token}`. Taken atomically: the content is written to a private temp file first, then `link()`ed
 * to `.lock`, which fails if any lock exists, so no reader ever sees a half-written lock and two
 * takers can never both win.
 *
 * - A holder on this host is alive when its pid runs with the same start time (a reused pid is
 *   not the holder); a dead holder's lock is stale. A lock naming THIS process (same pid and
 *   start time, whatever its token) is live too: acquisition is never reentrant.
 * - A lock written on another host cannot be checked here: it is refused unless `breakLock` (the
 *   CLI's `--break-lock`) says the owner knows that run is gone.
 * - A stale or broken lock is removed compare-and-delete, under `withFileLock(<lock>.steal)`: only
 *   if `.lock` still holds exactly the content that was judged, so a lock another process has just
 *   taken is never removed. Release is compare-and-delete with the holder's own content.
 */
export function acquireLock(
  dir: string,
  log: (s: string) => void = () => {},
  o: { breakLock?: boolean } = {},
): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '.lock');
  const mine = JSON.stringify({
    host: hostname(),
    pid: process.pid,
    start: processStart(process.pid),
    token: randomBytes(12).toString('hex'),
  });
  const removeIf = (content: string) =>
    withFileLock(`${file}.steal`, () => {
      let cur: string | undefined;
      try {
        cur = readFileSync(file, 'utf8');
      } catch {
        return;
      }
      if (cur === content) rmSync(file, { force: true });
    });
  for (let i = 0; i < 3; i++) {
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, mine, { flag: 'wx' });
    try {
      linkSync(tmp, file);
      return () => removeIf(mine);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // released in between
    }
    let held: LockHolder = {};
    try {
      held = text.trim().startsWith('{')
        ? (JSON.parse(text) as LockHolder)
        : { pid: Number(text.trim()) };
    } catch {
      held = {};
    }
    const pid = Number(held.pid);
    if (typeof held.host === 'string' && held.host !== hostname()) {
      if (!o.breakLock) {
        throw new IterationError(
          `iteration is locked by process ${pid} on host ${held.host} (${file}); a lock is checked only on the host that wrote it. If that run is gone, rerun with --break-lock`,
          4,
        );
      }
      log(
        `warning: breaking the lock of process ${pid} on host ${held.host} at ${file} (--break-lock)`,
      );
      removeIf(text);
      continue;
    }
    const start = typeof held.start === 'string' ? held.start : null;
    if (pid === process.pid && (start === null || start === processStart(process.pid))) {
      // Ours or not, a lock held by this very process is live: a second acquisition in one
      // process (reentrance) is refused, never treated as a stale lock.
      throw new IterationError(
        `iteration is already locked by this process (${pid}, ${file}); a lock is never reentrant`,
        4,
      );
    }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = start === null || processStart(pid) === null || processStart(pid) === start;
      } catch {
        alive = false;
      }
    }
    if (alive) throw new IterationError(`iteration is running in process ${pid} (${file})`, 4);
    log(`removing the stale lock of process ${pid} at ${file}`);
    removeIf(text);
  }
  throw new IterationError(`cannot lock ${file}`, 1);
}

/** The full sha of `repoRoot`'s HEAD, or undefined outside a git checkout. */
export function headCommit(repoRoot: string): string | undefined {
  try {
    const out = safeGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The pins of an iteration's inputs as they are on disk now. */
export function iterationPins(benchDir: string, skillsDir: string): IterationPins {
  return {
    skillSet: skillSetHashOf(skillsDir),
    models: hashTree(join(benchDir, 'models.json')),
    gate: hashTree(join(benchDir, 'gate.json')),
    splits: hashTree(join(benchDir, 'splits.json')),
    tasks: hashTree(join(benchDir, 'tasks')),
    controls: hashTree(join(benchDir, 'controls')),
    repro: hashTree(join(benchDir, 'repro')),
  };
}

const PIN_NAMES: Record<keyof IterationPins, string> = {
  skillSet: 'the installed skill set',
  models: 'bench/models.json',
  gate: 'bench/gate.json',
  splits: 'bench/splits.json',
  tasks: 'the bench task set (bench/tasks)',
  controls: 'the control arms (bench/controls)',
  repro: 'the trusted repros (bench/repro)',
};

/** Refuses a resume whose inputs drifted from the iteration's creation. Pins fail closed: a state
 * without pins, or missing any pin, is refused (exit 4) unless `adoptPins` (`--adopt-pins`) says
 * the owner vouches that the inputs on disk now are the ones it was created against; only the
 * missing pins are adopted, and the present ones are still compared. */
export function checkPins(s: IterationState, o: IterateOptions, log: (s: string) => void): void {
  const now = iterationPins(o.benchDir, o.skillsDir);
  if (now.skillSet !== s.acceptedSkillSetHash) {
    throw new IterationError(
      `iteration ${s.iterationId} runs under the accepted skill set ${s.acceptedSkillSetHash.slice(0, 12)}, but the installed skills at ${o.skillsDir} hash to ${now.skillSet.slice(0, 12)}: restore the accepted skills, or start a new iteration`,
      4,
    );
  }
  const names = Object.keys(PIN_NAMES) as (keyof IterationPins)[];
  const held: Partial<IterationPins> = s.pins ?? {};
  const missing = names.filter((k) => typeof held[k] !== 'string' || held[k] === '');
  if (missing.length > 0) {
    if (!o.adoptPins) {
      throw new IterationError(
        `iteration ${s.iterationId} has no pin for ${missing.map((k) => PIN_NAMES[k]).join(', ')}, so its inputs cannot be shown unchanged: start a new iteration, or rerun with --adopt-pins if you vouch for the inputs on disk now`,
        4,
      );
    }
    log(
      `warning: --adopt-pins: pinning ${missing.map((k) => PIN_NAMES[k]).join(', ')} as they are on disk now`,
    );
    s.pins = { ...now, ...held } as IterationPins;
    for (const k of missing) s.pins[k] = now[k];
  }
  const pins = s.pins as IterationPins;
  const drift = (Object.keys(PIN_NAMES) as (keyof IterationPins)[]).filter(
    (k) => pins[k] !== now[k],
  );
  if (drift.length > 0) {
    throw new IterationError(
      `iteration ${s.iterationId} was created against other inputs: ${drift.map((k) => PIN_NAMES[k]).join(', ')} changed since. Restore them, or start a new iteration`,
      4,
    );
  }
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The repo's skills are read-only to an iteration: nothing it writes may land in them. */
export function assertOutsideSkills(skillsDir: string, dir: string, what: string): void {
  const real = (p: string) => {
    let cur = resolve(p);
    // Resolve the nearest existing ancestor, so a not-yet-created dir is checked too.
    const tail: string[] = [];
    while (!existsSync(cur)) {
      tail.unshift(cur.slice(resolve(cur, '..').length + 1));
      const up = resolve(cur, '..');
      if (up === cur) break;
      cur = up;
    }
    return join(existsSync(cur) ? realpathSync(cur) : cur, ...tail);
  };
  if (inside(real(skillsDir), real(dir)) || inside(real(dir), real(skillsDir))) {
    throw new IterationError(
      `refusing to write ${what} at ${dir}: it overlaps the accepted skill set ${skillsDir}, which an iteration never modifies`,
      4,
    );
  }
}
