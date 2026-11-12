import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  type DailyUsage,
  type IterateOptions,
  type IterateResult,
  type IterationState,
  type IterationStep,
  type QuotaStore,
  type RunnerAssets,
  dockerAvailable,
  iterate,
  iterationDir,
  ledgerProblems,
  loadIterationState,
  materializeCandidate,
  openBundle,
  parseLedger,
  readAccessLog,
  rejectedForReplayRegression,
  skillSetHashOf,
} from '@rtrentjones/greenlight-wiki';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBenchAssets } from '../bench-assets';
import { benchCommand } from '../commands/bench';

/**
 * `greenlight bench iterate` end to end (roadmap M2-01/M2-04, 13 §3 M2) with a scripted fake model:
 * no live LLM call is made. The fake answers four roles by their system prompt — rollout agents
 * (which write a task's reference tree, or its overgeneral mutant when the control's rule is in
 * their skills), the rollout maintainer (reference output when the candidate's rule is in its
 * skills), the iteration's maintainer (06 §2.2) and its proposer (06 §3.3, reading traces through
 * the access-logged tools). A 429 on one model in one step simulates a spent free-tier day, so
 * the iteration defers at every rollout step and LLM step and resumes "the next day".
 */

const REPO = resolve(__dirname, '../../..');
const BENCH = join(REPO, 'bench');
const FRONTIER = 'gemini-3.6-flash';
const SMALL = 'gemini-3.5-flash-lite';
const DOCKER = dockerAvailable();
const IDLE_VAL = 'replay/idle-probe-leaves-store-asleep-val';
const CANDIDATE_MARKER = 'WIKI-MARKER: reconcile probe lessons by liveness model.';
const CONTROL_MARKER = 'must always query the database';

const temps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
let assets: RunnerAssets;
beforeAll(async () => {
  assets = await buildBenchAssets(REPO);
  temps.push(resolve(assets.cliDir, '..'));
}, 120_000);
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function memoryQuota(): QuotaStore {
  const counts = new Map<string, DailyUsage>();
  return {
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

/** Every file under `dir`, relative path → content. */
function treeFiles(dir: string): [string, string][] {
  if (!existsSync(dir)) return [];
  const out: [string, string][] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else out.push([relative(dir, f), readFileSync(f, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

/** A tiny bench: the real tasks, graders and mutants, with the loop tasks quarantined, the rest
 * active, one run per gate cell, and generous quota so a fake "day" is bounded only by the 429s. */
function tinyBench(root: string, withControl: boolean): string {
  const bench = join(root, 'bench');
  cpSync(BENCH, bench, { recursive: true });
  for (const kind of readdirSync(join(bench, 'tasks'))) {
    for (const t of readdirSync(join(bench, 'tasks', kind))) {
      const f = join(bench, 'tasks', kind, t, 'task.json');
      const spec = JSON.parse(readFileSync(f, 'utf8'));
      spec.state = kind === 'loop' ? 'quarantined' : 'active';
      if (kind === 'loop') spec.quarantineReason = 'not exercised by the iterate test';
      writeFileSync(f, `${JSON.stringify(spec, null, 2)}\n`);
    }
  }
  writeFileSync(join(bench, 'gate.json'), '{ "alpha": 0.05, "runs": 1, "resamples": 1000 }\n');
  const models = JSON.parse(readFileSync(join(bench, 'models.json'), 'utf8'));
  for (const r of ['frontier', 'small']) models.roles[r].limits = { rpm: 60, rpd: 1000, tpm: 1e7 };
  writeFileSync(join(bench, 'models.json'), `${JSON.stringify(models, null, 2)}\n`);
  if (!withControl) rmSync(join(bench, 'controls'), { recursive: true, force: true });
  return bench;
}

type Call = { name: string; args: Record<string, unknown> };
interface Body {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { role: string; parts: Record<string, unknown>[] }[];
  generationConfig?: { responseJsonSchema?: unknown };
}

const systemText = (b: Body) =>
  (b.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('');
const lastResult = (b: Body, name: string): string => {
  for (const c of [...(b.contents ?? [])].reverse()) {
    for (const p of c.parts) {
      const fr = p.functionResponse as
        | { name: string; response?: { result?: string; error?: unknown } }
        | undefined;
      if (fr?.name === name) return String(fr.response?.result ?? '');
    }
  }
  return '';
};

interface Fake {
  fetchImpl: typeof fetch;
  /** The step in progress (set by `onStep`) and the model whose day is spent in it. */
  exhaust: { step: IterationStep; model: string } | null;
  phase: IterationStep | null;
  rolloutCalls: number;
  proposal: Record<string, unknown>;
}

function fakeModel(wiki: string): Fake {
  const briefs = new Map<string, string>();
  for (const kind of readdirSync(join(BENCH, 'tasks'))) {
    for (const t of readdirSync(join(BENCH, 'tasks', kind))) {
      briefs.set(readFileSync(join(BENCH, 'tasks', kind, t, 'brief.md'), 'utf8'), `${kind}/${t}`);
    }
  }
  const fake: Fake = {
    exhaust: null,
    phase: null,
    rolloutCalls: 0,
    proposal: {
      action: 'patch',
      outlet: 'skill',
      name: 'greenlight-wiki',
      edits: [{ file: 'SKILL.md', op: 'append', text: `\n${CANDIDATE_MARKER}\n` }],
      patterns: ['pattern/probe-touches-wrong-layer'],
    },
    fetchImpl: undefined as unknown as typeof fetch,
  };
  const reply = (model: string, call: Call | { text: string }) =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                'text' in call
                  ? { text: call.text }
                  : { functionCall: { name: call.name, args: call.args } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
        modelVersion: `models/${model}`,
      }),
      { status: 200 },
    );
  fake.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
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
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    const model = decodeURIComponent(u.match(/models\/([^:]+):generateContent/)?.[1] ?? '');
    if (body.generationConfig?.responseJsonSchema)
      return reply(model, {
        text: '{"passed":true,"rationale":"conditional on the liveness model"}',
      });
    if (fake.exhaust && fake.phase === fake.exhaust.step && fake.exhaust.model === model)
      return new Response('{"error":{"message":"RESOURCE_EXHAUSTED"}}', { status: 429 });
    const sys = systemText(body);
    const turn = (body.contents ?? []).filter((c) => c.role === 'model').length;
    if (sys.includes('Wiki Maintainer for a Greenlight installation')) {
      if (turn === 0)
        return reply(model, { name: 'read_file', args: { path: 'bundle/wiki/index.md' } });
      return reply(model, {
        name: 'finish',
        args: {
          create_pages: [],
          update_pages: [
            {
              id: 'pattern/probe-touches-wrong-layer',
              ops: [
                {
                  op: 'append',
                  text: '\nThe layer depends on the liveness model: needs-traffic probes reach the store; needs-silence probes leave it alone.\n',
                },
              ],
            },
          ],
          update_index: readFileSync(join(wiki, 'index.md'), 'utf8'),
          append_log:
            'probe-touches-wrong-layer: conditional on the liveness model (both incidents).',
        },
      });
    }
    if (sys.includes('Skill Proposer for a Greenlight installation')) {
      if (turn === 0) return reply(model, { name: 'wiki_traces', args: { limit: 20 } });
      const ids = lastResult(body, 'wiki_traces')
        .split('\n')
        .map((l) => l.split(/\s+/)[0])
        .filter(Boolean);
      if (turn >= 1 && turn <= 4)
        return reply(model, { name: 'wiki_read', args: { ref: `raw:${ids[turn - 1]}` } });
      if (turn === 5)
        return reply(model, { name: 'wiki_read', args: { ref: 'skill:greenlight-wiki' } });
      return reply(model, { name: 'finish', args: fake.proposal });
    }
    // A bench rollout: identify the task by its brief (the first user turn).
    fake.rolloutCalls++;
    const brief = String((body.contents?.[0]?.parts[0] as { text?: string })?.text ?? '');
    const task = briefs.get(brief) ?? '';
    if (task.startsWith('wiki/')) {
      const which = sys.includes(CANDIDATE_MARKER)
        ? join(BENCH, 'references', task, 'output.json')
        : join(BENCH, 'mutants', task, 'invalid-output', 'output.json');
      return reply(model, { name: 'finish', args: { output: readFileSync(which, 'utf8') } });
    }
    const files = new Map(treeFiles(join(BENCH, 'references', task, 'tree')));
    if (task.startsWith('replay/idle-probe') && sys.includes(CONTROL_MARKER)) {
      for (const [p, t] of treeFiles(join(BENCH, 'mutants', task, 'overgeneral-a', 'tree')))
        files.set(p, t);
    }
    // Training on the small model fails (no change), so the maintainer sees failing traces.
    const list = task.endsWith('-train') && model === SMALL ? [] : [...files];
    const f = list[turn];
    if (f) return reply(model, { name: 'write_file', args: { path: f[0], content: f[1] } });
    return reply(model, { name: 'finish', args: { summary: 'done' } });
  }) as typeof fetch;
  return fake;
}

const DAY = 86_400_000;

function setup(withControl = true) {
  const root = tmp('greenlight-iterate-');
  const bench = tinyBench(root, withControl);
  const wiki = join(root, 'wiki');
  cpSync(join(REPO, 'wiki'), wiki, { recursive: true });
  const skills = join(root, 'skills');
  cpSync(join(REPO, '.claude', 'skills'), skills, { recursive: true });
  mkdirSync(join(skills, 'greenlight-wiki'));
  writeFileSync(
    join(skills, 'greenlight-wiki', 'SKILL.md'),
    '---\nname: greenlight-wiki\ndescription: Maintain the Greenlight wiki from execution evidence.\nversion: "1"\n---\n# greenlight-wiki\n\nCompile evidence into pages.\n',
  );
  const stateDir = join(root, '.greenlight');
  const fake = fakeModel(wiki);
  const base = Date.now();
  const options = (day: number, over: Partial<IterateOptions> = {}): IterateOptions => {
    let clock = base + day * DAY;
    return {
      repoRoot: REPO,
      benchDir: bench,
      skillsDir: skills,
      wikiRoot: wiki,
      stateDir,
      sandbox: 'docker',
      assets,
      env: {},
      fetchImpl: fake.fetchImpl,
      now: () => new Date(clock),
      throttle: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      quotaStore: memoryQuota(),
      retryDelaysMs: [0, 0],
      sleep: async () => {},
      maxSteps: 8,
      rolloutTimeoutMs: 120_000,
      onStep: (s) => {
        fake.phase = s;
      },
      ...over,
    };
  };
  return { root, bench, wiki, skills, stateDir, fake, options, base };
}

const ledger = (wiki: string) =>
  parseLedger(readFileSync(join(wiki, 'ledger.jsonl'), 'utf8')).events;

describe('bench iterate (M2-01, M2-04)', () => {
  const maybe = DOCKER ? it : it.skip;

  maybe(
    'one full iteration with a deferral at every step: maintainer applied, ≥4 logged reads, candidate gated, control rejected for the Neon replay, ledger, hand-off, review',
    async () => {
      const env = setup(true);
      const realSkills = skillSetHashOf(join(REPO, '.claude', 'skills'));
      const skillsBefore = skillSetHashOf(env.skills);
      const id = 'iter-test-full';
      const plan: [IterationStep | null, string | null][] = [
        ['train', SMALL],
        ['maintainer', FRONTIER],
        ['baseline', SMALL],
        ['proposer', FRONTIER],
        ['evaluate', SMALL],
        ['control', SMALL],
        [null, null],
      ];
      const results: IterateResult[] = [];
      for (const [day, [step, model]] of plan.entries()) {
        env.fake.exhaust = step && model ? { step, model } : null;
        const r = await iterate(env.options(day, day === 0 ? { iterationId: id } : { resume: id }));
        results.push(r);
        if (step) {
          expect(r.status, `${step}: ${r.message}`).toBe('deferred');
          expect(r.step).toBe(step);
          expect(r.exitCode).toBe(1);
          // The deferral is persisted: a fresh read of state.json says where it stopped.
          const saved = loadIterationState(env.stateDir, id);
          expect(saved.status).toBe('deferred');
          expect(saved.step).toBe(step);
          if (['train', 'baseline', 'evaluate', 'control'].includes(step))
            expect(Object.keys(r.remaining ?? {})).toEqual([SMALL]);
        } else {
          expect(r.status, r.message).toBe('complete');
          expect(r.exitCode).toBe(0);
        }
      }
      const s = loadIterationState(env.stateDir, id) as IterationState;
      const dir = iterationDir(env.stateDir, id);

      // Maintainer: validated, applied, logged.
      expect(s.maintainer.applied).toBe(true);
      expect(
        readFileSync(join(env.wiki, 'patterns/probe-touches-wrong-layer.md'), 'utf8'),
      ).toContain('needs-silence probes leave it alone');
      expect(readFileSync(join(env.wiki, 'log.md'), 'utf8')).toContain(`maintainer:${FRONTIER}`);
      expect(s.settings.incidents).toHaveLength(2);
      const mBundle = join(dir, s.maintainer.bundleDir as string);
      expect(readdirSync(join(mBundle, 'incident')).filter((f) => f.endsWith('.md'))).toHaveLength(
        2,
      );

      // Proposer: ≥4 raw reads through the logged interface, in a verified access log.
      const pBundle = openBundle(
        join(dir, s.proposer.bundleDir as string),
        join(env.stateDir, 'bundle-keys'),
      );
      const access = readAccessLog(pBundle);
      expect(access.problems).toEqual([]);
      expect(
        access.entries.filter((e) => e.target.startsWith('raw:') && !e.refused).length,
      ).toBeGreaterThanOrEqual(4);
      expect(s.proposer.rawReads?.length).toBeGreaterThanOrEqual(4);
      expect(s.proposer.proposal).toMatchObject({ action: 'patch', name: 'greenlight-wiki' });

      // Candidate: gated by decide(); the candidate's rule fixes the wiki task on both models.
      expect(s.evaluate.kind).toBe('skill');
      expect(s.evaluate.event?.stage).toBe('candidate-accepted');
      expect(s.evaluate.candidate?.decision?.results.map((r) => r.model).sort()).toEqual(
        [SMALL, FRONTIER].sort(),
      );

      // Control: rejected because the Neon val replay regresses (06 §10.3).
      const ctl = s.control.items[0];
      expect(ctl?.event?.stage).toBe('candidate-rejected');
      expect(ctl?.event?.control).toBe(true);
      expect(ctl?.expect.task).toBe(IDLE_VAL);
      expect(ctl?.expectMet).toBe(true);
      expect(rejectedForReplayRegression(ctl?.decision as never, IDLE_VAL)).toBe(true);

      // Ledger: both proposals, legal stage order, gate inputs on disk, skill-impact re-rendered.
      const events = ledger(env.wiki);
      expect(ledgerProblems(events)).toEqual([]);
      const own = events.filter((e) => e.stage !== 'spend');
      expect(own.map((e) => [e.proposalId, e.stage])).toEqual([
        [s.proposer.proposalId, 'candidate-accepted'],
        [ctl?.proposalId, 'candidate-rejected'],
      ]);
      const impact = readFileSync(join(env.wiki, 'skill-impact.md'), 'utf8');
      expect(impact).toContain(s.proposer.proposalId as string);
      expect(impact).toContain(ctl?.proposalId as string);

      // Both decisions reproduce with `bench gate --recompute`.
      for (const gi of [s.evaluate.candidate?.gateInput?.hash, ctl?.gateInput?.hash]) {
        const out: string[] = [];
        const code = await benchCommand(['gate', '--recompute', gi as string, '--root', env.wiki], {
          cwd: env.root,
          env: {},
          out: (x) => out.push(x),
          err: (x) => out.push(x),
        });
        expect(code, out.join('\n')).toBe(0);
      }

      // Hand-off: a PR with the diff, ledger event, gate input, recompute command, per-model×mode.
      const md = readFileSync(join(dir, 'handoff.md'), 'utf8');
      const gi = s.evaluate.candidate?.gateInput?.hash as string;
      expect(md).toContain('kind: pr');
      expect(md).toContain('draft: false');
      expect(md).toContain(
        `title: evo(greenlight-wiki): 1 edit(s) citing pattern/probe-touches-wrong-layer [${s.proposer.proposalId}]`,
      );
      expect(md).toContain(s.evaluate.event?.eventId as string);
      expect(md).toContain(`greenlight bench gate --recompute ${gi}`);
      expect(md).toContain(`| ${FRONTIER} | isolation | val |`);
      expect(md).toContain(`| ${SMALL} | isolation | val |`);
      expect(md).toContain(`+${CANDIDATE_MARKER}`);
      expect(md).toContain(`rejected for a replay regression: yes, on \`${IDLE_VAL}\``);
      expect(md).toContain('**met**');
      expect(md).toContain('### Cost');
      expect(md).toContain(`greenlight bench review ${id} --decision accept|reject`);
      const json = JSON.parse(readFileSync(join(dir, 'handoff.json'), 'utf8'));
      expect(json).toMatchObject({ kind: 'pr', gateInput: gi, eventId: s.evaluate.event?.eventId });

      // The iteration never touched the skills it was given, nor the repo's.
      expect(skillSetHashOf(env.skills)).toBe(skillsBefore);
      expect(skillSetHashOf(join(REPO, '.claude', 'skills'))).toBe(realSkills);

      // --handoff-only regenerates; review records the owner's decision.
      rmSync(join(dir, 'handoff.md'));
      const io = (out: string[]) => ({
        cwd: env.root,
        env: {},
        out: (x: string) => out.push(x),
        err: (x: string) => out.push(x),
        iterate: { now: () => new Date(env.base + 9 * DAY) },
      });
      const o1: string[] = [];
      expect(
        await benchCommand(
          [
            'iterate',
            '--resume',
            id,
            '--handoff-only',
            '--bench',
            env.bench,
            '--root',
            env.wiki,
            '--skills',
            env.skills,
          ],
          io(o1),
        ),
        o1.join('\n'),
      ).toBe(0);
      expect(existsSync(join(dir, 'handoff.md'))).toBe(true);
      const o2: string[] = [];
      expect(
        await benchCommand(
          [
            'review',
            id,
            '--decision',
            'reject',
            '--reason',
            'owner wants a smaller rule',
            '--root',
            env.wiki,
            '--skills',
            env.skills,
          ],
          io(o2),
        ),
        o2.join('\n'),
      ).toBe(0);
      const after = ledger(env.wiki);
      expect(ledgerProblems(after)).toEqual([]);
      const reviews = after.filter((e) => e.review);
      expect(reviews.map((e) => [e.proposalId, e.stage, e.review?.decision])).toEqual([
        [s.proposer.proposalId, 'withdrawn', 'reject'],
        [ctl?.proposalId, 'review', 'reject'],
      ]);
      expect(readFileSync(join(dir, 'handoff.md'), 'utf8')).toContain('**reject**');
      const o3: string[] = [];
      expect(
        await benchCommand(
          ['review', id, '--decision', 'accept', '--reason', 'again', '--root', env.wiki],
          io(o3),
        ),
      ).toBe(4);

      // A second iteration reuses the sealed train and baseline evidence (same identity), and a
      // justified no_action is a successful iteration (06 §0). No controls this time.
      const calls = env.fake.rolloutCalls;
      env.fake.exhaust = null;
      env.fake.proposal = {
        action: 'no_action',
        reason: 'the training traces show no failure a skill change would fix',
      };
      const r2 = await iterate(
        env.options(10, {
          iterationId: 'iter-test-noaction',
          controlsDir: join(env.bench, 'none'),
        }),
      );
      expect(r2.status, r2.message).toBe('complete');
      expect(env.fake.rolloutCalls).toBe(calls);
      const s2 = r2.state as IterationState;
      expect(s2.train.message).toMatch(/reusing train evaluation/);
      expect(s2.baseline.message).toMatch(/reusing baseline evaluation/);
      expect(s2.evaluate.event?.stage).toBe('no-action');
      expect(s2.control.status).toBe('skipped');
      const md2 = readFileSync(
        join(iterationDir(env.stateDir, 'iter-test-noaction'), 'handoff.md'),
        'utf8',
      );
      expect(md2).toContain('kind: review');
      expect(md2).toContain('A justified `no_action` is a successful iteration');

      // A mechanism proposal goes to outlets.ts; with no trusted repro it is invalid: no ledger
      // row, recorded in the hand-off as a no-ledger outcome (not a rejection).
      env.fake.proposal = {
        action: 'issue',
        outlet: 'mechanism',
        title: 'Validate probe targets against the liveness model',
        body: 'A manifest liveness field and a probe-target validation.',
        patterns: ['pattern/probe-touches-wrong-layer'],
      };
      const before3 = ledger(env.wiki).filter((e) => e.stage !== 'spend').length;
      const r3 = await iterate(
        env.options(11, {
          iterationId: 'iter-test-mechanism',
          controlsDir: join(env.bench, 'none'),
        }),
      );
      expect(r3.status, r3.message).toBe('complete');
      expect(r3.state?.evaluate.outlet?.result?.decision).toBe('invalid');
      expect(r3.state?.evaluate.event).toBeUndefined();
      expect(ledger(env.wiki).filter((e) => e.stage !== 'spend').length).toBe(before3);
      const md3 = readFileSync(
        join(iterationDir(env.stateDir, 'iter-test-mechanism'), 'handoff.md'),
        'utf8',
      );
      expect(md3).toContain('kind: issue');
      expect(md3).toContain('title: Validate probe targets against the liveness model');
      expect(md3).toContain('**No ledger outcome.**');
    },
    900_000,
  );
});

describe('bench iterate guards', () => {
  it('refuses to write a candidate skill set or its state inside the accepted skills', async () => {
    const root = tmp('greenlight-iterate-guard-');
    const skills = join(root, 'skills');
    cpSync(join(REPO, '.claude', 'skills'), skills, { recursive: true });
    const before = skillSetHashOf(skills);
    const p = {
      action: 'patch' as const,
      outlet: 'skill' as const,
      name: 'provider-neon',
      edits: [{ file: 'SKILL.md', op: 'append' as const, text: '\nx\n' }],
      patterns: ['pattern/neon-never-sleeps'],
    };
    expect(() => materializeCandidate(skills, p, join(skills, 'cand'))).toThrow(/never modifies/);
    expect(() => materializeCandidate(skills, p, root)).toThrow(/never modifies/);
    const ok = materializeCandidate(skills, p, join(root, 'cand'));
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(root, 'cand', 'provider-neon', 'SKILL.md'), 'utf8')).toMatch(/\nx\n$/);
    expect(skillSetHashOf(skills)).toBe(before);
    const r = await iterate({
      repoRoot: REPO,
      benchDir: BENCH,
      skillsDir: skills,
      wikiRoot: join(REPO, 'wiki'),
      stateDir: join(skills, '.greenlight'),
      sandbox: 'process',
      assets: {} as RunnerAssets,
    });
    expect(r.exitCode).toBe(4);
    expect(r.message).toMatch(/never modifies/);
    expect(skillSetHashOf(skills)).toBe(before);
  });

  it('--dry-run plans without a request or a write', async () => {
    const root = tmp('greenlight-iterate-dry-');
    const out: string[] = [];
    const code = await benchCommand(
      [
        'iterate',
        '--dry-run',
        '--bench',
        BENCH,
        '--root',
        join(REPO, 'wiki'),
        '--skills',
        join(REPO, '.claude', 'skills'),
      ],
      { cwd: root, env: {}, out: (x) => out.push(x), err: (x) => out.push(x) },
    );
    expect(code, out.join('\n')).toBe(0);
    expect(out.join('\n')).toMatch(/a new iteration/);
    expect(out.join('\n')).toMatch(/control\s+pending\s+1 control/);
    expect(existsSync(join(root, '.greenlight'))).toBe(false);
  });

  it('review refuses usage errors and an unknown iteration', async () => {
    const root = tmp('greenlight-iterate-review-');
    const io = { cwd: root, env: {}, out: () => {}, err: () => {} };
    expect(
      await benchCommand(['review', 'iter-x', '--decision', 'maybe', '--reason', 'r'], io),
    ).toBe(2);
    expect(await benchCommand(['review', 'iter-x', '--decision', 'accept'], io)).toBe(2);
    expect(
      await benchCommand(['review', 'iter-x', '--decision', 'accept', '--reason', 'r'], io),
    ).toBe(2);
  });
});

describe('evo.yml', () => {
  it('runs only on workflow_dispatch, serialized in greenlight-evo, and commits nothing', () => {
    const text = readFileSync(join(REPO, '.github/workflows/evo.yml'), 'utf8');
    expect(text).not.toMatch(/^\s*(push|pull_request|pull_request_target|schedule|workflow_run):/m);
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
    expect(text).toMatch(/group:\s*greenlight-evo\s*$/m);
    expect(text).toMatch(/cancel-in-progress:\s*false/);
    expect(text).toContain('secrets.GEMINI_API_KEY');
    expect(text).toContain('.greenlight/bench/iterations/');
    expect(text).not.toMatch(/git (commit|push)/);
    expect(text).toMatch(/contents:\s*read/);
  });
});
