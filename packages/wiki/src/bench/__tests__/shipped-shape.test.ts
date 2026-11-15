import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expand, identityTasksFor } from '../../__tests__/fixtures/policy/vectors';
import { type EvaluationRecord, sealRecord } from '../../schema/bench';
import { LedgerEventSchema } from '../../schema/ledger';
import {
  type GateContext,
  controlOutcome,
  decide,
  loadGateConfig,
  rejectedForReplayRegression,
} from '../gate';
import { type BlastRadius, type PolicyTask, applyPolicy, lossBound } from '../policy';
import { choose } from '../stats';

/**
 * The gate on the bench AS SHIPPED (06 §5.2), with 3 runs on 2 models. The boundary vectors (10
 * capability tasks, injected p-values) never exercised these shapes. Two of them are tested:
 *
 * - FIRST: the four val tasks of the first sealed baseline, two replay (the safety constraint)
 *   and two objective, ONE per skill. Every slice has one task, so every proposal is
 *   `underpowered`. This is also the shape of the gate while the two later families are still
 *   `pending` (a pending task is in no slice, 06 §4.1).
 * - ALL: every val task in `bench/splits.json`, active: the same four plus a second objective
 *   family per skill (`loop/new-route-joins-verify`, `wiki/contradicted-root-cause`). Every
 *   slice has two tasks and an attainable minimum p of 1/400.
 */

const F = 'model-frontier';
const S = 'model-small';
const H = (c: string) => c.repeat(64);
const KEEPALIVE = 'replay/keepalive-probe-reaches-store-val';
const IDLE = 'replay/idle-probe-leaves-store-asleep-val';
const WIKI = 'wiki/probe-layer-incidents-val';
const LOOP = 'loop/fixture-preview-before-push-val';

const splits = JSON.parse(
  readFileSync(new URL('../../../../../bench/splits.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const VAL = Object.keys(splits).filter((id) => splits[id] === 'val');

const LOOP_ROUTE = 'loop/new-route-joins-verify-val';
const WIKI_SUPERSEDE = 'wiki/contradicted-root-cause-val';

/** Every committed val task spec, active (as a sealed baseline that covers it runs it). */
const ALL: PolicyTask[] = VAL.map((id) => {
  const spec = JSON.parse(
    readFileSync(new URL(`../../../../../bench/tasks/${id}/task.json`, import.meta.url), 'utf8'),
  );
  return { id: spec.id, kind: spec.kind, state: 'active', modes: spec.modes, skills: spec.skills };
});
/** The four tasks of the first sealed baseline: one objective task per skill. */
const FIRST: PolicyTask[] = ALL.filter((t) => [KEEPALIVE, IDLE, WIKI, LOOP].includes(t.id));
const gateConfig = loadGateConfig(
  JSON.parse(readFileSync(new URL('../../../../../bench/gate.json', import.meta.url), 'utf8')),
);
/** The same shape with one skill that both objective tasks exercise: a two-task slice. */
const SHARED = 'shared-skill';
const TWO_TASK_SLICE: PolicyTask[] = FIRST.map((t) =>
  t.kind === 'replay' ? t : { ...t, skills: [...(t.skills ?? []), SHARED] },
);

type World = Record<string, number>;
type Worlds = { [model: string]: World };
const world = (keepalive: number, idle: number, wiki: number, loop: number): World => ({
  [KEEPALIVE]: keepalive,
  [IDLE]: idle,
  [WIKI]: wiki,
  [LOOP]: loop,
});
/** The sealed M2 baseline (record 8b78a1ea…): every objective cell 0/3, both replays failing, one
 * of them 1/3 on the frontier model. */
const SEALED: Worlds = { [F]: world(1, 0, 0, 0), [S]: world(0, 0, 0, 0) };
const both = (w: World): Worlds => ({ [F]: w, [S]: w });

function record(
  side: 'base' | 'cand',
  worlds: Worlds,
  tasks: readonly PolicyTask[],
  proposalId = 'prop-1',
): EvaluationRecord {
  return sealRecord({
    identity: {
      taskSetHash: H('1'),
      tasks: identityTasksFor(tasks),
      splitsHash: H('2'),
      graderSetHash: H('3'),
      depsHash: H('4'),
      harness: {
        runnerVersion: '1.0.0',
        imageDigest: 'sha256:abc',
        limits: { maxSteps: 15, requestsPerRollout: 17, timeoutMin: null },
      },
      agent: { vendor: 'greenlight-harness', version: '0.1.0' },
      models: [F, S],
      modelsConfigHash: H('9'),
      skillSetHash: side === 'base' ? H('a') : H('b'),
      mode: 'isolation',
      wikiSnapshotHash: null,
      proxyPolicyHash: null,
    },
    role: side === 'base' ? 'baseline' : 'candidate',
    proposalId: side === 'cand' ? proposalId : undefined,
    createdAt: '2026-10-30T12:00:00.000Z',
    outcomes: [F, S].flatMap((m) => expand(worlds[m] as World, m, 'isolation')),
  });
}

function gate(
  base: Worlds,
  cand: Worlds,
  over: Partial<GateContext> & { tasks?: readonly PolicyTask[] } = {},
) {
  const tasks = over.tasks ?? FIRST;
  const ctx: GateContext = {
    ts: '2026-11-01T12:00:00.000Z',
    radius: 'medium',
    path: 'standard',
    models: { frontier: F, small: S },
    acceptedSkillSetHash: H('a'),
    modes: ['isolation'],
    skill: SHARED,
    ...over,
    tasks,
  };
  return decide(record('base', base, tasks), record('cand', cand, tasks), ctx);
}

const codes = (d: { reasons: { code: string }[] }) => d.reasons.map((r) => r.code);

describe('the first sealed baseline: four val tasks', () => {
  it('is 2 objective tasks and 2 replay tasks, and no skill has more than one objective task', () => {
    expect(FIRST.map((t) => t.kind).sort()).toEqual(['loop', 'replay', 'replay', 'wiki']);
    const objective = FIRST.filter((t) => t.kind !== 'replay');
    const skills = [...new Set(FIRST.flatMap((t) => [...(t.skills ?? [])]))];
    for (const skill of skills) {
      expect(objective.filter((t) => t.skills?.includes(skill)).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('the shipped val split, once every task is active', () => {
  const objective = ALL.filter((t) => t.kind !== 'replay');
  /** Skills that have an objective task: the ones a gate can test at all. */
  const skills = [...new Set(objective.flatMap((t) => [...(t.skills ?? [])]))].sort();
  /** Replay tasks pass `replay` of 3, objective tasks `obj(task)` of 3. */
  const six = (replay: number, obj: (id: string) => number): World =>
    Object.fromEntries(ALL.map((t) => [t.id, t.kind === 'replay' ? replay : obj(t.id)]));
  const zero = both(six(3, () => 0));

  it('is 4 objective tasks and 2 replay tasks, and each gateable skill has exactly two', () => {
    expect(ALL.map((t) => t.kind).sort()).toEqual([
      'loop',
      'loop',
      'replay',
      'replay',
      'wiki',
      'wiki',
    ]);
    expect(skills).toEqual(['deploy-verify-promote', 'greenlight-wiki']);
    expect(
      objective.filter((t) => t.skills?.includes('deploy-verify-promote')).map((t) => t.id),
    ).toEqual([LOOP, LOOP_ROUTE]);
    expect(objective.filter((t) => t.skills?.includes('greenlight-wiki')).map((t) => t.id)).toEqual(
      [WIKI_SUPERSEDE, WIKI],
    );
    // 4 objective tasks × 3 runs: a model may still lose one pass, no more (06 §5.4)
    expect(lossBound(objective.length * gateConfig.runs)).toBe(1);
  });

  it("every skill's slice has an attainable minimum p below alpha (1/400 at 3 runs)", () => {
    expect(gateConfig.runs).toBe(3);
    for (const skill of skills) {
      const slice = objective.filter((t) => t.skills?.includes(skill));
      const inSlice = (id: string) => slice.some((t) => t.id === id);
      // 0/3 → 3/3 on the slice, nothing else moves; high radius so both models are tested.
      const d = gate(zero, both(six(3, (id) => (inSlice(id) ? 3 : 0))), {
        tasks: ALL,
        skill,
        radius: 'high',
        config: gateConfig,
      });
      expect(d.reasons.find((r) => r.code === 'efficacy-slice')?.detail, skill).toBe(
        `${skill}: ${slice.map((t) => t.id).join(', ')}`,
      );
      expect(d.results, skill).toHaveLength(2);
      for (const r of d.results) {
        expect(r.capability.minP, skill).toBe(1 / 400);
        expect(r.capability.minP as number).toBeLessThan(gateConfig.alpha);
        expect(r.capability.pValue, skill).toBe(1 / 400);
      }
      expect(codes(d)).not.toContain('underpowered');
      expect(d.decision, skill).toBe('accept');
    }
  });

  it('a slice gain of 2/3 on both tasks is accepted; one task alone is not', () => {
    for (const skill of skills) {
      const slice = objective.filter((t) => t.skills?.includes(skill)).map((t) => t.id);
      const gain = (passes: number[]) =>
        gate(zero, both(six(3, (id) => passes[slice.indexOf(id)] ?? 0)), {
          tasks: ALL,
          skill,
          config: gateConfig,
        });
      expect(gain([2, 2]).decision, skill).toBe('accept'); // p = 0.04
      const one = gain([3, 0]); // p = 0.05: not below alpha
      expect(one.decision, skill).toBe('reject');
      expect(codes(one)).toContain('not-significant');
    }
  });

  it('with the second family still pending, the slice is one task and underpowered', () => {
    // A pending task is not in the gate's task list (06 §4.1): the FIRST shape.
    for (const skill of skills) {
      const d = gate(both(world(3, 3, 0, 0)), both(world(3, 3, 3, 3)), {
        skill,
        config: gateConfig,
      });
      expect(d.decision, skill).toBe('underpowered');
      expect(d.results[0]?.capability.minP).toBe(1 / 20);
    }
  });
});

describe('the slice rule (06 §5.2, §5.6)', () => {
  const perfect = both(world(3, 3, 3, 3));
  const zero = both(world(3, 3, 0, 0));

  it('only objective tasks that exercise the patched skill count toward efficacy', () => {
    // The loop task goes 0/3 → 3/3 on both models; the wiki task does not move. Patching
    // deploy-verify-promote (the loop task's skill), that is the whole slice.
    const d = gate(zero, both(world(3, 3, 0, 3)), { skill: 'deploy-verify-promote' });
    expect(d.reasons.find((r) => r.code === 'efficacy-slice')?.detail).toBe(
      `deploy-verify-promote: ${LOOP}`,
    );
    for (const r of d.results) {
      expect(r.capability).toMatchObject({ before: 0, after: 1, delta: 1 });
      expect(r.capability.pValue).toBe(1 / 20);
    }
    // The same outcomes, attributed to the wiki task's skill: the slice did not move at all.
    const w = gate(zero, both(world(3, 3, 0, 3)), { skill: 'greenlight-wiki' });
    expect(w.reasons.find((r) => r.code === 'efficacy-slice')?.detail).toBe(
      `greenlight-wiki: ${WIKI}`,
    );
    for (const r of w.results) expect(r.capability).toMatchObject({ before: 0, after: 0 });
  });

  it('a one-task slice × 3 runs is underpowered: no decision, however good the candidate', () => {
    for (const skill of ['deploy-verify-promote', 'greenlight-wiki']) {
      const d = gate(zero, perfect, { skill });
      expect(d.decision, skill).toBe('underpowered');
      expect(d.ledgerEvent).toBeNull();
      expect(d.gateInput).toBeNull();
      expect(d.reasons.some((r) => r.severity === 'fail')).toBe(false);
      const why = d.reasons.filter((r) => r.code === 'underpowered');
      // medium radius: the strict test is on frontier only
      expect(why).toHaveLength(1);
      expect(why[0]).toMatchObject({ severity: 'blocked', model: F, mode: 'isolation' });
      expect(why[0]?.detail).toMatch(
        /attainable minimum p 0\.05 ≥ 0\.05: 1 slice task\(s\) × 3 runs/,
      );
      expect(d.results[0]?.capability.minP).toBe(1 / 20);
    }
    // One task, one extra pass: the bootstrap gave p = 0 and accepted this.
    const one = gate(zero, both(world(3, 3, 0, 1)), { skill: 'deploy-verify-promote' });
    expect(one.decision).toBe('underpowered');
  });

  it('a skill no objective task exercises has no slice: underpowered (no-slice)', () => {
    const d = gate(zero, perfect, { skill: 'provider-neon' });
    expect(d.decision).toBe('underpowered');
    expect(d.reasons).toContainEqual(
      expect.objectContaining({ code: 'no-slice', severity: 'blocked', model: F }),
    );
    expect(d.results[0]?.capability).toMatchObject({ pValue: null, minP: null });
  });

  it('replay safety still uses EVERY replay task, whatever the slice', () => {
    // provider-neon's slice is empty, and the regressing replay does not list greenlight-wiki
    // either: the regression still rejects.
    for (const skill of ['provider-neon', 'greenlight-wiki']) {
      const d = gate(zero, both(world(0, 3, 3, 3)), { skill });
      expect(d.decision, skill).toBe('reject');
      expect(rejectedForReplayRegression(d, KEEPALIVE)).toBe(true);
      expect(d.results.every((r) => r.replay.total === 2)).toBe(true);
      // the cell that could not be tested is reported, as information
      expect(d.reasons.some((r) => r.severity === 'blocked')).toBe(false);
    }
  });

  it('a saturated baseline is underpowered too: nothing could improve on it', () => {
    // Two-task slice, baseline 2/3 and 1/3: the best candidate gives p = 0.1.
    const d = gate(both(world(3, 3, 2, 1)), both(world(3, 3, 3, 3)), { tasks: TWO_TASK_SLICE });
    expect(d.decision).toBe('underpowered');
    expect(d.results[0]?.capability.minP).toBeCloseTo(0.1, 12);
  });
});

describe('a two-task slice × 3 runs: the smallest shape that can decide', () => {
  const tasks = TWO_TASK_SLICE;
  const base = both(world(3, 3, 0, 0));

  it('the attainable minimum is 1/400, reached by 0/3 → 3/3 on both tasks', () => {
    const d = gate(base, both(world(3, 3, 3, 3)), { tasks, radius: 'high' });
    expect(d.decision).toBe('accept');
    for (const r of d.results) {
      expect(r.capability.pValue).toBe(1 / 400);
      expect(r.capability.minP).toBe(1 / 400);
    }
    LedgerEventSchema.parse(d.ledgerEvent);
    expect(d.gateInput?.algorithm).toBe(2);
  });

  it('decides on rollouts, not on the sign of two task means', () => {
    // Both task means improve (the bootstrap: p = 0, accept). Exactly: p = 1/4.
    const weak = gate(base, both(world(3, 3, 1, 1)), { tasks });
    expect(weak.decision).toBe('reject');
    expect(weak.results[0]?.capability.pValue).toBe(0.25);
    expect(codes(weak)).toContain('not-significant');
    expect(codes(weak)).not.toContain('no-strict-improvement');
    // 2/3 on both: p = 0.04.
    expect(gate(base, both(world(3, 3, 2, 2)), { tasks }).decision).toBe('accept');
    // 3/3 on one task only: p = 0.05, not below alpha.
    const oneTask = gate(base, both(world(3, 3, 3, 0)), { tasks });
    expect(oneTask.decision).toBe('reject');
    expect(oneTask.results[0]?.capability.pValue).toBe(0.05);
  });

  /** P(accept) for identical arms at pass rate θ: every baseline × candidate pass-count table of
   * the frontier model's two slice tasks, weighted by its binomial probability. */
  function typeOne(theta: number, radius: BlastRadius): number {
    const w = (k: number) => Number(choose(3, k)) * theta ** k * (1 - theta) ** (3 - k);
    let accepted = 0;
    for (let b1 = 0; b1 <= 3; b1++)
      for (let b2 = 0; b2 <= 3; b2++)
        for (let c1 = 0; c1 <= 3; c1++)
          for (let c2 = 0; c2 <= 3; c2++) {
            const pr = w(b1) * w(b2) * w(c1) * w(c2);
            if (pr === 0) continue;
            const baseW = world(3, 3, b1, b2);
            const candW = world(3, 3, c1, c2);
            const out = applyPolicy({
              radius,
              path: 'standard',
              models: { frontier: F, small: S },
              modes: ['isolation'],
              declaredModes: ['isolation'],
              tasks,
              skill: SHARED,
              // the small model mirrors the frontier's tables, so at high radius it agrees
              baseline: [F, S].flatMap((m) => expand(baseW, m, 'isolation')),
              candidate: [F, S].flatMap((m) => expand(candW, m, 'isolation')),
            });
            if (out.decision === 'accept') accepted += pr;
          }
    return accepted;
  }

  it('type-I rate with identical arms stays below alpha at every pass rate (max 1.93%)', () => {
    const rates = [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => typeOne(t, 'medium'));
    expect(rates[0]).toBeCloseTo(0.0007, 4);
    expect(rates[1]).toBeCloseTo(0.0118, 4);
    expect(rates[2]).toBeCloseTo(0.0193, 4);
    expect(rates[3]).toBeCloseTo(0.0118, 4);
    expect(rates[4]).toBeCloseTo(0.0007, 4);
    for (const r of rates) expect(r).toBeLessThan(0.05);
    // identical arms that never pass, or always pass, are never accepted
    expect(typeOne(0, 'high')).toBe(0);
    expect(typeOne(1, 'high')).toBe(0);
  });
});

describe('the sealed baseline pattern: objective 0/3 everywhere, one replay 1/3 on frontier', () => {
  it('high radius: a flaky baseline replay task blocks the gate; it is not a rejection', () => {
    // A perfect candidate and a terrible one get the same answer: the baseline is not gateable.
    for (const cand of [both(world(3, 3, 3, 3)), both(world(0, 0, 0, 0))]) {
      const d = gate(SEALED, cand, { radius: 'high', skill: 'deploy-verify-promote' });
      expect(d.decision).toBe('blocked');
      expect(d.ledgerEvent).toBeNull();
      expect(d.gateInput).toBeNull();
      expect(d.reasons.some((r) => r.severity === 'fail')).toBe(false);
      const why = d.reasons.filter((r) => r.severity === 'blocked');
      expect(why).toEqual([
        {
          code: 'flaky-baseline',
          severity: 'blocked',
          model: F,
          mode: 'isolation',
          task: KEEPALIVE,
          detail: `baseline 1/3: fix or quarantine ${KEEPALIVE}, then re-baseline; this says nothing about the candidate`,
        },
      ]);
    }
  });

  it('below high radius: safety is vacuous, and the decision says so', () => {
    const d = gate(SEALED, both(world(0, 0, 3, 3)), { tasks: TWO_TASK_SLICE });
    // No replay task is baseline-passing on either model, so "no regression" proves nothing:
    // the candidate fails both replays in every run and is still accepted on efficacy.
    expect(d.decision).toBe('accept');
    const vacuous = d.reasons.filter((r) => r.code === 'safety-vacuous');
    expect(vacuous.map((r) => `${r.model}/${r.mode}`)).toEqual([
      `${F}/isolation`,
      `${S}/isolation`,
    ]);
    expect(vacuous[0]?.detail).toBe(
      '0 of 2 replay task(s) baseline-passing: the replay constraint cannot fail here',
    );
    expect(d.results.every((r) => r.replay.baselinePassing === 0)).toBe(true);
    // ... in the ledger row itself, not only in the reasons
    expect(d.ledgerEvent?.reason).toBe(
      `replay safety vacuous (no baseline-passing replay task) on ${F}/isolation, ${S}/isolation`,
    );
    // each replay task that cannot regress is named
    expect(
      d.reasons.filter((r) => r.code === 'replay-baseline-failing').map((r) => r.task),
    ).toEqual([IDLE, KEEPALIVE, IDLE, KEEPALIVE]);
    // With a baseline-passing replay there is nothing to surface.
    const real = gate(both(world(3, 3, 0, 0)), both(world(3, 3, 3, 3)), { tasks: TWO_TASK_SLICE });
    expect(codes(real)).not.toContain('safety-vacuous');
    expect(real.ledgerEvent?.reason).toBeUndefined();
  });

  it('the control arm is inconclusive, not failed: its replay cannot regress from 0/3', () => {
    // The overgeneral control makes the idle probe query the store: the Neon replay fails.
    const control = both(world(0, 0, 0, 0));
    // As shipped (high radius): blocked by the flaky baseline, so no safety verdict at all.
    const high = gate(SEALED, control, { radius: 'high', skill: 'deploy-verify-promote' });
    expect(rejectedForReplayRegression(high, IDLE)).toBe(false);
    expect(controlOutcome(high, IDLE)).toBe('inconclusive');
    // With the flaky task settled at 0/3: still nothing baseline-passing, so still inconclusive.
    const zero = both(world(0, 0, 0, 0));
    const vacuous = gate(zero, both(world(0, 0, 0, 1)), {
      radius: 'high',
      skill: 'deploy-verify-promote',
    });
    expect(vacuous.decision).toBe('underpowered');
    expect(controlOutcome(vacuous, IDLE)).toBe('inconclusive');
    // Once the baseline passes the replay, the control is decided: met when it regresses ...
    const passing = both(world(3, 3, 0, 0));
    const met = gate(passing, both(world(3, 0, 0, 0)), {
      radius: 'high',
      skill: 'deploy-verify-promote',
    });
    expect(met.decision).toBe('reject');
    expect(controlOutcome(met, IDLE)).toBe('met');
    // ... and NOT met when the gate lets it through for that reason.
    const missed = gate(passing, both(world(3, 3, 0, 0)), {
      radius: 'high',
      skill: 'deploy-verify-promote',
    });
    expect(controlOutcome(missed, IDLE)).toBe('not-met');
    // Baseline-passing on one model only is enough for the control to be decidable.
    const half = gate({ [F]: world(3, 3, 0, 0), [S]: world(3, 0, 0, 0) }, both(world(3, 3, 0, 0)), {
      skill: 'deploy-verify-promote',
    });
    expect(controlOutcome(half, IDLE)).toBe('not-met');
  });
});

describe('non-regression in passes (06 §5.4)', () => {
  it('the bound is max(1 pass, 10% of the objective rollouts)', () => {
    expect(lossBound(6)).toBe(1); // the first baseline: 2 objective tasks × 3 runs
    expect(lossBound(12)).toBe(1); // the shipped split, all active: 4 objective tasks × 3 runs
    expect(lossBound(9)).toBe(1);
    expect(lossBound(20)).toBe(2);
    expect(lossBound(30)).toBe(3); // 10 tasks × 3 runs: the old "one task-mean"
    expect(lossBound(60)).toBe(6);
  });

  it('medium radius: the small model may lose one pass of six, not half its capability', () => {
    const base: Worlds = { [F]: world(3, 3, 0, 0), [S]: world(3, 3, 3, 3) };
    const cand = (wiki: number, loop: number): Worlds => ({
      [F]: world(3, 3, 3, 3),
      [S]: world(3, 3, wiki, loop),
    });
    const tasks = TWO_TASK_SLICE;
    expect(gate(base, cand(3, 2), { tasks }).decision).toBe('accept'); // −1 pass
    // −3 passes: 1.0 → 0.5 on the small model. "One task-mean" (3 passes at N = 2) accepted this.
    const half = gate(base, cand(3, 0), { tasks });
    expect(half.decision).toBe('reject');
    expect(half.reasons).toContainEqual(
      expect.objectContaining({
        code: 'capability-regression',
        model: S,
        detail: 'Δ -3 passes over 2 tasks × 3 runs; at most 1 may be lost',
      }),
    );
    expect(gate(base, cand(2, 2), { tasks }).decision).toBe('reject'); // −2 passes
  });

  it('a gain on the slice does not excuse a loss on the rest of the bench', () => {
    // The slice is the loop task alone; the off-slice wiki task collapses (3/3 → 0/3) while the
    // loop task gains one pass: −2 passes over the objective set, beyond the bound of 1.
    const split: PolicyTask[] = FIRST.map((t) => (t.id === LOOP ? { ...t, skills: [SHARED] } : t));
    const d = gate(both(world(3, 3, 3, 2)), both(world(3, 3, 0, 3)), { tasks: split });
    expect(d.decision).toBe('reject');
    expect(codes(d)).toContain('capability-regression');
    // The slice itself was too small to test: reported, but the rejection stands without it.
    expect(d.reasons).toContainEqual(
      expect.objectContaining({ code: 'underpowered', severity: 'info' }),
    );
  });
});
