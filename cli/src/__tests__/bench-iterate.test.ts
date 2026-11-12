import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
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
import { hostname, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  type DailyUsage,
  type IterateOptions,
  type IterateResult,
  type IterationState,
  type IterationStep,
  type OutletContext,
  type QuotaStore,
  type RunnerAssets,
  acquireLock,
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
  sealEvent,
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
/** The live gate pair (bench/models.json), so a model switch does not rewrite the tests. */
const LIVE_MODELS = JSON.parse(readFileSync(join(REPO, 'bench', 'models.json'), 'utf8'));
const FRONTIER: string = LIVE_MODELS.roles.frontier.id;
const SMALL: string = LIVE_MODELS.roles.small.id;
const reId = (id: string) => id.replace(/[.]/g, '\\.');
const BENCH = join(REPO, 'bench');
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

const gitOut = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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
      // A gate that throws once the candidate evaluation is sealed: the decision fails, and the
      // retry decides from the sealed record without a rollout (M4).
      const failingDecide = (() => {
        throw new Error('injected gate failure');
      }) as unknown as IterateOptions['decide'];
      const plan: [IterationStep | null, string | null, Partial<IterateOptions>?][] = [
        ['train', SMALL],
        ['maintainer', FRONTIER],
        ['baseline', SMALL],
        ['proposer', FRONTIER],
        ['evaluate', SMALL],
        ['evaluate', null, { decide: failingDecide }],
        ['control', SMALL],
        [null, null],
      ];
      const results: IterateResult[] = [];
      let logBeforeLastDay = '';
      let sealedCandidate: string | undefined;
      for (const [day, [step, model, over]] of plan.entries()) {
        env.fake.exhaust = step && model ? { step, model } : null;
        if (step === null) logBeforeLastDay = readFileSync(join(env.wiki, 'log.md'), 'utf8');
        const callsBefore = env.fake.rolloutCalls;
        const r = await iterate(
          env.options(day, { ...(day === 0 ? { iterationId: id } : { resume: id }), ...over }),
        );
        results.push(r);
        if (over?.decide) {
          expect(r.status, r.message).toBe('failed');
          expect(r.message).toMatch(/injected gate failure/);
          const saved = loadIterationState(env.stateDir, id);
          expect(saved.evaluate.candidate?.record).toBeTruthy();
          expect(saved.evaluate.candidate?.decisionStatus).toBe('failed');
          sealedCandidate = saved.evaluate.candidate?.record;
          // A restored state is never trusted: a stored candidate hash, record or proposal id that
          // is not this step's refuses (exit 4) before anything runs; a tampered candidate
          // directory is rebuilt (checked after the loop).
          const stateFile = join(iterationDir(env.stateDir, id), 'state.json');
          const good = readFileSync(stateFile, 'utf8');
          type Cand = NonNullable<IterationState['evaluate']['candidate']>;
          const tamper = async (edit: (x: IterationState) => void, re: RegExp) => {
            const x = JSON.parse(good) as IterationState;
            edit(x);
            writeFileSync(stateFile, JSON.stringify(x, null, 2));
            const t = await iterate(env.options(day, { resume: id }));
            expect(t.exitCode, t.message).toBe(4);
            expect(t.message).toMatch(re);
            writeFileSync(stateFile, good);
          };
          await tamper((x) => {
            (x.evaluate.candidate as Cand).candidateSkillSetHash = '0'.repeat(64);
          }, /rebuilt from the proposal hashes to/);
          await tamper((x) => {
            (x.evaluate.candidate as Cand).record = x.baseline.record as string;
          }, /is not this step's record: it is a baseline record/);
          await tamper((x) => {
            x.proposer.proposalId = 'prop-deadbeefdead';
          }, /is not its content id/);
          const candSkill = join(
            iterationDir(env.stateDir, id),
            'candidates',
            saved.evaluate.candidate?.proposalId as string,
            'skills',
            'greenlight-wiki',
            'SKILL.md',
          );
          writeFileSync(candSkill, `${readFileSync(candSkill, 'utf8')}\nTAMPERED\n`);
          continue;
        }
        if (step === 'control') {
          // The retried decision reused the sealed candidate record: no candidate rollout ran
          // again (only the control's, which defers on SMALL).
          const saved = loadIterationState(env.stateDir, id);
          expect(saved.evaluate.candidate?.record).toBe(sealedCandidate);
          expect(saved.evaluate.candidate?.decisionStatus).toBe('done');
          expect(env.fake.rolloutCalls).toBeGreaterThanOrEqual(callsBefore);
        }
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
      expect(
        readFileSync(
          join(
            dir,
            'candidates',
            s.evaluate.candidate?.proposalId as string,
            'skills',
            'greenlight-wiki',
            'SKILL.md',
          ),
          'utf8',
        ),
      ).not.toContain('TAMPERED');

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
      expect(md).toContain('rejected for a replay regression: yes, on 1 val replay task');
      expect(md).toContain('**met**');
      // 06 §1.4: the public hand-off names no val task.
      expect(md).not.toContain(IDLE_VAL);
      expect(readFileSync(join(dir, 'handoff.json'), 'utf8')).not.toContain(IDLE_VAL);
      expect(md).toContain('### Cost');
      expect(md).toContain(`greenlight bench review ${id} --decision accept|reject`);
      const json = JSON.parse(readFileSync(join(dir, 'handoff.json'), 'utf8'));
      expect(json).toMatchObject({ kind: 'pr', gateInput: gi, eventId: s.evaluate.event?.eventId });

      // The iteration never touched the skills it was given, nor the repo's.
      expect(skillSetHashOf(env.skills)).toBe(skillsBefore);
      expect(skillSetHashOf(join(REPO, '.claude', 'skills'))).toBe(realSkills);

      // A crash between the ledger append and the log write is repaired on resume, once: the log
      // is put back as it was before the record step and the record step reruns.
      const ownIds = [s.evaluate.event?.eventId, ctl?.event?.eventId] as string[];
      const once = (t: string, x: string) => t.split(x).length - 1;
      for (const x of ownIds)
        expect(once(readFileSync(join(env.wiki, 'log.md'), 'utf8'), x)).toBe(1);
      writeFileSync(join(env.wiki, 'log.md'), logBeforeLastDay);
      const crashed = loadIterationState(env.stateDir, id);
      crashed.status = 'running';
      crashed.step = 'record';
      crashed.record = { status: 'pending' };
      crashed.handoff = { status: 'pending' };
      writeFileSync(join(dir, 'state.json'), `${JSON.stringify(crashed, null, 2)}\n`);
      const repaired = await iterate(env.options(8, { resume: id }));
      expect(repaired.status, repaired.message).toBe('complete');
      for (const x of ownIds)
        expect(once(readFileSync(join(env.wiki, 'log.md'), 'utf8'), x)).toBe(1);
      expect(ledger(env.wiki).length).toBe(events.length);

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
      // A crash after the review's append but before its state save: the retry appends nothing
      // twice (same eventIds), and a different decision is refused while one is half-recorded.
      const half = loadIterationState(env.stateDir, id);
      const reviewEvents = after.filter((e) => e.review);
      half.reviewPending = {
        decision: 'reject',
        reason: 'owner wants a smaller rule',
        ts: half.review?.ts as string,
        events: reviewEvents,
      };
      half.review = undefined;
      writeFileSync(join(dir, 'state.json'), `${JSON.stringify(half, null, 2)}\n`);
      const o2b: string[] = [];
      expect(
        await benchCommand(
          ['review', id, '--decision', 'accept', '--reason', 'other', '--root', env.wiki],
          io(o2b),
        ),
      ).toBe(4);
      expect(o2b.join('\n')).toMatch(/half-recorded/);
      // The pending events are re-derived, never appended as stored: a stored event that does
      // not re-derive (here: another eventId) is refused, and the pending review is kept.
      const forgedReview = JSON.parse(JSON.stringify(half)) as IterationState;
      (forgedReview.reviewPending as NonNullable<IterationState['reviewPending']>).events[0] = {
        ...(half.reviewPending?.events[0] as (typeof reviewEvents)[number]),
        eventId: 'f'.repeat(64),
      };
      writeFileSync(join(dir, 'state.json'), `${JSON.stringify(forgedReview, null, 2)}\n`);
      const o2c: string[] = [];
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
          io(o2c),
        ),
      ).toBe(4);
      expect(o2c.join('\n')).toMatch(/do not re-derive/);
      expect(loadIterationState(env.stateDir, id).reviewPending).toBeTruthy();
      writeFileSync(join(dir, 'state.json'), `${JSON.stringify(half, null, 2)}\n`);
      // A torn trailing line (a crash mid-append) is cut under the ledger lock before the retry.
      appendFileSync(join(env.wiki, 'ledger.jsonl'), '{"eventId":"torn-wri');
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
          io(o2b),
        ),
        o2b.join('\n'),
      ).toBe(0);
      expect(ledger(env.wiki)).toHaveLength(after.length);
      expect(ledgerProblems(ledger(env.wiki))).toEqual([]);
      expect(readFileSync(join(env.wiki, 'ledger.jsonl'), 'utf8')).not.toContain('torn-wri');
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
      expect(md3).not.toContain(IDLE_VAL);

      // M3: the outlet trees are pinned on first entry; a different --candidate on resume is
      // refused, and outletContext cannot override the pinned base / candidate / id / clock.
      const [head, prev] = [gitOut(REPO, 'rev-parse', 'HEAD'), gitOut(REPO, 'rev-parse', 'HEAD~1')];
      const seen: { base: unknown; candidate: unknown; proposalId: string }[] = [];
      let throwOnce = true;
      const fakeOutlet = (async (
        prop: { patterns: string[]; outlet: string },
        ctx: OutletContext,
      ) => {
        seen.push({ base: ctx.base, candidate: ctx.candidate, proposalId: ctx.proposalId });
        if ('commit' in ctx.candidate && ctx.candidate.commit === prev && throwOnce) {
          throwOnce = false;
          throw new Error('injected outlet failure');
        }
        const evidence = {
          kind: 'repro' as const,
          base: `commit:RTrentJones/greenlight@${'commit' in ctx.base ? ctx.base.commit : 'x'}`,
          candidate: `commit:RTrentJones/greenlight@${'commit' in ctx.candidate ? ctx.candidate.commit : 'x'}`,
          reproTask: 'repro/probe-touches-wrong-layer',
        };
        return {
          decision: 'accept',
          reasons: [],
          evidence,
          ledgerEvent: sealEvent({
            ts: ctx.now().toISOString(),
            proposalId: ctx.proposalId,
            stage: 'candidate-accepted',
            path: 'standard',
            pattern: [...prop.patterns],
            outlet: prop.outlet as 'mechanism',
            change: { kind: 'issue' },
            evidence,
          }),
        };
      }) as unknown as IterateOptions['evaluateOutlet'];
      env.fake.proposal = {
        action: 'issue',
        outlet: 'mechanism',
        title: 'Pin the probe layer',
        body: 'A pinned-tree test proposal.',
        patterns: ['pattern/probe-touches-wrong-layer'],
      };
      const pin = 'iter-test-pinned';
      const forged = {
        evaluateOutlet: fakeOutlet,
        outletContext: { base: { commit: 'forged' }, proposalId: 'forged' } as never,
        controlsDir: join(env.bench, 'none'),
      };
      const b0 = await iterate(env.options(12, { iterationId: pin, ...forged }));
      expect(b0.status, b0.message).toBe('blocked');
      expect(b0.message).toMatch(/needs the candidate change/);
      const pinnedBase = loadIterationState(env.stateDir, pin).evaluate.outlet?.base;
      expect(pinnedBase?.tree).toEqual({ commit: head });
      expect(seen[0]?.base).toEqual({ commit: head });
      expect(seen[0]?.proposalId).not.toBe('forged');
      const b1 = await iterate(
        env.options(12, { resume: pin, outletCandidate: { commit: 'HEAD~1' }, ...forged }),
      );
      expect(b1.status, b1.message).toBe('failed');
      expect(loadIterationState(env.stateDir, pin).evaluate.outlet?.candidate?.tree).toEqual({
        commit: prev,
      });
      const b2 = await iterate(
        env.options(12, { resume: pin, outletCandidate: { commit: head }, ...forged }),
      );
      expect(b2.exitCode).toBe(4);
      expect(b2.message).toMatch(/pinned/);
      const b3 = await iterate(env.options(12, { resume: pin, ...forged }));
      expect(b3.status, b3.message).toBe('complete');
      expect(seen.at(-1)).toMatchObject({ base: { commit: head }, candidate: { commit: prev } });
      expect(b3.state?.evaluate.event?.stage).toBe('candidate-accepted');
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
    expect(text).toContain('persist-credentials: false');
  });

  it('restores only a provenance-checked, authenticated blob, and uploads state only sealed', () => {
    const text = readFileSync(join(REPO, '.github/workflows/evo.yml'), 'utf8');
    // The job runs only on the allow-listed branch.
    expect(text).toMatch(
      /^\s{4}if: contains\(fromJSON\('\["refs\/heads\/2\.0"\]'\), github\.ref\)/m,
    );
    // Without the key: no restore (fails), no state upload, and the summary says so.
    expect(text).toContain('secrets.EVO_STATE_KEY');
    expect(text).toMatch(/refusing to restore unauthenticated state/);
    expect(text).toContain('No EVO_STATE_KEY secret');
    // Provenance: the run is resolved and checked before anything is downloaded.
    const check = text.indexOf("Check the state run's provenance");
    const download = text.indexOf('actions/download-artifact');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(download);
    expect(text).toContain('gh api "repos/$REPO/actions/runs/$RUN_ID"');
    expect(text).toContain('.github/workflows/evo.yml');
    expect(text).toContain('.head_repository.full_name');
    expect(text).toContain('.head_branch');
    expect(text).toContain('[ "$event" = "workflow_dispatch" ]');
    expect(text).toContain('git/ref/heads/$branch');
    expect(text).toContain('git/ref/tags/$branch');
    expect(text).toContain('compare/$EVO_SEALED_SINCE...$head_sha');
    expect(text).toMatch(/EVO_SEALED_SINCE: "[0-9a-f]{40}"/);
    // Opened (authenticated) into a temp dir, restored by the allow-list script, then linted.
    expect(text).toMatch(/path: \$\{\{ runner\.temp \}\}\/evo-sealed/);
    expect(text).not.toMatch(/download-artifact[\s\S]*?path: \.\s*$/m);
    expect(text).toContain(
      'node scripts/evo-state.mjs open "$RUNNER_TEMP/evo-sealed/state.glevo" "$RUNNER_TEMP/evo-state"',
    );
    expect(text).toContain('pnpm exec tsx scripts/evo-restore.mjs "$RUNNER_TEMP/evo-state" .');
    expect(text).toContain('pnpm greenlight wiki lint --strict');
    // Uploads: the masked hand-offs, and the sealed blob only when the key is present.
    const uploads = [...text.matchAll(/upload-artifact[\s\S]*?path: (.*)/g)].map((m) => m[1]);
    expect(uploads).toEqual([
      '.greenlight/bench/iterations/*/handoff.md',
      '${{ runner.temp }}/state.glevo',
    ]);
    expect(text).toMatch(
      /Upload the sealed state\n\s+if: always\(\) && steps\.key\.outputs\.present == 'yes'/,
    );
    expect(text).not.toMatch(/name: greenlight-evo-state\s*$/m);
  });

  it('evo-state seals with AES-256-GCM, opens only what authenticates, and only state paths', async () => {
    const mod = (await import(join(REPO, 'scripts', 'evo-state.mjs'))) as {
      parseKey: (t: string | undefined) => Buffer;
      collect: (c: string) => { path: string; data: Buffer }[];
      seal: (f: { path: string; data: Buffer }[], k: Buffer) => Buffer;
      open: (b: Buffer, k: Buffer) => { path: string; data: Buffer }[];
    };
    const key = mod.parseKey(Buffer.alloc(32, 7).toString('base64'));
    expect(() => mod.parseKey(undefined)).toThrow(/not set/);
    expect(() => mod.parseKey('c2hvcnQ=')).toThrow(/32 bytes/);
    const co = tmp('greenlight-evo-seal-');
    const put = (rel: string, body: string) => {
      mkdirSync(join(co, rel, '..'), { recursive: true });
      writeFileSync(join(co, rel), body);
    };
    put('.greenlight/bench/iterations/iter-x/state.json', '{"v":1}');
    put('.greenlight/bench/iterations/iter-x/.lock', 'lock');
    put('.greenlight/bundle-keys/k.json', 'secret');
    put('wiki/ledger.jsonl', '');
    put('wiki/patterns/p.md', 'page');
    const files = mod.collect(co);
    expect(files.map((f) => f.path).sort()).toEqual([
      '.greenlight/bench/iterations/iter-x/state.json',
      'wiki/ledger.jsonl',
      'wiki/patterns/p.md',
    ]);
    const blob = mod.seal(files, key);
    expect(blob.includes(Buffer.from('iter-x'))).toBe(false); // nothing in the clear
    expect(mod.open(blob, key).map((f) => f.path)).toEqual(files.map((f) => f.path));
    // A wrong key, or any flipped byte, fails authentication.
    expect(() => mod.open(blob, Buffer.alloc(32, 8))).toThrow(/fails authentication/);
    const flipped = Buffer.from(blob);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
    expect(() => mod.open(flipped, key)).toThrow(/fails authentication/);
    // A well-sealed blob naming a path outside the state is refused all the same.
    const evil = mod.seal([{ path: 'package.json', data: Buffer.from('{}') }], key);
    expect(() => mod.open(evil, key)).toThrow(/names a path it may not/);
  });

  it('evo-restore: state paths, a byte-prefix valid ledger, and only untouched maintainer pages', async () => {
    const mod = (await import(join(REPO, 'scripts', 'evo-restore.mjs'))) as {
      restore: (
        a: string,
        c: string,
        o: { validateLedger: (t: string) => string[] },
      ) => { restored: string[]; skipped: string[] };
    };
    const validateLedger = (text: string) => {
      const { events, errors } = parseLedger(text);
      return [...errors.map((e) => e.message), ...ledgerProblems(events)];
    };
    const root = tmp('greenlight-evo-restore-');
    const art = join(root, 'artifact');
    const co = join(root, 'checkout');
    const put = (base: string, rel: string, body: string) => {
      mkdirSync(join(base, rel, '..'), { recursive: true });
      writeFileSync(join(base, rel), body);
    };
    const ev = (n: number) =>
      `${JSON.stringify(sealEvent({ ts: `2026-11-1${n}T00:00:00.000Z`, proposalId: `prop-00000000000${n}`, stage: 'no-action', change: { kind: 'no_action' }, reason: 'r' }))}\n`;
    // The checkout: a git repo whose base commit holds the pages.
    mkdirSync(co, { recursive: true });
    gitOut(co, 'init', '-q', '-b', 'main');
    put(co, 'wiki/ledger.jsonl', ev(1) + ev(2));
    put(co, 'wiki/patterns/p.md', 'base page\n');
    put(co, 'wiki/patterns/human.md', 'base human\n');
    put(co, 'package.json', '{"scripts":{"check-all":"pnpm test"}}');
    gitOut(co, 'add', '-A');
    gitOut(co, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    const baseCommit = gitOut(co, 'rev-parse', 'HEAD');
    const state = (writes: string[], base: string | null = baseCommit) =>
      JSON.stringify({
        v: 1,
        ...(base ? { baseCommit: base } : {}),
        maintainer: { writes: writes.map((path) => ({ path, sha256: 'x' })) },
      });
    put(art, '.greenlight/bench/iterations/iter-x/state.json', state(['patterns/p.md']));
    for (const rel of [
      '.greenlight/raw/r.json',
      '.greenlight/quota/m.json',
      'wiki/evidence/eval/abc.json',
      'wiki/patterns/human.md', // not a maintainer write: never restored
      // Never restored:
      '.greenlight/bundle-keys/k.json',
      '.greenlight/bench/iterations/iter-x/.lock',
      'package.json',
      'bench/gate.json',
      '.claude/skills/x/SKILL.md',
      'cli/src/bin.ts',
    ])
      put(art, rel, 'evil');
    put(art, 'wiki/patterns/p.md', 'maintainer page\n');
    put(art, 'wiki/ledger.jsonl', ev(1) + ev(2) + ev(3));
    const r = mod.restore(art, co, { validateLedger });
    expect(r.restored.sort()).toEqual(
      [
        '.greenlight/bench/iterations/iter-x/state.json',
        '.greenlight/quota/m.json',
        '.greenlight/raw/r.json',
        'wiki/evidence/eval/abc.json',
        'wiki/ledger.jsonl',
        'wiki/patterns/p.md',
      ].sort(),
    );
    expect(readFileSync(join(co, 'wiki/patterns/human.md'), 'utf8')).toBe('base human\n');
    expect(readFileSync(join(co, 'package.json'), 'utf8')).toContain('check-all');
    for (const rel of ['.greenlight/bundle-keys/k.json', 'bench/gate.json', 'cli/src/bin.ts'])
      expect(existsSync(join(co, rel))).toBe(false);

    const refused = (re: RegExp) => {
      const before = readFileSync(join(co, 'wiki/ledger.jsonl'));
      expect(() => mod.restore(art, co, { validateLedger })).toThrow(re);
      expect(readFileSync(join(co, 'wiki/ledger.jsonl')).equals(before)).toBe(true);
    };
    // A page a human committed since the base is never reverted.
    put(co, 'wiki/patterns/p.md', 'a human edit\n');
    refused(/changed in the checkout since the iteration's base commit/);
    put(co, 'wiki/patterns/p.md', 'base page\n');
    // Same eventIds but other bytes (a reordered key, a rewritten line) is not an extension.
    put(co, 'wiki/ledger.jsonl', `${ev(1).trim()} \n${ev(2)}`);
    refused(/does not extend the checkout's ledger byte for byte/);
    put(co, 'wiki/ledger.jsonl', ev(1) + ev(2));
    // An extension that does not parse, or breaks the stage machine, is refused.
    put(art, 'wiki/ledger.jsonl', `${ev(1) + ev(2)}{"eventId":"x"}\n`);
    refused(/is not a valid ledger/);
    put(art, 'wiki/ledger.jsonl', ev(1) + ev(2) + ev(2));
    refused(/is not a valid ledger/);
    put(art, 'wiki/ledger.jsonl', ev(1) + ev(2) + ev(3));
    // A state with pages to restore but no base commit refuses.
    put(art, '.greenlight/bench/iterations/iter-x/state.json', state(['patterns/p.md'], null));
    refused(/records no base commit/);
  });
});

describe('bench iterate without docker (process sandbox)', () => {
  it('train → maintainer → baseline refused; crash-resume after the seal, input drift and lock handling', async () => {
    const env = setup(false);
    const id = 'iter-test-process';
    const opts = (day: number, over: Partial<IterateOptions> = {}) =>
      env.options(day, { sandbox: 'process', ...over });

    // Day 0: train is sealed, then the maintainer's model has no quota left.
    env.fake.exhaust = { step: 'maintainer', model: FRONTIER };
    const r0 = await iterate(opts(0, { iterationId: id }));
    expect(r0.status, r0.message).toBe('deferred');
    expect(r0.step).toBe('maintainer');
    const s0 = loadIterationState(env.stateDir, id);
    expect(s0.train.status).toBe('done');
    expect(s0.pins?.skillSet).toBe(s0.acceptedSkillSetHash);
    const trainRecord = s0.train.record as string;
    const trainEval = s0.train.evaluationId as string;

    // A crash between the runner's seal and the state's save: the step must load the sealed
    // record (no rollout, no "already complete" wedge) instead of resuming it.
    const dir = iterationDir(env.stateDir, id);
    const crashed = { ...s0, status: 'running', step: 'train' } as IterationState;
    crashed.train = { status: 'deferred', evaluationId: trainEval };
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(crashed, null, 2)}\n`);
    const calls = env.fake.rolloutCalls;

    // Drift is refused before anything runs: the gate config, then the installed skills.
    const gate = join(env.bench, 'gate.json');
    const gateText = readFileSync(gate, 'utf8');
    writeFileSync(gate, '{ "alpha": 0.05, "runs": 2, "resamples": 1000 }\n');
    const drift = await iterate(opts(1, { resume: id }));
    expect(drift.exitCode).toBe(4);
    expect(drift.message).toMatch(/bench\/gate\.json changed/);
    writeFileSync(gate, gateText);
    const skillFile = join(env.skills, 'greenlight-wiki', 'SKILL.md');
    const skillText = readFileSync(skillFile, 'utf8');
    writeFileSync(skillFile, `${skillText}\ndrift\n`);
    const skillDrift = await iterate(opts(1, { resume: id }));
    expect(skillDrift.exitCode).toBe(4);
    expect(skillDrift.message).toMatch(/installed skills/);
    writeFileSync(skillFile, skillText);

    // Pins fail closed: a state missing a pin (here: from before bench/repro was pinned) is
    // refused, unless --adopt-pins adopts the missing one; a present pin is still compared.
    const unpinned = loadIterationState(env.stateDir, id);
    const { repro: _repro, ...fewer } = unpinned.pins as NonNullable<IterationState['pins']>;
    writeFileSync(
      join(dir, 'state.json'),
      `${JSON.stringify({ ...crashed, pins: fewer }, null, 2)}\n`,
    );
    const noPin = await iterate(opts(1, { resume: id }));
    expect(noPin.exitCode).toBe(4);
    expect(noPin.message).toMatch(/no pin for the trusted repros .*--adopt-pins/);
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(crashed, null, 2)}\n`);

    // A live lock on this host refuses; a dead holder's lock (or a reused pid, whose start time
    // differs) is stale and removed; a lock written on another host is refused unless
    // --break-lock says that run is gone.
    writeFileSync(join(dir, '.lock'), JSON.stringify({ host: hostname(), pid: process.ppid }));
    const locked = await iterate(opts(1, { resume: id }));
    expect(locked.exitCode).toBe(4);
    expect(locked.message).toMatch(/is running in process/);
    writeFileSync(
      join(dir, '.lock'),
      JSON.stringify({ host: hostname(), pid: process.ppid, start: 'not-its-start-time' }),
    );
    const reused = acquireLock(dir);
    reused();
    expect(existsSync(join(dir, '.lock'))).toBe(false);
    writeFileSync(join(dir, '.lock'), JSON.stringify({ host: 'another-runner', pid: 1 }));
    const foreign = await iterate(opts(1, { resume: id }));
    expect(foreign.exitCode).toBe(4);
    expect(foreign.message).toMatch(/on host another-runner.*--break-lock/);
    expect(existsSync(join(dir, '.lock'))).toBe(true);
    const logs: string[] = [];
    env.fake.exhaust = null;
    const r1 = await iterate(opts(1, { resume: id, breakLock: true, log: (x) => logs.push(x) }));
    expect(logs.join('\n')).toMatch(/breaking the lock of process 1 on host another-runner/);
    expect(existsSync(join(dir, '.lock'))).toBe(false);

    // The sealed train record was loaded, not re-run; the maintainer applied; the baseline is
    // refused by policy (the process sandbox cannot produce val evidence, 06 §4.2).
    expect(env.fake.rolloutCalls - calls).toBe(0);
    const s1 = loadIterationState(env.stateDir, id);
    expect(s1.train.record).toBe(trainRecord);
    expect(s1.maintainer.applied).toBe(true);
    expect(r1.status, r1.message).toBe('blocked');
    expect(r1.step).toBe('baseline');
    expect(r1.exitCode).toBe(4);
    expect(r1.message).toMatch(/process sandbox/);
  }, 300_000);
});
