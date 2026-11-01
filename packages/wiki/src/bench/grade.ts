import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GraderRun, runInChild } from './check-graders';
import {
  GRADER_CHILD_FLAG,
  GraderCheckSchema,
  type GraderJob,
  graderChildMain,
} from './grader-api';
import { AGENT_UID, type RunnerImage } from './sandbox';

/**
 * Grading a finished rollout (vision 06 §4.2 step 3). By the time this runs the rollout's sandbox
 * is gone (its processes killed, its container removed); grading sees only the exported final tree
 * and the host-written trajectory.
 *
 * **docker**: a separate grading container from the runner image, `--network none`, read-only
 * root, `no-new-privileges`, with read-only mounts of the final tree, the trajectory, the grading
 * bundle (`/opt/grade`), and a STAGED subset of `bench/` (`tasks/<id>/task.json`,
 * `graders/<id>/`, `graders/_lib/`, `fixtures/`). The grader runs as root inside it with only
 * DAC_OVERRIDE/SETUID/SETGID/KILL; every child that runs agent code runs as the agent uid
 * (`GraderJob.appUid`). The staged task, grader and fixture files are mode 0600/0700, so the
 * agent's app cannot read them; `graders/_lib/` stays readable because the app-side helpers
 * (fake-clock shim, worker host) are preloaded into the app from it. The verdict is the grader
 * child's IPC message to the in-container driver, which prints it as the container's only stdout.
 *
 * **process** (local development only): the same driver runs as a host child process with a
 * scrubbed environment (check-graders' `runInChild`). Agent app code then runs as the host user.
 */

export interface GradeJob {
  taskId: string;
  benchDir: string;
  tree: string;
  trajectoryPath?: string;
  maintainerOutputPath?: string;
  bundleDir?: string;
}

export interface GradeOptions {
  /** The grading bundle (`bench-grade.mjs`): the driver, and the grader child entry. */
  gradeBundle: string;
  timeoutMs?: number;
  docker?: { image: RunnerImage; bin?: string };
}

/** The in-container (or host-child) driver: `{ job, timeoutMs }` on stdin, one JSON GraderRun on
 * stdout. Started with GRADER_CHILD_FLAG it is the grader child itself. */
export function gradeEntryMain(): void {
  if (process.argv.includes(GRADER_CHILD_FLAG)) {
    graderChildMain();
    return;
  }
  const chunks: Buffer[] = [];
  process.stdin.on('data', (b: Buffer) => chunks.push(b));
  process.stdin.on('end', () => {
    let input: { job: GraderJob; timeoutMs: number };
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      process.stdout.write(
        `${JSON.stringify({ verdict: 'error', checks: [], error: `bad job: ${String(e)}`, durationMs: 0 })}\n`,
      );
      process.exit(0);
      return;
    }
    runInChild(input.job, input.timeoutMs, { entry: process.argv[1], nodeArgs: [] }).then((run) => {
      process.stdout.write(`${JSON.stringify(run)}\n`);
      process.exit(0);
    });
  });
}

function stageBench(benchDir: string, taskId: string, dest: string): void {
  const copy = (rel: string, mode: number) => {
    const from = join(benchDir, rel);
    if (!existsSync(from)) return;
    const to = join(dest, rel);
    mkdirSync(join(to, '..'), { recursive: true });
    cpSync(from, to, { recursive: true });
    if (mode) restrict(to, mode);
  };
  copy(join('tasks', taskId, 'task.json'), 0o600);
  copy(join('graders', taskId), 0o700);
  copy(join('graders', '_lib'), 0);
  copy('fixtures', 0o700);
  for (const d of ['tasks', join('tasks', taskId), join('tasks', taskId, '..'), 'graders', '.']) {
    const p = join(dest, d);
    if (existsSync(p)) chmodSync(p, 0o755);
  }
}

/** Directories → `mode`, files → `mode` without execute bits. */
function restrict(path: string, mode: number): void {
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      chmodSync(p, mode);
      for (const n of readdirSync(p)) walk(join(p, n));
    } else chmodSync(p, mode & 0o666);
  };
  walk(path);
}

/** Grades one rollout; never throws for a grader failure (that is `verdict: 'error'`). */
export async function gradeRollout(job: GradeJob, o: GradeOptions): Promise<GraderRun> {
  const timeoutMs = o.timeoutMs ?? 300_000;
  if (!o.docker) {
    return runInChild(
      { ...job, graderPath: join(job.benchDir, 'graders', job.taskId, 'grade.mjs') },
      timeoutMs,
      { entry: o.gradeBundle, nodeArgs: [] },
    );
  }
  const docker = o.docker.bin ?? 'docker';
  const stage = mkdtempSync(join(tmpdir(), 'greenlight-grade-'));
  try {
    const bench = join(stage, 'bench');
    mkdirSync(bench);
    stageBench(job.benchDir, job.taskId, bench);
    const mounts: string[] = [
      '-v',
      `${bench}:/bench:ro`,
      '-v',
      `${job.tree}:/grade/tree:ro`,
      '-v',
      `${join(o.gradeBundle, '..')}:/opt/grade:ro`,
    ];
    const inJob: GraderJob = {
      taskId: job.taskId,
      benchDir: '/bench',
      graderPath: `/bench/graders/${job.taskId}/grade.mjs`,
      tree: '/grade/tree',
      appUid: AGENT_UID,
      appGid: AGENT_UID,
    };
    if (job.trajectoryPath) {
      mounts.push('-v', `${job.trajectoryPath}:/grade/trajectory.jsonl:ro`);
      inJob.trajectoryPath = '/grade/trajectory.jsonl';
    }
    if (job.maintainerOutputPath) {
      mounts.push('-v', `${job.maintainerOutputPath}:/grade/output.json:ro`);
      inJob.maintainerOutputPath = '/grade/output.json';
    }
    if (job.bundleDir) {
      mounts.push('-v', `${job.bundleDir}:/grade/bundle:ro`);
      inJob.bundleDir = '/grade/bundle';
    }
    const bundleName = o.gradeBundle.split('/').pop() as string;
    const args = [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--read-only',
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      ...['DAC_OVERRIDE', 'SETUID', 'SETGID', 'KILL'].flatMap((c) => ['--cap-add', c]),
      '--pids-limit',
      '512',
      '--memory',
      '2g',
      '--tmpfs',
      '/tmp:rw,exec,mode=1777,size=512m',
      '-u',
      '0',
      '-w',
      '/',
      ...mounts,
      o.docker.image.tag,
      'node',
      `/opt/grade/${bundleName}`,
    ];
    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
      const p = spawn(docker, args);
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      p.stderr.on('data', (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-4000);
      });
      const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs + 60_000);
      p.on('close', (code) => {
        clearTimeout(timer);
        res({ code: code ?? 1, stdout, stderr });
      });
      p.stdin.end(JSON.stringify({ job: inJob, timeoutMs }));
    });
    const line = out.stdout.trim().split('\n').pop() ?? '';
    try {
      const run = JSON.parse(line) as GraderRun;
      const checksOk =
        Array.isArray(run?.checks) &&
        run.checks.every((c) => GraderCheckSchema.safeParse(c).success);
      const consistent =
        run?.verdict === 'error' ||
        (checksOk &&
          (run.verdict === 'pass') ===
            (run.checks.length > 0 && run.checks.every((c) => c.passed)));
      if (['pass', 'fail', 'error'].includes(run?.verdict) && checksOk && consistent) return run;
    } catch {
      // fall through
    }
    return {
      verdict: 'error',
      checks: [],
      error: `grading container returned no result (exit ${out.code})${out.stderr ? `: ${out.stderr}` : ''}`,
      durationMs: 0,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
