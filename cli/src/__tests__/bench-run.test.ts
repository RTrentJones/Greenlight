import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type BenchRunOptions,
  type DailyUsage,
  type QuotaStore,
  RawRecordSchema,
  type RunnerAssets,
  dockerAvailable,
  ensureRunnerImage,
  findSecrets,
  gradeRollout,
  loadTasks,
  materialize,
  pacificDay,
  parseLedger,
  parseTrajectory,
  runBench,
} from '@rtrentjones/greenlight-wiki';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBenchAssets } from '../bench-assets';
import { benchCommand } from '../commands/bench';

/**
 * End-to-end bench rollouts with a scripted fake model (no live LLM): the process sandbox always,
 * the docker sandbox when a daemon is available. Covers the 13 §2.7 rollout-isolation and
 * trajectory cases, resume after a deferral, budget refusal, the redaction refusal and the train
 * cache (13 §2.7 baseline invalidation is covered at the identity level in identity.test.ts).
 */

const REPO = resolve(__dirname, '../../..');
const BENCH = join(REPO, 'bench');
const LOOP = 'loop/fixture-preview-before-push-train';
const SMALL = 'gemini-3.6-flash';
const FRONTIER = 'gemini-3.8-flash';
const DOCKER = dockerAvailable();
/** On CI the isolation suite is not optional: without docker it FAILS (below) instead of passing
 * with its docker cases skipped. Locally they are skipped with a warning. */
const ON_CI = Boolean(process.env.CI) && process.env.CI !== 'false';
if (!DOCKER)
  console.warn('bench-run.test: docker is not available; the docker sandbox cases are skipped');

describe('the docker isolation suite', () => {
  it.runIf(ON_CI)('runs on CI (docker must be available there)', () => {
    expect(
      DOCKER,
      'CI=true but `docker info` failed: the rollout isolation suite (13 §2.7) cannot run, so check-all fails rather than skipping it. Start the docker daemon on the runner.',
    ).toBe(true);
  });
});

/** Run options for "a day later": the date (ledger seeding) and the throttle's clock (the
 * limiter's day key) move 24 h ahead, with a fresh quota. */
function tomorrow(): Pick<BenchRunOptions, 'now' | 'throttle' | 'quotaStore'> {
  let clock = Date.now() + 86_400_000;
  return {
    now: () => new Date(clock),
    throttle: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    quotaStore: memoryQuota(),
  };
}

/** An in-memory daily quota (`QuotaStore`): `used` seeds today's count per model. */
function memoryQuota(used: Record<string, number> = {}): QuotaStore & {
  counts: Map<string, DailyUsage>;
} {
  const day = pacificDay(new Date());
  const counts = new Map<string, DailyUsage>(
    Object.entries(used).map(([m, count]) => [m, { day, count }]),
  );
  return {
    counts,
    load: (id) => counts.get(id) ?? null,
    save: (id, u) => {
      counts.set(id, { ...u });
    },
    raise: (id, d, count) => {
      const cur = counts.get(id);
      const next = { day: d, count: Math.max(cur && cur.day === d ? cur.count : 0, count) };
      counts.set(id, next);
      return next;
    },
  };
}

type Step = { name: string; args: Record<string, unknown> };
interface Sent {
  url: string;
  body: { contents?: { role: string; parts: Record<string, unknown>[] }[] };
}

/** A fake Gemini: `script(turn)` gives the function call for each model turn of a rollout. */
function fakeModel(script: (turn: number, sent: Sent) => Step | { status: number }): {
  fetchImpl: typeof fetch;
  sent: Sent[];
  generations: () => number;
} {
  const sent: Sent[] = [];
  let gens = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (/\/models\?/.test(u)) {
      return new Response(
        JSON.stringify({
          models: [FRONTIER, SMALL].map((id) => ({
            name: `models/${id}`,
            supportedGenerationMethods: ['generateContent'],
          })),
        }),
        { status: 200 },
      );
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const s: Sent = { url: u, body };
    sent.push(s);
    gens++;
    const model = decodeURIComponent(u.match(/models\/([^:]+):generateContent/)?.[1] ?? '');
    const turn = (body.contents ?? []).filter((c: { role: string }) => c.role === 'model').length;
    if (
      (body as { generationConfig?: { responseJsonSchema?: unknown } }).generationConfig
        ?.responseJsonSchema
    ) {
      // The eval judge: one structured-output call.
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: '{"passed":true,"rationale":"conditional on the liveness model"}' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, totalTokenCount: 55 },
          modelVersion: model,
        }),
        { status: 200 },
      );
    }
    const step = script(turn, s);
    if ('status' in step)
      return new Response('{"error":{"message":"overloaded"}}', { status: step.status });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: step.name, args: step.args } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
        modelVersion: `models/${model}`,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchImpl, sent, generations: () => gens };
}

const bash = (command: string): Step => ({ name: 'bash', args: { command } });
const finish: Step = { name: 'finish', args: { summary: 'done' } };

const NEW_SERVER = readFileSync(
  join(BENCH, 'tasks', LOOP, 'fixture/tools/guestbook/server.mjs'),
  'utf8',
).replace('Leave a note for the next visitor.', 'Thanks for stopping by. Sign below.');

const edit: Step = {
  name: 'write_file',
  args: { path: 'tools/guestbook/server.mjs', content: NEW_SERVER },
};
const goodOrder = bash(
  'git switch -q develop && greenlight preview guestbook && git add -A && git commit -qm "guestbook: copy" && git push -q origin develop',
);
const badOrder = bash(
  'git switch -q develop && git add -A && git commit -qm "guestbook: copy" && git push -q origin develop && greenlight preview guestbook',
);

/** The function responses the agent was shown, in order (what the model would read). */
function toolOutputs(sent: Sent[]): string[] {
  const last = sent.at(-1)?.body.contents ?? [];
  return last.flatMap((c) =>
    c.parts.flatMap((p) => {
      const fr = p.functionResponse as
        | { response?: { result?: string; error?: string } }
        | undefined;
      return fr ? [String(fr.response?.result ?? fr.response?.error ?? '')] : [];
    }),
  );
}

let assets: RunnerAssets;
const temps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};

beforeAll(async () => {
  assets = await buildBenchAssets(REPO);
  temps.push(resolve(assets.cliDir, '..'));
}, 120_000);
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function options(
  over: Partial<BenchRunOptions> & Pick<BenchRunOptions, 'fetchImpl' | 'sandbox'>,
): BenchRunOptions {
  const root = tmp('greenlight-bench-run-');
  let clock = Date.now();
  return {
    // The 5 rpm free-tier throttle on a fake clock, so a 12-turn rollout does not wait minutes.
    throttle: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    repoRoot: REPO,
    benchDir: BENCH,
    skillsDir: join(REPO, '.claude', 'skills'),
    wikiRoot: join(root, 'wiki'),
    stateDir: join(root, '.greenlight'),
    tasks: [LOOP],
    models: ['small'],
    assets,
    env: {},
    retryDelaysMs: [0, 0],
    sleep: async () => {},
    rolloutTimeoutMs: 120_000,
    // A fresh day's quota per call (20 RPD per model, bench/models.json).
    quotaStore: memoryQuota(),
    ...over,
  };
}

function rawRecords(o: BenchRunOptions) {
  const dir = join(o.stateDir as string, 'raw');
  return existsSync(dir)
    ? readdirSync(dir).map((f) =>
        RawRecordSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))),
      )
    : [];
}

function trajectoryOf(o: BenchRunOptions, evaluationId: string, rawId: string) {
  const f = join(o.stateDir as string, 'bench', 'runs', evaluationId, rawId, 'trajectory.jsonl');
  return parseTrajectory(readFileSync(f, 'utf8'));
}

describe.each([
  ['process', true],
  ['docker', DOCKER],
] as const)('bench run through the %s sandbox', (sandbox, enabled) => {
  const maybe = enabled ? it : it.skip;

  maybe(
    'a full rollout: raw record, trajectory, sealed train record, spend event; then the cache',
    async () => {
      const m = fakeModel((t) => [edit, goodOrder, finish][t] ?? finish);
      const o = options({ fetchImpl: m.fetchImpl, sandbox });
      const r = await runBench(o);
      expect(r.status, r.message).toBe('complete');
      expect(r.record?.role).toBe('train');
      expect(r.record?.identity.harness.imageDigest).toEqual(
        sandbox === 'process' ? 'process' : expect.stringMatching(/^ctx:sha256:[0-9a-f]{64}$/),
      );
      expect(r.record?.identity.harness.limits).toEqual({
        maxSteps: 15,
        requestsPerRollout: 17,
        timeoutMin: 2,
      });
      const [outcome] = r.record?.outcomes ?? [];
      expect(outcome).toMatchObject({
        task: LOOP,
        model: SMALL,
        run: 1,
        score: 1,
        servedBy: SMALL,
      });
      expect(outcome?.graders).toEqual([
        expect.objectContaining({ kind: 'trajectory', passed: true }),
      ]);
      expect(existsSync(r.recordPath as string)).toBe(true);

      const [raw] = rawRecords(o);
      expect(raw).toMatchObject({
        kind: 'bench',
        env: 'bench',
        passed: true,
        agent: { vendor: 'greenlight-harness', model: SMALL, servedBy: `models/${SMALL}` },
        bench: { task: LOOP, split: 'train', model: SMALL, mode: 'isolation', run: 1 },
      });
      expect(raw?.bench?.skillSetHash).toBe(r.identity?.skillSetHash);
      expect(raw?.bench?.evaluationId).toBe(r.evaluationId);
      expect(raw?.skills.used).toHaveProperty('deploy-verify-promote');

      const traj = trajectoryOf(o, r.evaluationId as string, raw?.rawId as string);
      expect(traj.errors).toEqual([]);
      expect(traj.events.map((e) => e.seq)).toEqual(traj.events.map((_, i) => i));
      const push = traj.events.find((e) => e.meta?.subcommand === 'push');
      expect(push?.meta).toMatchObject({ dstRef: 'develop', pushed: 'true', remote: 'origin' });
      const preview = traj.events.find((e) => e.meta?.subcommand === 'preview');
      expect(preview?.meta).toMatchObject({ tool: 'guestbook', passed: 'true' });
      expect(preview && push && preview.seq < push.seq).toBe(true);

      const ledger = parseLedger(readFileSync(join(o.wikiRoot, 'ledger.jsonl'), 'utf8')).events;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.spend).toMatchObject({ model: SMALL, rollouts: 1, requests: 3 });

      // Unchanged identity: the cached record is reused with no request at all.
      const before = m.generations();
      const again = await runBench({ ...o, fetchImpl: m.fetchImpl });
      expect(again.status).toBe('cached');
      expect(again.record?.hash).toBe(r.record?.hash);
      expect(m.generations()).toBe(before);
    },
    300_000,
  );

  maybe(
    'byte-identical apps, different push/preview order: the trajectory grader tells them apart',
    async () => {
      const good = await runBench(
        options({
          fetchImpl: fakeModel((t) => [edit, goodOrder, finish][t] ?? finish).fetchImpl,
          sandbox,
        }),
      );
      const bad = await runBench(
        options({
          fetchImpl: fakeModel((t) => [edit, badOrder, finish][t] ?? finish).fetchImpl,
          sandbox,
        }),
      );
      expect(good.record?.outcomes[0]?.score).toBe(1);
      expect(bad.record?.outcomes[0]?.score).toBe(0);
      expect(bad.record?.outcomes[0]?.graders[0]?.detail).toMatch(/before\(greenlight/);
    },
    300_000,
  );
});

describe('effective git config reaches the shim context', () => {
  it('-c options and GIT_CONFIG_* aliases resolve to the push they run', async () => {
    const steps = [
      edit,
      bash('git switch -q develop && git add -A && git commit -qm copy'),
      bash('git -c alias.ship="push origin develop" ship'),
      bash(
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.pd GIT_CONFIG_VALUE_0="push origin develop" git pd',
      ),
      finish,
    ];
    const m = fakeModel((t) => steps[t] ?? finish);
    const o = options({ fetchImpl: m.fetchImpl, sandbox: 'process' });
    const r = await runBench(o);
    expect(r.status, r.message).toBe('complete');
    const traj = trajectoryOf(o, r.evaluationId as string, r.rollouts[0]?.rawId as string);
    const pushes = traj.events.filter(
      (e) => e.source === 'shim' && (e.argv.includes('ship') || e.argv.includes('pd')),
    );
    expect(pushes.map((e) => e.meta?.subcommand)).toEqual(['push', 'push']);
    expect(pushes.map((e) => e.meta?.dstRef)).toEqual(['develop', 'develop']);
    // The first push moved develop; the second found nothing to push.
    expect(pushes.map((e) => e.meta?.pushed)).toEqual(['true', 'false']);
  }, 120_000);
});

describe('rollout isolation (13 §2.7)', () => {
  const maybe = DOCKER ? it : it.skip;

  maybe.each([
    'replay/idle-probe-leaves-store-asleep-val',
    'replay/keepalive-probe-reaches-store-train',
  ])(
    'the grading container runs the %s app grader (agent app as another uid, fake clock): reference passes, fixture fails',
    async (taskId) => {
      const image = ensureRunnerImage(join(BENCH, 'runner'));
      const task = loadTasks(BENCH).tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`no task ${taskId}`);
      const verdicts: string[] = [];
      for (const layers of [[join(BENCH, 'references', taskId)], []]) {
        const work = tmp('greenlight-grade-');
        const job = materialize(BENCH, task, layers, work);
        const run = await gradeRollout(
          { taskId, benchDir: BENCH, tree: job.tree },
          { gradeBundle: assets.gradeBundle, docker: { image }, timeoutMs: 120_000 },
        );
        verdicts.push(`${run.verdict}${run.error ? `: ${run.error}` : ''}`);
      }
      expect(verdicts).toEqual(['pass', 'fail']);
    },
    300_000,
  );

  maybe(
    'a maintainer baseline is graded in the container with the eval judge answered by the host',
    async () => {
      const WIKI = 'wiki/probe-layer-incidents-val';
      const output = readFileSync(join(BENCH, 'references', WIKI, 'output.json'), 'utf8');
      const steps: Step[] = [
        { name: 'read_file', args: { path: 'wiki/index.md' } },
        { name: 'finish', args: { output } },
      ];
      const m = fakeModel((t) => steps[t] ?? (steps[1] as Step));
      const r = await runBench(
        options({
          fetchImpl: m.fetchImpl,
          sandbox: 'docker',
          split: 'val',
          tasks: [WIKI],
          models: ['frontier'],
          runs: 1,
        }),
      );
      expect(r.status, `${r.message} ${JSON.stringify(r.rollouts)}`).toBe('complete');
      expect(r.record?.role).toBe('baseline');
      expect(r.record?.outcomes[0]).toMatchObject({ task: WIKI, score: 1 });
      const judged = m.sent.filter(
        (s) =>
          (s.body as { generationConfig?: { responseJsonSchema?: unknown } }).generationConfig
            ?.responseJsonSchema,
      );
      expect(judged).toHaveLength(1);
      expect(judged[0]?.url).toContain(SMALL); // models.json: judge → small
      expect(r.record?.outcomes[0]?.cost.requests).toBe(3); // two agent turns + one judge call
      // m1: the judge's call is spent on the judge model, in a spend event of its own.
      const ledger = parseLedger(
        readFileSync(join(r.recordPath as string, '../../../ledger.jsonl'), 'utf8'),
      ).events;
      expect(ledger.map((e) => [e.spend?.model, e.spend?.rollouts, e.spend?.requests])).toEqual([
        [FRONTIER, 1, 2],
        [SMALL, 0, 1],
      ]);
    },
    300_000,
  );

  maybe(
    'a baseline runs with the fallback disabled: an unavailable model defers, never falls back',
    async () => {
      const m = fakeModel(() => ({ status: 503 }));
      const r = await runBench(
        options({
          fetchImpl: m.fetchImpl,
          sandbox: 'docker',
          split: 'val',
          tasks: ['loop/*'],
          models: ['frontier'],
          runs: 1,
        }),
      );
      expect(r.status, r.message).toBe('deferred');
      expect(m.sent.length).toBe(3); // the primary and its two retries
      for (const s of m.sent) expect(s.url).toContain(FRONTIER);
      expect(r.rollouts[0]?.reason).toMatch(/fallback disabled/);
    },
    300_000,
  );

  maybe(
    'the agent cannot read graders, the host bench path, or ancestors; cannot reach the shim socket; its leftover process is killed before grading',
    async () => {
      const probes = [
        'ls /',
        'cat /bench/graders/loop/fixture-preview-before-push-train/grade.mjs',
        `ls ${BENCH}/graders ${BENCH}/references ${BENCH}/mutants`,
        `find / \\( -path /proc -o -path /sys \\) -prune -o \\( -name grade.mjs -o -name 'fake-clock-shim.mjs' -o -name trajectory.jsonl \\) -print 2>/dev/null; echo searched`,
        'cat /proc/1/environ | tr "\\0" "\\n"; env | grep -ci gemini',
        `node -e 'require("net").createConnection("/run/greenlight-shim/shim.sock").on("error",e=>console.log("connect:",e.code)).on("connect",()=>console.log("CONNECTED"))'`,
        'ls -la /run/greenlight-shim/; echo forged > /run/greenlight-shim/x; echo w=$?',
        'grep -c graders /proc/self/mountinfo; ls /opt/real/greenlight',
        // M1: the real binaries behind the shims run only through the recorder.
        '/usr/bin/git --version; echo git=$?; /usr/bin/curl --version; echo curl=$?; node /opt/real/greenlight/greenlight.mjs --help; echo gl=$?; ls /usr/libexec/git-core; echo core=$?',
        // M2: the recorder refuses an invocation the shim would not make.
        'doas -n -u shim /opt/runner/record rm /work; echo rec=$?; doas -n -u root /opt/runner/run-real /bin/id; echo root=$?',
        // M3: an in-flight recorder (shim uid) whose command would change the tree after finish.
        `nohup git -c alias.later='!sleep 3; echo tampered > tools/guestbook/server.mjs' later >/dev/null 2>&1 & echo started`,
        '(sleep 2; echo tampered > tools/guestbook/server.mjs) >/dev/null 2>&1 & echo started',
      ];
      const steps: Step[] = [edit, goodOrder, ...probes.map(bash), finish];
      const m = fakeModel((t) => steps[t] ?? finish);
      // 15 steps: cap 17 ≤ the day's 20 requests.
      const o = options({ fetchImpl: m.fetchImpl, sandbox: 'docker', maxSteps: 15 });
      const r = await runBench(o);
      expect(r.status, `${r.message} ${JSON.stringify(r.rollouts)}`).toBe('complete');
      const out = toolOutputs(m.sent);
      const probe = (i: number) => out[2 + i] as string;
      expect(probe(0)).not.toMatch(/\bbench\b/);
      expect(probe(1)).toMatch(/No such file/);
      expect(probe(2)).toMatch(/No such file/);
      expect(probe(3)).toMatch(/^exit=0\nsearched$/);
      // PID 1 and every ancestor of agent code in the container's PID namespace carry only the
      // image's environment: no key, token or secret (the model key stays in the host process).
      expect(probe(4)).toMatch(/GREENLIGHT_WIKI=off/);
      expect(probe(4)).not.toMatch(/GEMINI|_KEY=|TOKEN|SECRET|PROXY/i);
      expect(probe(4)).toMatch(/\n0$/);
      expect(probe(5)).toMatch(/connect: EACCES/);
      expect(probe(6)).toMatch(/w=[1-9]/);
      expect(probe(7)).toMatch(/^exit=\d+\n0\n/);
      expect(probe(7)).toMatch(/Permission denied/);
      expect(probe(8)).toMatch(/git=126/);
      expect(probe(8)).toMatch(/curl=126/);
      expect(probe(8)).toMatch(/EACCES|permission denied/i);
      expect(probe(8)).toMatch(/core=1/);
      expect(probe(9)).toMatch(
        /refusing an invocation the shim did not make: unknown command "rm"/,
      );
      expect(probe(9)).toMatch(/rec=126/);
      expect(probe(9)).toMatch(/root=1/);
      // Both background processes (one of them an in-flight recorder of the shim uid) were
      // killed before anything was read out.
      expect(r.rollouts[0]?.killedProcesses).toBeGreaterThanOrEqual(2);
      await new Promise((res) => setTimeout(res, 3000));
      const tree = join(
        o.stateDir as string,
        'bench',
        'runs',
        r.evaluationId as string,
        r.rollouts[0]?.rawId as string,
        'tree',
      );
      expect(readFileSync(join(tree, 'tools/guestbook/server.mjs'), 'utf8')).toBe(NEW_SERVER);
      // The trajectory has the probes' bash calls but no forged event.
      const traj = trajectoryOf(o, r.evaluationId as string, r.rollouts[0]?.rawId as string);
      expect(traj.events.filter((e) => e.source === 'shim').map((e) => e.cmd)).not.toContain(
        'forged',
      );
      expect(r.record?.outcomes[0]?.score).toBe(1);
    },
    300_000,
  );

  it('the process sandbox kills its leftover processes before grading', async () => {
    const marker = join(tmp('greenlight-marker-'), 'touched');
    const steps = [bash(`(sleep 2; touch ${marker}) >/dev/null 2>&1 & echo started`), finish];
    const m = fakeModel((t) => steps[t] ?? finish);
    const r = await runBench(options({ fetchImpl: m.fetchImpl, sandbox: 'process' }));
    expect(r.status, r.message).toBe('complete');
    expect(r.rollouts[0]?.killedProcesses).toBeGreaterThanOrEqual(1);
    await new Promise((res) => setTimeout(res, 3000));
    expect(existsSync(marker)).toBe(false);
    expect(r.record?.outcomes[0]?.score).toBe(0); // never pushed
  }, 120_000);

  it('refuses the process sandbox for a baseline evaluation', async () => {
    const m = fakeModel(() => finish);
    const r = await runBench(
      options({ fetchImpl: m.fetchImpl, sandbox: 'process', split: 'val', tasks: ['loop/*'] }),
    );
    expect(r.status).toBe('policy-refused');
    expect(m.generations()).toBe(0);
  });
});

describe('budget, deferral, redaction', () => {
  it('refuses before any request when the budget would be exceeded', async () => {
    const bench = tmp('greenlight-bench-copy-');
    cpSync(BENCH, bench, { recursive: true });
    writeFileSync(
      join(bench, 'budget.json'),
      JSON.stringify({
        monthlyUsd: 0,
        perGateMaxUsd: 0,
        perGateMaxRollouts: 1,
        perGateMaxRequests: 600,
        splitAcrossDays: true,
      }),
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('no request may be made');
    }) as unknown as typeof fetch;
    const r = await runBench(
      options({ fetchImpl, sandbox: 'process', benchDir: bench, models: ['frontier', 'small'] }),
    );
    expect(r.status).toBe('budget-refused');
    expect(r.message).toMatch(/per-gate-rollouts \(expected 2 > 1\)/);
    expect(calls).toBe(0);
  });

  it('defers on an unavailable model with fallback off, then resumes under the same identity', async () => {
    const bench = tmp('greenlight-bench-copy-');
    cpSync(BENCH, bench, { recursive: true });
    let down = true;
    const m = fakeModel((t) => (down ? { status: 503 } : ([edit, goodOrder, finish][t] ?? finish)));
    // A val baseline in docker would need docker; the deferral path is the same for train with
    // the frontier model's fallback disabled, so exercise it on the small model (no fallback).
    const o = options({ fetchImpl: m.fetchImpl, sandbox: 'process', benchDir: bench, runs: 2 });
    const first = await runBench(o);
    expect(first.status).toBe('deferred');
    expect(first.message).toMatch(/--resume eval-/);
    const progress = JSON.parse(
      readFileSync(
        join(o.stateDir as string, 'bench', 'runs', first.evaluationId as string, 'progress.json'),
        'utf8',
      ),
    );
    expect(progress.status).toBe('deferred');
    expect(progress.outcomes).toHaveLength(0);
    // The model's deferral stops only that model: the second run was never attempted.
    expect(m.sent).toHaveLength(3);
    expect(first.remaining).toEqual({ [SMALL]: [`${LOOP}|${SMALL}|1`, `${LOOP}|${SMALL}|2`] });
    expect(first.deferredModels?.[SMALL]).toMatch(/^deferred: /);
    // m3: a deferred rollout is not evidence: no raw record.
    expect(rawRecords(o)).toHaveLength(0);
    expect(progress.rawIds).toEqual([]);

    // Another day (a fresh quota): the model is back.
    down = false;
    const resumed = await runBench({ ...o, ...tomorrow(), resume: first.evaluationId });
    expect(resumed.status, resumed.message).toBe('complete');
    expect(resumed.evaluationId).toBe(first.evaluationId);
    expect(resumed.record?.outcomes.map((x) => x.run)).toEqual([1, 2]);
    expect(resumed.record?.identity).toEqual(first.identity);

    // A changed input refuses the resume of an unfinished evaluation.
    const again = await runBench({
      ...o,
      quotaStore: memoryQuota(),
      fetchImpl: fakeModel(() => ({ status: 503 })).fetchImpl,
      force: true,
    });
    expect(again.status).toBe('deferred');
    // M5: so do changed limits; unset limits on resume are the evaluation's own.
    const steps = await runBench({ ...o, resume: again.evaluationId, maxSteps: 20 });
    expect(steps.status).toBe('policy-refused');
    expect(steps.message).toMatch(/harness.*rollout limits .*"maxSteps":15.*"maxSteps":20/);
    const cap = await runBench({ ...o, resume: again.evaluationId, rolloutRequestCap: 30 });
    expect(cap.status).toBe('policy-refused');
    writeFileSync(join(bench, 'tasks', LOOP, 'brief.md'), 'A different brief.\n');
    const refused = await runBench({ ...o, resume: again.evaluationId });
    expect(refused.status).toBe('policy-refused');
    expect(refused.message).toMatch(/taskSetHash/);
  }, 300_000);

  it('M5: a cached train run is reused only under the same limits', async () => {
    const m = fakeModel((t) => [edit, goodOrder, finish][t] ?? finish);
    const o = options({ fetchImpl: m.fetchImpl, sandbox: 'process' });
    const r = await runBench(o);
    expect(r.status, r.message).toBe('complete');
    expect((await runBench({ ...o, quotaStore: memoryQuota() })).status).toBe('cached');
    const more = await runBench({ ...o, quotaStore: memoryQuota(), maxSteps: 12 });
    expect(more.status, more.message).toBe('complete');
    expect(more.record?.identity.harness.limits).toMatchObject({
      maxSteps: 12,
      requestsPerRollout: 14,
    });
    expect(more.record?.hash).not.toBe(r.record?.hash);
  }, 120_000);
});

describe('quota scheduling across models (M4)', () => {
  /** Both models on the loop task; `down` models answer 503. */
  const twoModels = (down: Set<string>) =>
    fakeModel((t, s) => {
      if ([...down].some((d) => s.url.includes(`models/${d}:`))) return { status: 503 };
      return [edit, goodOrder, finish][t] ?? finish;
    });
  const modelOfUrl = (u: string) => (u.includes(FRONTIER) ? 'F' : 'S');

  it('skips a model whose quota left is below the request cap and keeps running the other', async () => {
    const m = twoModels(new Set());
    const quota = memoryQuota({ [FRONTIER]: 16 }); // 4 left < 17
    const o = options({
      fetchImpl: m.fetchImpl,
      sandbox: 'process',
      models: ['frontier', 'small'],
      quotaStore: quota,
    });
    const r = await runBench(o);
    expect(r.status, r.message).toBe('deferred');
    expect(m.sent.every((s) => s.url.includes(SMALL))).toBe(true); // not one frontier request
    expect(r.remaining).toEqual({ [FRONTIER]: [`${LOOP}|${FRONTIER}|1`] });
    expect(r.deferredModels?.[FRONTIER]).toMatch(
      /daily quota: gemini-3.8-flash has 4 request\(s\) left today and a rollout may need 17/,
    );
    expect(r.rollouts.map((x) => [x.model, x.status])).toEqual([[SMALL, 'graded']]);
    // Tomorrow: resume runs only the frontier rollout.
    const next = await runBench({ ...o, ...tomorrow(), resume: r.evaluationId });
    expect(next.status, next.message).toBe('complete');
    expect(next.rollouts.map((x) => x.model)).toEqual([FRONTIER]);
    expect(next.record?.outcomes).toHaveLength(2);
  }, 180_000);

  it('interleaves the models by quota left', async () => {
    const m = twoModels(new Set());
    const r = await runBench(
      options({
        fetchImpl: m.fetchImpl,
        sandbox: 'process',
        models: ['frontier', 'small'],
        runs: 2,
        maxSteps: 3, // cap 5: four rollouts of 3 requests fit in 20 RPD
        quotaStore: memoryQuota({ [SMALL]: 2 }),
      }),
    );
    expect(r.status, r.message).toBe('complete');
    // 20 vs 18 left → frontier; 17 vs 18 → small; 17 vs 15 → frontier; then small.
    expect(r.rollouts.map((x) => x.model)).toEqual([FRONTIER, SMALL, FRONTIER, SMALL]);
    const order = m.sent.map((s) => modelOfUrl(s.url)).join('');
    expect(order).toBe('FFFSSSFFFSSS');
  }, 180_000);

  it('a deferral defers only its model (m2: a train rollout never falls back); the other model completes', async () => {
    const m = twoModels(new Set([FRONTIER]));
    const o = options({
      fetchImpl: m.fetchImpl,
      sandbox: 'process',
      models: ['frontier', 'small'],
      runs: 2,
      maxSteps: 4,
    });
    const r = await runBench(o);
    expect(r.status, r.message).toBe('deferred');
    // The frontier model's three attempts (primary + two retries), never its fallback (small).
    const frontierCalls = m.sent.filter((s) => s.url.includes(FRONTIER));
    expect(frontierCalls).toHaveLength(3);
    expect(m.sent.filter((s) => s.url.includes(SMALL))).toHaveLength(6); // both small rollouts
    expect(r.remaining).toEqual({
      [FRONTIER]: [`${LOOP}|${FRONTIER}|1`, `${LOOP}|${FRONTIER}|2`],
    });
    expect(r.rollouts.map((x) => [x.model, x.status])).toEqual([
      [FRONTIER, 'deferred'],
      [SMALL, 'graded'],
      [SMALL, 'graded'],
    ]);
    expect(r.message).toMatch(/gemini-3.8-flash: 2 rollout\(s\) left \(deferred: /);
    // The deferred requests still count against the frontier model's day.
    const ledger = parseLedger(readFileSync(join(o.wikiRoot, 'ledger.jsonl'), 'utf8')).events;
    expect(ledger.map((e) => [e.spend?.model, e.spend?.requests])).toEqual([
      [FRONTIER, 3],
      [SMALL, 6],
    ]);
  }, 180_000);
});

describe('trajectory completeness and harness errors', () => {
  it.each([
    ['process', true],
    ['docker', DOCKER],
  ] as const)(
    'M1 (%s): an origin ref moved with no recorded command makes the outcome invalid, never a pass',
    async (sandbox, enabled) => {
      if (!enabled) return;
      // A recorded preview and push, then main moved by writing the bare origin directly.
      const steps = [
        edit,
        goodOrder,
        bash('o=$(git remote get-url origin) && cp "$o/refs/heads/develop" "$o/refs/heads/main"'),
        finish,
      ];
      const m = fakeModel((t) => steps[t] ?? finish);
      const o = options({ fetchImpl: m.fetchImpl, sandbox });
      const r = await runBench(o);
      expect(r.status, r.message).toBe('complete');
      const [outcome] = r.record?.outcomes ?? [];
      expect(outcome?.score).toBe(0);
      expect(outcome?.graderError).toMatch(
        /^trajectory-incomplete: origin ref\(s\) moved with no recorded command: refs\/heads\/main$/,
      );
      const [raw] = rawRecords(o);
      expect(raw?.passed).toBe(false);
      expect(raw?.retained.verdict).toBe('unknown');
    },
    300_000,
  );

  it.each([
    ['process', true],
    ['docker', DOCKER],
  ] as const)(
    'm3 (%s): a FIFO in the final tree is a harness error: no outcome, raw verdict unknown',
    async (sandbox, enabled) => {
      if (!enabled) return;
      const steps = [bash('mkfifo pipe && echo made'), finish];
      const m = fakeModel((t) => steps[t] ?? finish);
      const o = options({ fetchImpl: m.fetchImpl, sandbox });
      const r = await runBench(o);
      expect(r.status, r.message).toBe('incomplete');
      expect(r.rollouts[0]?.status).toBe('error');
      expect(r.rollouts[0]?.reason).toMatch(/^harness: /);
      const [raw] = rawRecords(o);
      expect(raw?.retained.verdict).toBe('unknown');
      expect(raw?.passed).toBe(false);
    },
    300_000,
  );

  it('m4: a deep TMPDIR does not overflow the shim socket path', async () => {
    const deep = join(tmp('greenlight-deep-'), 'x'.repeat(60), 'y'.repeat(60));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(deep, { recursive: true });
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = deep;
    try {
      const m = fakeModel((t) => [edit, goodOrder, finish][t] ?? finish);
      const r = await runBench(options({ fetchImpl: m.fetchImpl, sandbox: 'process' }));
      expect(r.status, r.message).toBe('complete');
      expect(r.record?.outcomes[0]?.score).toBe(1);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
      else process.env.TMPDIR = saved;
    }
  }, 120_000);

  it('a secret in a tool output refuses the rollout as redaction_refused; nothing flagged is sent or stored', async () => {
    const bench = tmp('greenlight-bench-copy-');
    cpSync(BENCH, bench, { recursive: true });
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    writeFileSync(join(bench, 'tasks', LOOP, 'fixture', 'notes.txt'), `deploy token: ${secret}\n`);
    const m = fakeModel(
      (t) => [{ name: 'read_file', args: { path: 'notes.txt' } }, finish][t] ?? finish,
    );
    const o = options({ fetchImpl: m.fetchImpl, sandbox: 'process', benchDir: bench });
    const r = await runBench(o);
    expect(r.status).toBe('refused');
    expect(r.rollouts[0]?.reason).toMatch(/^redaction_refused/);
    expect(m.sent).toHaveLength(1); // the read happened; the request carrying its result was never sent
    for (const s of m.sent) expect(JSON.stringify(s.body)).not.toContain(secret);
    const raws = rawRecords(o);
    expect(raws).toHaveLength(1);
    const text = JSON.stringify(raws[0]);
    expect(text).not.toContain(secret);
    expect(findSecrets(text)).toEqual([]);
    const runDir = join(
      o.stateDir as string,
      'bench',
      'runs',
      r.evaluationId as string,
      raws[0]?.rawId as string,
    );
    expect(readFileSync(join(runDir, 'transcript.json'), 'utf8')).not.toContain(secret);
    expect(existsSync(join(o.wikiRoot, 'evidence'))).toBe(false); // not sealed
  }, 120_000);
});

describe('greenlight bench (CLI)', () => {
  const io = (cwd: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        cwd,
        env: {},
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
        assets: async () => assets,
      },
    };
  };

  it('usage and flag errors exit 2', async () => {
    const x = io(REPO);
    expect(await benchCommand([], x.io)).toBe(2);
    expect(await benchCommand(['run', '--nope'], x.io)).toBe(2);
    expect(await benchCommand(['gate'], x.io)).toBe(2);
  });

  it('run --sandbox process --json prints one JSON document', async () => {
    const root = tmp('greenlight-bench-cli-');
    cpSync(BENCH, join(root, 'bench'), { recursive: true });
    cpSync(join(REPO, '.claude', 'skills'), join(root, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), readFileSync(join(REPO, 'pnpm-lock.yaml')));
    const x = io(root);
    const m = fakeModel((t) => [edit, goodOrder, finish][t] ?? finish);
    const code = await benchCommand(
      ['run', '--sandbox', 'process', '--tasks', LOOP, '--models', 'small', '--json'],
      { ...x.io, fetchImpl: m.fetchImpl },
    );
    expect(code, x.err.join('\n')).toBe(0);
    const doc = JSON.parse(x.out.join(''));
    expect(doc).toMatchObject({ status: 'complete', requests: 3 });
    expect(await benchCommand(['activate', LOOP], x.io)).toBe(1); // no baseline yet
    expect(x.err.join('\n')).toMatch(/no recorded baseline/);
  }, 180_000);

  it('models --check reports each configured model', async () => {
    const x = io(REPO);
    const m = fakeModel(() => finish);
    expect(await benchCommand(['models', '--check'], { ...x.io, fetchImpl: m.fetchImpl })).toBe(0);
    expect(x.err.join('\n')).toMatch(/✔ gemini-3.6-flash/);
  });
});
