import { spawn } from 'node:child_process';
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
  ModelsConfigSchema,
  type QuotaStore,
  RawRecordSchema,
  type RolloutManifest,
  type RunResult,
  type RunnerAssets,
  dockerAvailable,
  modelsConfigIdentity,
  pacificDay,
  parseLedger,
  parseTrajectory,
  runBench,
} from '@rtrentjones/greenlight-wiki';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBenchAssets } from '../bench-assets';
import { benchCommand } from '../commands/bench';

/**
 * External rollouts (06 §4.9): a scripted "outside agent" drives rollouts through the REAL
 * rollout client (a child process per command, exactly what a launched agent runs) against the
 * rollout server inside `runBench`. No model is called for a rollout; the eval judge of a
 * maintainer task is a fake. Process sandbox always, one docker case when a daemon is there.
 */

const REPO = resolve(__dirname, '../../..');
const BENCH = join(REPO, 'bench');
const LIVE = JSON.parse(readFileSync(join(BENCH, 'models.json'), 'utf8'));
const JUDGE: string = LIVE.roles.small.id;
const LOOP = 'loop/fixture-preview-before-push-train';
const WIKI = 'wiki/probe-layer-incidents-train';
const EXT_FRONTIER = 'outside-large';
const EXT_SMALL = 'outside-small';
const AGENT = 'test-agent/scripted-1';
const DOCKER = dockerAvailable();

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

/** A copy of the bench whose gate pair is external; the judge keeps a harness-driven entry. */
function externalBench(over: (m: typeof LIVE) => void = () => {}): string {
  const bench = join(tmp('greenlight-bench-ext-'), 'bench');
  cpSync(BENCH, bench, { recursive: true });
  const m = structuredClone(LIVE);
  m.roles.judge = { id: JUDGE, limits: LIVE.roles.small.limits };
  m.roles.frontier = { id: EXT_FRONTIER, external: true };
  m.roles.small = { id: EXT_SMALL, external: true };
  over(m);
  writeFileSync(join(bench, 'models.json'), `${JSON.stringify(m, null, 2)}\n`);
  return bench;
}

function memoryQuota(): QuotaStore & { counts: Map<string, DailyUsage> } {
  const counts = new Map<string, DailyUsage>();
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

/** Any model call fails the test: an external rollout makes none. */
const noNetwork = (async (url: string | URL) => {
  throw new Error(`unexpected request to ${String(url)}`);
}) as typeof fetch;

/** The eval judge only (one structured call), plus models.list. */
function fakeJudge(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (/\/models\?/.test(u)) {
      return new Response(
        JSON.stringify({
          models: [{ name: `models/${JUDGE}`, supportedGenerationMethods: ['generateContent'] }],
        }),
        { status: 200 },
      );
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!body.generationConfig?.responseJsonSchema)
      throw new Error('an external rollout called the model');
    calls++;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '{"passed":true,"rationale":"fine"}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, totalTokenCount: 55 },
        modelVersion: JUDGE,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

interface Ext extends BenchRunOptions {
  manifest: string;
  quotaStore: ReturnType<typeof memoryQuota>;
}

function options(over: Partial<BenchRunOptions> = {}): Ext {
  const root = tmp('greenlight-bench-ext-run-');
  return {
    repoRoot: REPO,
    benchDir: over.benchDir ?? externalBench(),
    skillsDir: join(REPO, '.claude', 'skills'),
    wikiRoot: join(root, 'wiki'),
    stateDir: join(root, '.greenlight'),
    tasks: [LOOP],
    models: ['small'],
    sandbox: 'process',
    assets,
    env: {},
    fetchImpl: noNetwork,
    rolloutTimeoutMs: 120_000,
    quotaStore: memoryQuota(),
    agent: AGENT,
    manifest: join(root, 'launch', 'manifest.json'),
    externalDir: join(root, 'launch'),
    ...over,
  } as Ext;
}

const readManifest = (file: string): RolloutManifest | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RolloutManifest;
  } catch {
    return undefined;
  }
};

async function waitFor<T>(f: () => T | undefined | false, what: string, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The manifest once rollout `key` (or any rollout) is in `state`. */
const whenState = (file: string, state: string, key?: string) =>
  waitFor(() => {
    const m = readManifest(file);
    const r = m?.rollouts.find((x) => x.state === state && (!key || x.key === key));
    return m && r ? { manifest: m, rollout: r } : undefined;
  }, `a rollout in state ${state}`);

interface Reply {
  code: number;
  out: string;
  err: string;
}

/** One command of the outside agent: the real client, as a child process. */
function client(
  m: RolloutManifest,
  handle: string,
  args: string[],
  stdin?: string,
): Promise<Reply> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [m.clientPath, handle, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The agent's working directory is NOT the repository.
      cwd: tmpdir(),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolveP({ code: code ?? -1, out, err }));
    child.stdin.end(stdin ?? '');
  });
}

const NEW_SERVER = readFileSync(
  join(BENCH, 'tasks', LOOP, 'fixture/tools/guestbook/server.mjs'),
  'utf8',
).replace('Leave a note for the next visitor.', 'Thanks for stopping by. Sign below.');
const GOOD =
  'git switch -q develop && greenlight preview guestbook && git add -A && git commit -qm "guestbook: copy" && git push -q origin develop';
const BAD =
  'git switch -q develop && git add -A && git commit -qm "guestbook: copy" && git push -q origin develop && greenlight preview guestbook';

/** The loop task, driven to its end by the scripted agent. */
async function driveLoop(o: Ext, order: string, key?: string): Promise<Reply[]> {
  const { manifest: m, rollout } = await whenState(o.manifest, 'open', key);
  const replies: Reply[] = [];
  replies.push(await client(m, rollout.handle, ['prompt']));
  replies.push(
    await client(
      m,
      rollout.handle,
      ['write_file', 'tools/guestbook/server.mjs', '--content-stdin'],
      NEW_SERVER,
    ),
  );
  replies.push(await client(m, rollout.handle, ['bash', '--command-stdin'], order));
  replies.push(await client(m, rollout.handle, ['finish', 'changed the copy and shipped to beta']));
  return replies;
}

function rawRecords(o: BenchRunOptions) {
  const dir = join(o.stateDir as string, 'raw');
  return existsSync(dir)
    ? readdirSync(dir).map((f) =>
        RawRecordSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))),
      )
    : [];
}

const artifact = (o: BenchRunOptions, r: RunResult, rawId: string, file: string) =>
  readFileSync(
    join(o.stateDir as string, 'bench', 'runs', r.evaluationId as string, rawId, file),
    'utf8',
  );

function spendEvents(o: BenchRunOptions) {
  const f = join(o.wikiRoot, 'ledger.jsonl');
  if (!existsSync(f)) return [];
  return parseLedger(readFileSync(f, 'utf8')).events.filter((e) => e.spend);
}

describe('external rollouts through the process sandbox', () => {
  it('a loop task driven to a pass: sealed, declared agent, no model call, no quota, no spend', async () => {
    const o = options();
    const run = runBench(o);
    const replies = await driveLoop(o, GOOD);
    const r = await run;
    expect(r.status, `${r.message} ${JSON.stringify(r.rollouts)}`).toBe('complete');
    expect(replies.map((x) => x.code)).toEqual([0, 0, 0, 0]);

    // The prompt: the harness's own system prompt and brief, the client rules, no repo path.
    const prompt = replies[0]?.out as string;
    expect(prompt).toContain('## Skill: deploy-verify-promote');
    expect(prompt).toContain('You are a software engineer working in a git repository');
    expect(prompt).toMatch(/Budget: you have at most 25 steps\. One step is one tool call/);
    expect(prompt).toContain('# Task');
    expect(prompt).toMatch(/Use only this client\. Do not read or write any file on this machine/);
    expect(prompt).toMatch(/One tool call per command/);
    expect(prompt).toContain(`rollout-client.mjs" gl1-`);
    expect(prompt).not.toContain('{{CLIENT}}');
    expect(prompt).not.toContain(REPO);
    expect(prompt).not.toMatch(/bench\/(references|graders|mutants)/);
    expect(replies[1]?.out).toMatch(/^wrote \d+ chars to tools\/guestbook\/server\.mjs/);
    expect(replies[2]?.out).toMatch(/^exit=0/);
    expect(replies[3]?.out).toMatch(/finish accepted/);

    // The record: same outcome shape, served by the label (declared), external identity.
    const outcome = r.record?.outcomes[0];
    expect(outcome).toMatchObject({
      task: LOOP,
      model: EXT_SMALL,
      servedBy: EXT_SMALL,
      score: 1,
      cost: { usd: 0, requests: 0, tokensIn: 0, tokensOut: 0 },
    });
    expect(r.identity?.agent).toEqual({ vendor: 'external', version: AGENT });
    expect(r.identity?.harness.limits).toMatchObject({ maxSteps: 25, externalTimeoutFactor: 3 });
    const raw = rawRecords(o);
    expect(raw).toHaveLength(1);
    expect(raw[0]?.agent).toEqual({
      vendor: 'external',
      version: AGENT,
      model: EXT_SMALL,
      servedBy: `${EXT_SMALL}@${AGENT}`,
    });
    expect(raw[0]?.passed).toBe(true);
    expect(raw[0]?.retained.excerpt).toMatch(/declared: external agent test-agent\/scripted-1/);
    expect(Object.keys(raw[0]?.skills.used ?? {})).toContain('deploy-verify-promote');

    // Nothing was requested, reserved or spent.
    expect(o.quotaStore.counts.has(EXT_SMALL)).toBe(false);
    expect(o.quotaStore.counts.has(EXT_FRONTIER)).toBe(false);
    expect([...o.quotaStore.counts.values()].every((u) => u.count === 0)).toBe(true);
    expect(spendEvents(o)).toEqual([]);
    expect(r.requests).toBe(0);

    // The manifest ends with the rollout done and the server gone.
    const m = readManifest(o.manifest) as RolloutManifest;
    expect(m.status).toBe('ended');
    expect(m.rollouts.map((x) => x.state)).toEqual(['done']);
    expect(r.manifest).toBe(o.manifest);
    const late = await client(m, m.rollouts[0]?.handle as string, ['list_dir']);
    expect(late.code).toBe(3);
    expect(late.err).toMatch(/refused: the rollout server is not reachable/);

    // The train cache works by identity; another declared agent is another identity.
    const again = await runBench({ ...o });
    expect(again.status).toBe('cached');
    const other = runBench({ ...o, agent: 'test-agent/other' });
    await driveLoop(o, GOOD);
    const r2 = await other;
    expect(r2.status).toBe('complete');
    expect(r2.identity?.agent.version).toBe('test-agent/other');
    expect(r2.record?.hash).not.toBe(r.record?.hash);
  }, 180_000);

  it('a loop task driven to a fail is graded 0 by the same grader', async () => {
    const o = options();
    const run = runBench(o);
    await driveLoop(o, BAD);
    const r = await run;
    expect(r.status, r.message).toBe('complete');
    expect(r.record?.outcomes[0]).toMatchObject({ score: 0, servedBy: EXT_SMALL });
    expect(r.record?.outcomes[0]?.graderError).toBeUndefined();
    expect(rawRecords(o)[0]?.retained.verdict).toBe('failed');
  }, 180_000);

  it('transcript, raw record and trajectory have the shape of a harness rollout', async () => {
    // The same script through the harness loop (a fake model) and through the client.
    const steps = [
      { name: 'write_file', args: { path: 'tools/guestbook/server.mjs', content: NEW_SERVER } },
      { name: 'bash', args: { command: GOOD } },
      { name: 'finish', args: { summary: 'done' } },
    ];
    const fakeModel = (async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const turn = (body.contents ?? []).filter((c: { role: string }) => c.role === 'model').length;
      const model = decodeURIComponent(String(url).match(/models\/([^:]+):/)?.[1] ?? '');
      const step = steps[turn] ?? steps[2];
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ functionCall: step }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          modelVersion: `models/${model}`,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    let clock = Date.now();
    const h = options({
      benchDir: BENCH,
      fetchImpl: fakeModel,
      agent: undefined,
      skipModelsCheck: true,
      retryDelaysMs: [0, 0],
      throttle: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    });
    const hr = await runBench(h);
    expect(hr.status, hr.message).toBe('complete');
    expect(hr.identity?.agent.vendor).toBe('greenlight-harness');

    const o = options();
    const run = runBench(o);
    await driveLoop(o, GOOD);
    const er = await run;
    expect(er.status, er.message).toBe('complete');

    const hRaw = rawRecords(h)[0];
    const eRaw = rawRecords(o)[0];
    const keys = (v: unknown) => Object.keys(v as object).sort();
    expect(keys(eRaw)).toEqual(keys(hRaw));
    expect(keys(eRaw?.agent)).toEqual(keys(hRaw?.agent));
    expect(keys(eRaw?.bench)).toEqual(keys(hRaw?.bench));
    expect(keys(eRaw?.retained)).toEqual(keys(hRaw?.retained));
    expect(keys(eRaw?.retained.hashes)).toEqual(keys(hRaw?.retained.hashes));
    expect(keys(er.record?.outcomes[0])).toEqual(keys(hr.record?.outcomes[0]));

    type Entry = { kind: string } & Record<string, unknown>;
    const transcript = (x: BenchRunOptions, r: RunResult) =>
      JSON.parse(artifact(x, r, r.rollouts[0]?.rawId as string, 'transcript.json')) as Entry[];
    const ht = transcript(h, hr);
    const et = transcript(o, er);
    expect(et.map((e) => e.kind)).toEqual(ht.map((e) => e.kind));
    expect(et.map((e) => keys(e))).toEqual(ht.map((e) => keys(e)));
    const calls = (t: Entry[]) =>
      t.filter((e) => e.kind === 'tool_call').map((e) => [e.step, e.name, keys(e.args)]);
    expect(calls(et)).toEqual(calls(ht));
    // The recorded system prompt is the harness's, with the budget in the agent's terms and the
    // client protocol appended; the client's own path is not in it.
    expect(String(et[0]?.text)).toContain('## Skill: deploy-verify-promote');
    expect(String(et[0]?.text)).toContain('{{CLIENT}} bash');
    expect(String(et[0]?.text)).not.toContain('rollout-client.mjs');

    const traj = (x: BenchRunOptions, r: RunResult) =>
      parseTrajectory(
        artifact(x, r, r.rollouts[0]?.rawId as string, 'trajectory.jsonl'),
      ).events.map((e) => `${e.source}:${e.cmd}`);
    expect(traj(o, er)).toEqual(traj(h, hr));
    expect(traj(o, er)).toContain('shim:greenlight');
    expect(traj(o, er).slice(0, 2)).toEqual(['transcript:write_file', 'transcript:bash']);
    expect(traj(o, er).at(-1)).toBe('transcript:finish');
  }, 240_000);

  it('a wiki task: the production schema with issues fed back, read tools only, the judge on the host; pass and fail', async () => {
    const reference = readFileSync(join(BENCH, 'references', WIKI, 'output.json'), 'utf8');
    const judge = fakeJudge();
    const o = options({ tasks: [WIKI], fetchImpl: judge.fetchImpl });
    const run = runBench(o);
    const { manifest: m, rollout } = await whenState(o.manifest, 'open');
    const prompt = await client(m, rollout.handle, ['prompt']);
    expect(prompt.out).toContain('You are the Wiki Maintainer for a Greenlight installation.');
    expect(prompt.out).toContain('## read_file');
    expect(prompt.out).not.toContain('## bash');
    expect(prompt.out).toContain('finish --json-stdin');
    expect(prompt.out).toContain('"create_pages"');
    const read = await client(m, rollout.handle, ['read_file', 'wiki/index.md', '--limit', '5']);
    expect(read.code).toBe(0);
    expect(read.out).toMatch(/\[lines 1–5 of \d+\]/);
    // A maintainer has no bash: an unknown tool is an error result, and it costs the step.
    const sh = await client(m, rollout.handle, ['bash', 'ls']);
    expect(sh.code).toBe(1);
    expect(sh.out).toMatch(/\[tool error\].*unknown tool \\?"bash/);
    const missing = await client(m, rollout.handle, ['read_file', 'wiki/nope.md']);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/\[tool error\]/);
    const bad = await client(m, rollout.handle, [
      'finish',
      '{"create_pages":[],"update_pages":[]}',
    ]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/output rejected.*2 attempt\(s\) left/);
    expect(bad.out).toMatch(/append_log/);
    const status = JSON.parse((await client(m, rollout.handle, ['status'])).out);
    expect(status).toMatchObject({ state: 'claimed', stepsUsed: 4 });
    const ok = await client(m, rollout.handle, ['finish', '--json-stdin'], reference);
    expect(ok.code, ok.out + ok.err).toBe(0);
    const r = await run;
    expect(r.status, `${r.message} ${JSON.stringify(r.rollouts)}`).toBe('complete');
    expect(r.record?.outcomes[0]).toMatchObject({ task: WIKI, score: 1, servedBy: EXT_SMALL });
    expect(judge.calls()).toBe(1);
    expect(JSON.parse(artifact(o, r, r.rollouts[0]?.rawId as string, 'output.json'))).toEqual(
      JSON.parse(reference),
    );
    // The judge's one request is the only spend, and it is charged to the judge model.
    const spend = spendEvents(o);
    expect(spend).toHaveLength(1);
    expect(spend[0]?.spend).toMatchObject({ model: JUDGE, requests: 1, rollouts: 0 });
    expect([...o.quotaStore.counts.keys()]).toEqual([JUDGE]);
    expect(o.quotaStore.counts.get(JUDGE)).toMatchObject({ day: pacificDay(new Date()), count: 1 });

    // A fail: three rejected submissions close the rollout, graded 0.
    const f = options({ tasks: [WIKI], fetchImpl: fakeJudge().fetchImpl });
    const frun = runBench(f);
    const open = await whenState(f.manifest, 'open');
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push((await client(open.manifest, open.rollout.handle, ['finish', '{}'])).code);
    expect(codes).toEqual([1, 1, 1]);
    const after = await client(open.manifest, open.rollout.handle, ['read_file', 'wiki/index.md']);
    expect(after.code).toBe(3);
    expect(after.err).toMatch(/refused: the rollout is closed \(finish_invalid/);
    const fr = await frun;
    expect(fr.status, fr.message).toBe('complete');
    expect(fr.record?.outcomes[0]?.score).toBe(0);
  }, 240_000);

  it('the step budget: notes from 5 left, the rollout closes at 0 and is graded as it stands', async () => {
    const o = options({ maxSteps: 3 });
    const run = runBench(o);
    const { manifest: m, rollout } = await whenState(o.manifest, 'open');
    const a = await client(m, rollout.handle, ['list_dir']);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/\[steps_remaining: 2; 2 step\(s\) remain: finish the work/);
    const b = await client(m, rollout.handle, ['list_files', 'tools', '--depth', '1']);
    expect(b.out).toMatch(/\[steps_remaining: 1;/);
    const c = await client(m, rollout.handle, ['bash', 'echo hi']);
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/^exit=0\nhi\n\[steps_remaining: 0; no steps remain\]/);
    expect(c.out).toMatch(/the step budget is used up: the rollout is closed/);
    const d = await client(m, rollout.handle, ['finish', 'late']);
    expect(d.code).toBe(3);
    expect(d.err).toMatch(/refused: the rollout is closed \(step_limit/);
    const r = await run;
    // Out of budget = a graded outcome (as for a harness rollout), not a deferral.
    expect(r.status, r.message).toBe('complete');
    expect(r.record?.outcomes[0]).toMatchObject({ score: 0 });
    expect(r.identity?.harness.limits?.maxSteps).toBe(3);
    expect(rawRecords(o)[0]?.retained.excerpt).toMatch(/ended with step_limit/);
  }, 180_000);

  it('the wall clock: a rollout that runs past it is graded as it stands', async () => {
    // 1.2 s × factor 1; counted from the first command.
    const o = options({ rolloutTimeoutMs: 1200, externalTimeoutFactor: 1 });
    const run = runBench(o);
    const { manifest: m, rollout } = await whenState(o.manifest, 'open');
    expect((await client(m, rollout.handle, ['list_dir'])).code).toBe(0);
    const r = await run;
    expect(r.status, r.message).toBe('complete');
    expect(r.record?.outcomes[0]?.score).toBe(0);
    expect(rawRecords(o)[0]?.retained.excerpt).toMatch(/ended with aborted/);
  }, 180_000);

  it('claim timeout defers; a bad token and a queued rollout are refused; resume opens only what is left', async () => {
    const o = options({ runs: 2, concurrency: 1, claimTimeoutMs: 1500 });
    const run = runBench(o);
    const k1 = `${LOOP}|${EXT_SMALL}|1`;
    const k2 = `${LOOP}|${EXT_SMALL}|2`;
    const { manifest: m, rollout } = await whenState(o.manifest, 'open', k1);
    expect(m.rollouts.map((x) => [x.key, x.state])).toEqual([
      [k1, 'open'],
      [k2, 'queued'],
    ]);
    expect(m.counts).toMatchObject({ open: 1, queued: 1 });
    // A wrong token, an unknown rollout, a malformed handle.
    const forged = rollout.handle.replace(/[a-f0-9]{32}$/, 'a'.repeat(32));
    const bad = await client(m, forged, ['prompt']);
    expect(bad.code).toBe(3);
    expect(bad.err).toMatch(/refused: bad handle or token/);
    const junk = await client(m, 'not-a-handle', ['prompt']);
    expect(junk.code).toBe(3);
    // The second rollout is not open yet (concurrency 1).
    const queued = m.rollouts.find((x) => x.key === k2)?.handle as string;
    const early = await client(m, queued, ['prompt']);
    expect(early.code).toBe(3);
    expect(early.err).toMatch(/refused: this rollout is not open yet/);
    // Drive run 1; nobody claims run 2.
    await driveLoop(o, GOOD, k1);
    const r = await run;
    expect(r.status, r.message).toBe('deferred');
    expect(r.remaining).toEqual({ [EXT_SMALL]: [k2] });
    expect(r.deferredModels?.[EXT_SMALL]).toMatch(/no agent claimed the rollout within 2 s/);
    expect(r.record).toBeUndefined();
    // A deferred rollout leaves no raw record and no outcome.
    expect(rawRecords(o)).toHaveLength(1);
    const ended = readManifest(o.manifest) as RolloutManifest;
    expect(ended.rollouts.map((x) => x.state)).toEqual(['done', 'deferred']);

    // Resume: the agent id is the evaluation's own; only run 2 is opened.
    const resumed = runBench({ ...o, agent: undefined, resume: r.evaluationId });
    const next = await whenState(o.manifest, 'open', k2);
    expect(next.manifest.rollouts.map((x) => x.key)).toEqual([k2]);
    expect(next.rollout.handle).not.toBe(queued);
    await driveLoop(o, GOOD, k2);
    const done = await resumed;
    expect(done.status, done.message).toBe('complete');
    expect(done.record?.outcomes.map((x) => [x.run, x.score])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(done.identity).toEqual(r.identity);
    // A different declared agent is a different identity: the resume is refused.
    const p = options({ runs: 2, concurrency: 2, claimTimeoutMs: 300 });
    const first = await runBench(p);
    expect(first.status).toBe('deferred');
    const swapped = await runBench({ ...p, agent: 'someone/else', resume: first.evaluationId });
    expect(swapped.status).toBe('policy-refused');
    expect(swapped.message).toMatch(/identity changed \(agent\)/);
  }, 240_000);

  it('config and selection: schema, identity hash, mixed pair, missing agent, harness-only flags', async () => {
    const config = (over: (m: typeof LIVE) => void) => {
      const m = structuredClone(LIVE);
      over(m);
      return ModelsConfigSchema.safeParse(m);
    };
    // An external entry takes no limits; a harness-driven one needs them.
    expect(
      config((m) => {
        m.roles.frontier = { id: 'x', external: true, limits: { rpm: 1, rpd: 1 } };
      }).success,
    ).toBe(false);
    expect(
      config((m) => {
        m.roles.frontier = { id: 'x' };
      }).success,
    ).toBe(false);
    // The judge is called by the harness: it cannot resolve to an external entry.
    const judged = config((m) => {
      m.roles.small = { id: 'x', external: true };
    });
    expect(judged.success).toBe(false);
    expect(JSON.stringify(judged.error?.issues)).toMatch(
      /give roles\.judge a harness-driven entry/,
    );
    // The live config is unchanged in meaning: the flag enters the identity only when set.
    const live = ModelsConfigSchema.parse(LIVE);
    const flagged = ModelsConfigSchema.parse({
      ...LIVE,
      roles: {
        ...LIVE.roles,
        frontier: { id: LIVE.roles.frontier.id, external: true },
        judge: 'small',
      },
    });
    expect(modelsConfigIdentity(flagged)).not.toBe(modelsConfigIdentity(live));

    // One external, one harness-driven: both selected is refused; each alone is its own mode.
    const mixed = externalBench((m) => {
      m.roles.small = LIVE.roles.small;
      m.roles.judge = 'small';
    });
    const both = await runBench(options({ benchDir: mixed, models: ['frontier', 'small'] }));
    expect(both.status).toBe('usage');
    expect(both.message).toMatch(/mix external \(outside-large\) and harness-driven/);
    const forced = await runBench(
      options({ benchDir: mixed, models: ['small'], agentMode: 'external' }),
    );
    expect(forced.status).toBe('usage');
    expect(forced.message).toMatch(/--agent-mode external needs the selected models/);
    const harness = await runBench(options({ agentMode: 'harness' }));
    expect(harness.status).toBe('usage');
    const anonymous = await runBench(options({ agent: undefined }));
    expect(anonymous.status).toBe('usage');
    expect(anonymous.message).toMatch(/external rollouts need --agent/);
    const odd = await runBench(options({ agent: 'has space' }));
    expect(odd.status).toBe('usage');
    // The process sandbox still cannot produce gate evidence.
    const val = await runBench(options({ split: 'val', tasks: [], role: 'baseline' }));
    expect(val.status).toBe('policy-refused');
  }, 60_000);

  it('the CLI: bench run flags reach the runner, bench rollout is the same client', async () => {
    const root = tmp('greenlight-bench-ext-cli-');
    const bench = externalBench();
    cpSync(bench, join(root, 'bench'), { recursive: true });
    cpSync(join(REPO, '.claude', 'skills'), join(root, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), readFileSync(join(REPO, 'pnpm-lock.yaml')));
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd: root,
      env: {},
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      assets: async () => assets,
      fetchImpl: noNetwork,
    };
    const base = ['run', '--sandbox', 'process', '--tasks', LOOP, '--models', 'small'];
    expect(await benchCommand(base, io)).toBe(2);
    expect(err.join('\n')).toMatch(/external rollouts need --agent/);
    expect(await benchCommand([...base, '--agent', AGENT, '--concurrency', '0'], io)).toBe(2);
    const manifest = join(root, 'out', 'manifest.json');
    const run = benchCommand(
      [...base, '--agent', AGENT, '--manifest', manifest, '--claim-timeout', '2', '--json'],
      io,
    );
    const o = { manifest } as Ext;
    const replies = await driveLoop(o, GOOD);
    expect(replies.map((x) => x.code)).toEqual([0, 0, 0, 0]);
    expect(await run, err.join('\n')).toBe(0);
    const doc = JSON.parse(out.join(''));
    expect(doc).toMatchObject({ status: 'complete', requests: 0, manifest });
    expect(err.join('\n')).toMatch(/external rollouts \(agent test-agent\/scripted-1\): manifest /);
    // The client lives outside the repository tree the command ran in.
    const m = readManifest(manifest) as RolloutManifest;
    expect(m.clientPath.startsWith(root)).toBe(false);
    expect(m.clientPath.startsWith(REPO)).toBe(false);
    expect(m.claimTimeoutSec).toBe(120);
    expect(m.instruction).toMatch(/Run `<command> prompt` and do exactly what it prints/);
    out.length = 0;
    expect(await benchCommand(['rollout', 'nope', 'prompt'], io)).toBe(3);
  }, 180_000);
});

describe.runIf(DOCKER)('external rollouts through the docker sandbox', () => {
  it('a val baseline rollout: the agent works in the container, grading is in a separate one', async () => {
    const LOOP_VAL = 'loop/fixture-preview-before-push-val';
    const o = options({
      sandbox: 'docker',
      split: 'val',
      role: 'baseline',
      tasks: [LOOP_VAL],
      runs: 1,
    });
    const run = runBench(o);
    const { manifest: m, rollout } = await whenState(o.manifest, 'open', undefined);
    const who = await client(m, rollout.handle, ['bash', 'id -u; pwd; ls /; cat /etc/hostname']);
    expect(who.code).toBe(0);
    expect(who.out).toMatch(/^exit=0\n10000\n\/work\n/);
    // The sandbox has no network and none of the host's bench: no answer key in reach.
    const net = await client(m, rollout.handle, [
      'bash',
      'ls /work | head -50; getent hosts example.com || echo no-dns',
    ]);
    expect(net.out).toMatch(/no-dns/);
    expect(net.out).not.toMatch(/references|graders|mutants/);
    const fin = await client(m, rollout.handle, ['finish', 'looked around']);
    expect(fin.code).toBe(0);
    const r = await run;
    expect(r.status, `${r.message} ${JSON.stringify(r.rollouts)}`).toBe('complete');
    expect(r.record?.role).toBe('baseline');
    expect(r.record?.outcomes[0]).toMatchObject({ score: 0, servedBy: EXT_SMALL });
    expect(r.record?.outcomes[0]?.graderError).toBeUndefined();
    expect(r.identity?.agent).toEqual({ vendor: 'external', version: AGENT });
    expect(r.identity?.harness.imageDigest).not.toBe('process');
    const raw = rawRecords(o);
    expect(raw[0]?.agent?.vendor).toBe('external');
    const traj = parseTrajectory(artifact(o, r, raw[0]?.rawId as string, 'trajectory.jsonl'));
    expect(traj.errors).toEqual([]);
    expect(traj.events.map((e) => e.cmd)).toEqual(['bash', 'bash', 'finish']);
  }, 300_000);
});
