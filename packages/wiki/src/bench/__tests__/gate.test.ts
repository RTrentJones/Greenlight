import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CELLS,
  F,
  S,
  TASKS,
  cleanCell,
  expand,
  identityTasksFor,
} from '../../__tests__/fixtures/policy/vectors';
import {
  type BaselineIdentity,
  type EvaluationRecord,
  GateInputRecordSchema,
  sealGateInput,
  sealRecord,
} from '../../schema/bench';
import { LedgerEventSchema } from '../../schema/ledger';
import {
  GateConfigSchema,
  type GateContext,
  GateHarnessError,
  decide,
  earlyStopEvent,
  loadGateConfig,
  recompute,
  rejectedForReplayRegression,
  releaseCheck,
  sameDecision,
} from '../gate';
import type { PolicyTask } from '../policy';
import type { GateMode } from '../stats';

const H = (c: string) => c.repeat(64);
const TS = '2026-11-01T12:00:00.000Z';
const CREATED = '2026-10-30T12:00:00.000Z';
const LIMITS = { maxSteps: 15, requestsPerRollout: 17, timeoutMin: null };

function identity(
  mode: GateMode,
  skillSet = H('a'),
  tasks: readonly PolicyTask[] = TASKS,
): BaselineIdentity {
  return {
    taskSetHash: H('1'),
    tasks: identityTasksFor(tasks),
    splitsHash: H('2'),
    graderSetHash: H('3'),
    depsHash: H('4'),
    harness: { runnerVersion: '1.0.0', imageDigest: 'sha256:abc', limits: LIMITS },
    agent: { vendor: 'greenlight-harness', version: '0.1.0' },
    models: [F, S],
    skillSetHash: skillSet,
    mode,
    wikiSnapshotHash: mode === 'production' ? H('5') : null,
    proxyPolicyHash: null,
  };
}

type Side = 'base' | 'cand';
function record(
  side: Side,
  mode: GateMode,
  edit?: (w: Record<string, number>, model: string) => void,
  over: Partial<Omit<EvaluationRecord, 'hash'>> = {},
): EvaluationRecord {
  const outcomes = CELLS.filter((c) => c.mode === mode).flatMap((c) => {
    const w = { ...cleanCell(mode)[side] };
    edit?.(w, c.model);
    return expand(w, c.model, mode);
  });
  return sealRecord({
    identity: identity(mode, side === 'base' ? H('a') : H('b')),
    role: side === 'base' ? 'baseline' : 'candidate',
    proposalId: side === 'cand' ? 'prop-1' : undefined,
    createdAt: CREATED,
    outcomes,
    ...over,
  });
}

/** Reseals a record with an identity change. */
function withIdentity(r: EvaluationRecord, change: Partial<BaselineIdentity>): EvaluationRecord {
  const { hash: _h, ...rest } = r;
  return sealRecord({ ...rest, identity: { ...rest.identity, ...change } });
}

const ctx: GateContext = {
  ts: TS,
  radius: 'medium',
  path: 'standard',
  models: { frontier: F, small: S },
  tasks: TASKS,
  acceptedSkillSetHash: H('a'),
  skill: 'deploy-verify-promote',
};
/** The M1/M2 posture: isolation only, declared explicitly (06 §5.1). */
const isoCtx: GateContext = { ...ctx, modes: ['isolation'] };

const baseIso = record('base', 'isolation');
const baseProd = record('base', 'production');
const candIso = record('cand', 'isolation');
const candProd = record('cand', 'production');

function harnessError(fn: () => unknown): GateHarnessError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GateHarnessError);
    return e as GateHarnessError;
  }
  throw new Error('expected a GateHarnessError');
}

describe('decide', () => {
  it('accepts and builds a sealed candidate-accepted event with one result per model × mode', () => {
    const d = decide([baseIso, baseProd], [candIso, candProd], ctx);
    expect(d.decision).toBe('accept');
    expect(d.seed).toBe('gate:prop-1');
    const e = d.ledgerEvent;
    if (!e || !d.gateInput) throw new Error('no event');
    LedgerEventSchema.parse(e);
    GateInputRecordSchema.parse(d.gateInput);
    expect(e.stage).toBe('candidate-accepted');
    expect(e.path).toBe('standard');
    expect(e.proposalId).toBe('prop-1');
    expect(e.evidence).toMatchObject({
      kind: 'bench',
      gateInput: d.gateInput.hash,
      evaluationRecords: [baseIso.hash, baseProd.hash, candIso.hash, candProd.hash].sort(),
    });
    expect(
      e.evidence?.kind === 'bench' && e.evidence.results.map((r) => `${r.model}/${r.mode}`),
    ).toEqual([`${F}/isolation`, `${F}/production`, `${S}/isolation`, `${S}/production`]);
    expect(d.gateInput).toMatchObject({
      modes: ['isolation', 'production'],
      modesDeclared: false,
      acceptedSkillSetHash: H('a'),
      candidateSkillSetHash: H('b'),
      baselineRecords: [baseIso.hash, baseProd.hash],
      candidateRecords: [candIso.hash, candProd.hash],
      config: { maxBaselineAgeDays: 30 },
    });
  });

  it('builds a candidate-rejected event with a machine-readable reason summary', () => {
    const bad = record('cand', 'isolation', (w, m) => {
      if (m === S) w['replay/a'] = 1;
    });
    const d = decide(baseIso, bad, isoCtx);
    expect(d.decision).toBe('reject');
    expect(d.ledgerEvent?.stage).toBe('candidate-rejected');
    expect(d.ledgerEvent?.reason).toContain(`replay-regression (${S}/isolation/replay/a)`);
    expect(rejectedForReplayRegression(d, 'replay/a')).toBe(true);
    expect(rejectedForReplayRegression(d, 'replay/b')).toBe(false);
  });

  it('labels the neutral path and records the human reason', () => {
    const flat = record('cand', 'isolation', (w) => {
      Object.assign(w, cleanCell('isolation').base);
    });
    const d = decide(baseIso, flat, {
      ...isoCtx,
      path: 'neutral',
      neutralReason: 'prerequisite for prop-2',
    });
    expect(d.decision).toBe('accept');
    expect(d.ledgerEvent).toMatchObject({ path: 'neutral', reason: 'prerequisite for prop-2' });
    const without = decide(baseIso, flat, { ...isoCtx, path: 'neutral' });
    expect(without.decision).toBe('reject');
    LedgerEventSchema.parse(without.ledgerEvent);
  });

  it('returns invalid with no ledger event when a rollout was fallback-served', () => {
    const outcomes = candIso.outcomes.map((o, i) => (i === 0 ? { ...o, servedBy: 'fallback' } : o));
    const { hash: _h, ...rest } = candIso;
    const fb = sealRecord({ ...rest, outcomes });
    const d = decide(baseIso, fb, isoCtx);
    expect(d.decision).toBe('invalid');
    expect(d.ledgerEvent).toBeNull();
    expect(d.gateInput).toBeNull();
    expect(d.results).toEqual([]);
    expect(d.reasons.map((r) => r.code)).toContain('fallback-served');
  });

  describe('identity mismatch is a harness error, never a result (06 §1.5)', () => {
    const changes: [string, Partial<BaselineIdentity>][] = [
      ['taskSetHash', { taskSetHash: H('9') }],
      [
        'tasks',
        {
          tasks: identityTasksFor(TASKS).map((t) =>
            t.id === 'cap/c1' ? { ...t, graders: ['app' as const, 'trajectory' as const] } : t,
          ),
        },
      ],
      ['depsHash', { depsHash: H('9') }],
      ['models', { models: [F, 'model-other'] }],
      [
        'harness',
        { harness: { runnerVersion: '2.0.0', imageDigest: 'sha256:abc', limits: LIMITS } },
      ],
      // The rollout limits are identity (06 §1.5): a 20-step candidate never meets a 15-step
      // baseline.
      [
        'harness',
        {
          harness: {
            runnerVersion: '1.0.0',
            imageDigest: 'sha256:abc',
            limits: { ...LIMITS, maxSteps: 20 },
          },
        },
      ],
      ['proxyPolicyHash', { proxyPolicyHash: H('9') }],
    ];
    it.each(changes)('%s', (field, change) => {
      const err = harnessError(() => decide(baseIso, withIdentity(candIso, change), isoCtx));
      expect(err.fields).toEqual([field]);
      expect(err.message).toContain(field);
    });
    it('names every differing field', () => {
      const cand = withIdentity(candIso, { splitsHash: H('8'), graderSetHash: H('7') });
      expect(() => decide(baseIso, cand, isoCtx)).toThrow(/splitsHash, graderSetHash/);
    });
    it('the skill set alone may differ', () => {
      expect(baseIso.identity.skillSetHash).not.toBe(candIso.identity.skillSetHash);
      expect(() => decide(baseIso, candIso, isoCtx)).not.toThrow();
    });
  });

  describe('every record of a gate belongs to one comparison (finding: cross-mode identity)', () => {
    it('refuses candidate records of two skill sets (isolation ≠ production)', () => {
      const prod = withIdentity(candProd, { skillSetHash: H('c') });
      const err = harnessError(() => decide([baseIso, baseProd], [candIso, prod], ctx));
      expect(err.fields).toEqual(['skillSetHash']);
      expect(err.message).toMatch(/candidate records span 2 skill sets/);
    });
    it('refuses baseline records of two skill sets', () => {
      const prod = withIdentity(baseProd, { skillSetHash: H('c') });
      expect(() => decide([baseIso, prod], [candIso, candProd], ctx)).toThrow(
        /baseline records span 2 skill sets/,
      );
    });
    it('refuses a candidate whose skill set equals the baseline', () => {
      const same = withIdentity(candIso, { skillSetHash: H('a') });
      expect(() => decide(baseIso, same, isoCtx)).toThrow(/no change to evaluate/);
    });
    it('refuses a baseline that is not the accepted skill set', () => {
      expect(() => decide(baseIso, candIso, { ...isoCtx, acceptedSkillSetHash: H('d') })).toThrow(
        /not the accepted skill set/,
      );
    });
    it('refuses modes whose identities differ in a non-mode field, even if each mode pairs', () => {
      // production pairs with itself (same depsHash on both sides) but disagrees with isolation.
      const bp = withIdentity(baseProd, { depsHash: H('9') });
      const cp = withIdentity(candProd, { depsHash: H('9') });
      const err = harnessError(() => decide([baseIso, bp], [candIso, cp], ctx));
      expect(err.fields).toEqual(['depsHash']);
    });
    it('refuses two records for one mode on one side', () => {
      const other = record('cand', 'isolation', (w) => {
        w['cap/c1'] = 2;
      });
      expect(() => decide(baseIso, [candIso, other], isoCtx)).toThrow(/more than one candidate/);
    });
  });

  describe('modes (finding: a missing mode is never silently skipped)', () => {
    it('is invalid when a mode the gated tasks declare is missing on both sides', () => {
      const d = decide(baseIso, candIso, ctx);
      expect(d.decision).toBe('invalid');
      expect(d.ledgerEvent).toBeNull();
      expect(d.reasons).toContainEqual(
        expect.objectContaining({ code: 'mode-missing', mode: 'production', severity: 'invalid' }),
      );
    });
    it('is invalid when a mode is missing on one side only', () => {
      for (const [b, c] of [
        [[baseIso, baseProd], [candIso]],
        [[baseIso], [candIso, candProd]],
      ] as const) {
        const d = decide([...b], [...c], ctx);
        expect(d.decision).toBe('invalid');
        expect(d.reasons.map((r) => r.code)).toContain('mode-missing');
      }
    });
    it('accepts an explicitly declared isolation-only evaluation and records the posture', () => {
      const d = decide(baseIso, candIso, isoCtx);
      expect(d.decision).toBe('accept');
      expect(d.gateInput).toMatchObject({ modes: ['isolation'], modesDeclared: true });
      expect(d.reasons).toContainEqual(
        expect.objectContaining({ code: 'modes-partial', severity: 'info' }),
      );
    });
    it('a declaration does not excuse a missing declared mode or extra records', () => {
      expect(
        decide(baseIso, candIso, { ...ctx, modes: ['isolation', 'production'] }).decision,
      ).toBe('invalid');
      const extra = decide([baseIso, baseProd], [candIso, candProd], isoCtx);
      expect(extra.decision).toBe('invalid');
      expect(extra.reasons.map((r) => r.code)).toContain('unknown-mode');
    });
    it('a declaration is validated against the tasks', () => {
      const isoTasks: PolicyTask[] = TASKS.map((t) => ({ ...t, modes: ['isolation'] }));
      const bind = (r: EvaluationRecord, tasks: PolicyTask[]) =>
        withIdentity(r, { tasks: identityTasksFor(tasks) });
      const iso = (r: EvaluationRecord) => bind(r, isoTasks);
      const prodOnly = decide([iso(baseIso), iso(baseProd)], [iso(candIso), iso(candProd)], {
        ...ctx,
        tasks: isoTasks,
        modes: ['isolation', 'production'],
      });
      expect(prodOnly.reasons).toContainEqual(
        expect.objectContaining({ code: 'mode-not-in-tasks', mode: 'production' }),
      );
      const prodTask: PolicyTask[] = [
        ...isoTasks.filter((t) => t.id !== 'cap/c1'),
        { id: 'cap/c1', kind: 'capability', state: 'active', modes: ['production'] },
      ];
      const d = decide(bind(baseIso, prodTask), bind(candIso, prodTask), {
        ...isoCtx,
        tasks: prodTask,
      });
      expect(d.decision).toBe('invalid');
      expect(d.reasons).toContainEqual(
        expect.objectContaining({ code: 'task-not-evaluated', task: 'cap/c1' }),
      );
    });
  });

  it('refuses a baseline older than the 30-day maximum (06 §1.5, §5.1)', () => {
    const at = (createdAt: string) => record('base', 'isolation', undefined, { createdAt });
    expect(decide(at('2026-10-02T12:00:00.000Z'), candIso, isoCtx).decision).toBe('accept'); // 30 d
    const err = harnessError(() => decide(at('2026-10-02T11:59:59.000Z'), candIso, isoCtx));
    expect(err.fields).toEqual(['createdAt']);
    expect(err.message).toMatch(/days old \(max 30\)/);
    expect(() =>
      decide(at('2026-09-01T00:00:00.000Z'), candIso, {
        ...isoCtx,
        config: { maxBaselineAgeDays: 90 },
      }),
    ).not.toThrow();
    expect(() => decide(at('2026-11-02T00:00:00.000Z'), candIso, isoCtx)).toThrow(/after the gate/);
  });

  it('throws on a tampered record (hash mismatch), wrong roles, or a model outside the identity', () => {
    const tampered = {
      ...candIso,
      outcomes: candIso.outcomes.map((o, i) =>
        i === 0
          ? { ...o, score: 0 as const, graders: [{ kind: 'app' as const, passed: false }] }
          : o,
      ),
    };
    expect(() => decide(baseIso, tampered, isoCtx)).toThrow(/hash/);
    expect(() => decide(candIso, candIso, isoCtx)).toThrow(GateHarnessError);
    expect(() =>
      decide(baseIso, candIso, { ...isoCtx, models: { frontier: F, small: 'x' } }),
    ).toThrow(/not in the evaluation identity/);
  });

  describe("the task list is bound to the records' identity (finding: quarantine via ctx)", () => {
    const quarantine = (tasks: readonly PolicyTask[], id: string): PolicyTask[] =>
      tasks.map((t) => (t.id === id ? { ...t, state: 'quarantined' as const } : t));
    const regressed = record('cand', 'isolation', (w, m) => {
      if (m === S) w['replay/a'] = 1;
    });

    it('marking a regressing replay task quarantined in ctx is a harness error', () => {
      expect(decide(baseIso, regressed, isoCtx).decision).toBe('reject');
      const err = harnessError(() =>
        decide(baseIso, regressed, { ...isoCtx, tasks: quarantine(TASKS, 'replay/a') }),
      );
      expect(err.fields).toEqual(['tasks', 'tasks.replay/a']);
      expect(err.message).toMatch(/differs from record .* identity in replay\/a; .*re-baseline/);
    });

    it('a change of kind or modes, a missing or an extra task is refused the same way', () => {
      const changed: PolicyTask[][] = [
        TASKS.map((t) => (t.id === 'cap/c1' ? { ...t, kind: 'wiki' as const } : t)),
        TASKS.map((t) => (t.id === 'cap/c1' ? { ...t, modes: ['isolation' as const] } : t)),
        TASKS.filter((t) => t.id !== 'cap/c1'),
        [...TASKS, { id: 'cap/c11', kind: 'capability', state: 'active' }],
      ];
      for (const tasks of changed) {
        const err = harnessError(() => decide(baseIso, candIso, { ...isoCtx, tasks }));
        expect(err.fields.slice(1)).toEqual([
          tasks.some((t) => t.id === 'cap/c11') ? 'tasks.cap/c11' : 'tasks.cap/c1',
        ]);
      }
    });

    it('a quarantine is a re-baseline: records run under the new identity gate without the task', () => {
      const qTasks = quarantine(TASKS, 'replay/a');
      const q = (r: EvaluationRecord) => withIdentity(r, { tasks: identityTasksFor(qTasks) });
      // The old baseline and a new candidate are not comparable (tasks differ).
      expect(harnessError(() => decide(baseIso, q(regressed), isoCtx)).fields).toEqual(['tasks']);
      const d = decide(q(baseIso), q(regressed), { ...isoCtx, tasks: qTasks });
      expect(d.decision).toBe('accept');
      expect(d.reasons).toContainEqual(
        expect.objectContaining({ code: 'excluded-task', task: 'replay/a' }),
      );
      expect(d.gateInput?.tasks.find((t) => t.id === 'replay/a')?.state).toBe('quarantined');
    });

    it('binds earlyStopEvent and releaseCheck too', () => {
      const tasks = quarantine(TASKS, 'replay/a');
      expect(() => earlyStopEvent(baseIso, { ...ctx, tasks, proposalId: 'prop-9' })).toThrow(
        /replay\/a/,
      );
      const rc = record('base', 'isolation', undefined, { role: 'release-check' });
      expect(() =>
        releaseCheck(rc, rc, { ts: TS, models: ctx.models, tasks, modes: ['isolation'] }),
      ).toThrow(GateHarnessError);
    });
  });

  it('a grader crash makes the evaluation invalid, never a regression', () => {
    const { hash: _h, ...rest } = candIso;
    const outcomes = rest.outcomes.map((o) =>
      o.task === 'replay/a' && o.model === S && o.run === 1
        ? {
            ...o,
            score: 0 as const,
            graders: [{ kind: 'app' as const, passed: false }],
            graderError: 'app grader timed out after 600s',
          }
        : o,
    );
    const d = decide(baseIso, sealRecord({ ...rest, outcomes }), isoCtx);
    expect(d.decision).toBe('invalid');
    expect(d.ledgerEvent).toBeNull();
    expect(d.reasons).toContainEqual(
      expect.objectContaining({ code: 'grader-error', severity: 'invalid', task: 'replay/a' }),
    );
    expect(d.reasons.some((r) => r.code === 'replay-regression')).toBe(false);
  });

  it('does not depend on the order of ctx.tasks (06 §5.8)', () => {
    const a = decide([baseIso, baseProd], [candIso, candProd], ctx);
    const b = decide([baseIso, baseProd], [candIso, candProd], {
      ...ctx,
      tasks: [...TASKS].reverse(),
    });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('recompute (06 §5.8, 13 §2.7)', () => {
  // A second accepted skill set's baseline with the same identity is the normal case.
  const olderAccepted = withIdentity(baseIso, { skillSetHash: H('e') });
  const pool = [
    olderAccepted,
    baseIso,
    baseProd,
    candIso,
    candProd,
    record('cand', 'isolation', undefined, { proposalId: 'prop-other' }),
  ];

  it('reproduces the recorded decision byte for byte from the gate input and records alone', () => {
    const original = decide([baseIso, baseProd], [candIso, candProd], {
      ...ctx,
      seed: 'override-seed',
      radius: 'high',
    });
    if (!original.gateInput || !original.ledgerEvent) throw new Error('no event');
    const stored = JSON.parse(JSON.stringify(original.gateInput));
    const again = recompute(stored, pool);
    expect(JSON.stringify(again)).toBe(JSON.stringify(original));
    expect(again.ledgerEvent?.eventId).toBe(original.ledgerEvent.eventId);
    expect(sameDecision(original.ledgerEvent, again)).toBe(true);
    expect(again.gateInput).toMatchObject({ seed: 'override-seed', radius: 'high' });
  });

  it('reproduces an isolation-only declared decision', () => {
    const original = decide(baseIso, candIso, isoCtx);
    if (!original.gateInput) throw new Error('no input');
    expect(JSON.stringify(recompute(original.gateInput, pool))).toBe(JSON.stringify(original));
  });

  it('a tampered outcome: a resealed record is a different decision and is not the named record', () => {
    const original = decide(baseIso, candIso, isoCtx);
    if (!original.gateInput || !original.ledgerEvent) throw new Error('no event');
    const { hash: _h, ...rest } = candIso;
    const outcomes = rest.outcomes.map((o) =>
      o.task === 'replay/a' && o.model === F && o.run > 1
        ? { ...o, score: 0 as const, graders: [{ kind: 'app' as const, passed: false }] }
        : o,
    );
    const resealed = sealRecord({ ...rest, outcomes });
    expect(resealed.hash).not.toBe(candIso.hash);
    const again = decide(baseIso, resealed, isoCtx);
    expect(again.decision).toBe('reject');
    expect(sameDecision(original.ledgerEvent, again)).toBe(false);
    expect(() => recompute(original.gateInput as never, [baseIso, resealed])).toThrow(
      /not available/,
    );
    const inPlace = { ...resealed, hash: candIso.hash };
    expect(() => recompute(original.gateInput as never, [baseIso, inPlace])).toThrow(/hash/);
  });

  it('a tampered gate input is refused', () => {
    const original = decide(baseIso, candIso, isoCtx);
    const g = original.gateInput;
    if (!g) throw new Error('no input');
    expect(() => recompute({ ...g, radius: 'low' }, pool)).toThrow(/hash/);
    const { hash: _h, ...rest } = g;
    const forged = sealGateInput({ ...rest, proposalId: 'prop-other' });
    expect(() => recompute(forged, pool)).toThrow(/proposal/);
  });

  it('a gate input resealed with a tampered task list is refused (quarantine after the fact)', () => {
    const regressed = record('cand', 'isolation', (w, m) => {
      if (m === S) w['replay/a'] = 1;
    });
    const original = decide(baseIso, regressed, isoCtx);
    expect(original.decision).toBe('reject');
    const g = original.gateInput;
    if (!g) throw new Error('no input');
    const { hash: _h, ...rest } = g;
    const forged = sealGateInput({
      ...rest,
      tasks: rest.tasks.map((t) =>
        t.id === 'replay/a' ? { ...t, state: 'quarantined' as const } : t,
      ),
    });
    GateInputRecordSchema.parse(forged);
    const err = harnessError(() => recompute(forged, [baseIso, regressed]));
    expect(err.fields).toEqual(['tasks', 'tasks.replay/a']);
  });
});

describe('the control arm is rejected for the right reason (06 §10.2–§10.3)', () => {
  const VAL = [
    'replay/keepalive-probe-reaches-store-val',
    'replay/idle-probe-leaves-store-asleep-val',
    'wiki/probe-layer-incidents-val',
    'loop/fixture-preview-before-push-val',
  ];
  // The committed val task specs, as they will be once baselined (pending → active, 06 §4.1).
  const tasks: PolicyTask[] = VAL.map((id) => {
    const spec = JSON.parse(
      readFileSync(new URL(`../../../../../bench/tasks/${id}/task.json`, import.meta.url), 'utf8'),
    );
    return { id: spec.id, kind: spec.kind, state: 'active', modes: spec.modes };
  });
  const world = (idleProbe: number) => ({
    'replay/keepalive-probe-reaches-store-val': 3,
    'replay/idle-probe-leaves-store-asleep-val': idleProbe,
    'wiki/probe-layer-incidents-val': 2,
    'loop/fixture-preview-before-push-val': 3,
  });
  const rec = (side: Side, idleProbe: number) =>
    sealRecord({
      identity: identity('isolation', side === 'base' ? H('a') : H('c'), tasks),
      role: side === 'base' ? 'baseline' : 'candidate',
      proposalId: side === 'cand' ? 'control-1' : undefined,
      createdAt: CREATED,
      outcomes: [F, S].flatMap((m) => expand(world(idleProbe), m, 'isolation')),
    });

  it('"health checks must always query the database" regresses the Neon replay', () => {
    // Baseline: the current mechanism passes both replays. Control: the overgeneral rule makes
    // the idle probe query the store, so the Neon-shaped replay fails every run.
    const d = decide(rec('base', 3), rec('cand', 0), {
      ...isoCtx,
      radius: 'high',
      tasks,
      control: true,
      skill: 'greenlight-build',
    });
    expect(d.decision).toBe('reject');
    expect(d.ledgerEvent).toMatchObject({ stage: 'candidate-rejected', control: true });
    expect(rejectedForReplayRegression(d, 'replay/idle-probe-leaves-store-asleep-val')).toBe(true);
    expect(rejectedForReplayRegression(d, 'replay/keepalive-probe-reaches-store-val')).toBe(false);
    for (const model of [F, S]) {
      expect(d.reasons).toContainEqual(
        expect.objectContaining({
          code: 'replay-regression',
          model,
          mode: 'isolation',
          task: 'replay/idle-probe-leaves-store-asleep-val',
        }),
      );
    }
  });

  it('a control that regresses no replay is rejected, but not for the reason the exit needs', () => {
    const d = decide(rec('base', 3), rec('cand', 3), { ...isoCtx, radius: 'high', tasks });
    expect(d.decision).toBe('reject'); // no strict improvement on the wiki+loop objective
    expect(rejectedForReplayRegression(d, 'replay/idle-probe-leaves-store-asleep-val')).toBe(false);
  });
});

describe('template outlet (06 §5.6)', () => {
  const tctx: GateContext = {
    ...isoCtx,
    outlet: 'template',
    template: {
      lanes: [
        { lane: 'next', passed: true },
        { lane: 'astro', passed: true },
      ],
      mutants: [
        { id: 'm1', caught: true },
        { id: 'm2', caught: true },
      ],
    },
  };
  const flat = record('cand', 'isolation', (w) => {
    Object.assign(w, cleanCell('isolation').base);
  });

  it('needs no capability improvement and writes template evidence', () => {
    const d = decide(baseIso, flat, tctx);
    expect(d.decision).toBe('accept');
    expect(d.ledgerEvent?.outlet).toBe('template');
    expect(d.ledgerEvent?.evidence).toMatchObject({
      kind: 'template',
      gateInput: d.gateInput?.hash,
      lanes: ['next', 'astro'],
      mutantsFailed: 2,
      mutantsTotal: 2,
    });
    LedgerEventSchema.parse(d.ledgerEvent);
    if (!d.gateInput) throw new Error('no input');
    expect(JSON.stringify(recompute(d.gateInput, [baseIso, flat]))).toBe(JSON.stringify(d));
  });

  it('rejects a failing lane, an escaping mutant, or a capability regression', () => {
    const t = tctx.template as NonNullable<GateContext['template']>;
    const lane = decide(baseIso, flat, {
      ...tctx,
      template: { ...t, lanes: [{ lane: 'next', passed: false }] },
    });
    expect(lane.reasons.map((r) => r.code)).toContain('template-lane-failed');
    const mutant = decide(baseIso, flat, {
      ...tctx,
      template: { ...t, mutants: [{ id: 'm1', caught: false }] },
    });
    expect(mutant.decision).toBe('reject');
    expect(mutant.ledgerEvent?.evidence).toMatchObject({ mutantsFailed: 0, mutantsTotal: 1 });
    const worse = record('cand', 'isolation', (w, m) => {
      Object.assign(w, cleanCell('isolation').base);
      if (m === S) {
        w['cap/c1'] = 0;
        w['cap/c2'] = 2;
      }
    });
    const reg = decide(baseIso, worse, tctx);
    expect(reg.decision).toBe('reject');
    expect(reg.reasons.map((r) => r.code)).toContain('capability-regression');
  });

  it('is invalid without template results, lanes or mutants', () => {
    expect(
      decide(baseIso, flat, { ...tctx, template: undefined }).reasons.map((r) => r.code),
    ).toContain('template-evidence-missing');
    const empty = decide(baseIso, flat, { ...tctx, template: { lanes: [], mutants: [] } });
    expect(empty.decision).toBe('invalid');
    expect(empty.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['template-no-lanes', 'template-no-mutants']),
    );
  });
});

describe('earlyStopEvent', () => {
  it('writes a sealed no-action event at R = 1.0, and nothing otherwise', () => {
    const perfect = record('base', 'isolation', (w) => {
      for (const k of Object.keys(w)) w[k] = 3;
    });
    const e = earlyStopEvent(perfect, { ...ctx, proposalId: 'prop-9' });
    expect(e?.stage).toBe('no-action');
    LedgerEventSchema.parse(e);
    expect(earlyStopEvent(baseIso, { ...ctx, proposalId: 'prop-9' })).toBeNull();
  });
});

describe('releaseCheck (06 §5.7)', () => {
  const rc = (edit?: (w: Record<string, number>, model: string) => void) =>
    record('base', 'isolation', edit, { role: 'release-check' });
  const rctx = {
    ts: TS,
    models: { frontier: F, small: S },
    tasks: TASKS,
    modes: ['isolation'] as GateMode[],
    release: '2.0.0',
  };
  const prev = rc();

  it('passes an unchanged candidate and writes a release-check event naming every record', () => {
    const r = releaseCheck(prev, rc(), rctx);
    expect(r.decision).toBe('pass');
    expect(r.blocked).toBe(false);
    expect(r.ledgerEvent?.stage).toBe('release-check');
    expect(r.ledgerEvent?.evidence).toMatchObject({ evaluationRecords: [prev.hash] });
    LedgerEventSchema.parse(r.ledgerEvent);
  });

  it('is invalid when a mode the test tasks declare is missing and none is declared', () => {
    const { modes: _m, ...both } = rctx;
    expect(releaseCheck(prev, rc(), both).decision).toBe('invalid');
  });

  it('blocks a test replay regression; a reasoned override applies only below high radius', () => {
    const regressed = rc((w, m) => {
      if (m === F) w['replay/b'] = 0;
    });
    const r = releaseCheck(prev, regressed, rctx);
    expect(r.blocked).toBe(true);
    expect(r.ledgerEvent?.reason).toMatch(/^blocked: replay-regression/);
    const o = releaseCheck(prev, regressed, { ...rctx, override: { reason: 'known flake, #12' } });
    expect(o).toMatchObject({ blocked: false, overridden: true });
    expect(o.ledgerEvent?.reason).toMatch(/^override: known flake/);
    expect(() =>
      releaseCheck(prev, regressed, { ...rctx, radius: 'high', override: { reason: 'x' } }),
    ).toThrow(/high-radius/);
  });

  it('throws on identity mismatch, non-release-check roles, or the wrong released skill set', () => {
    expect(() => releaseCheck(prev, withIdentity(prev, { depsHash: H('9') }), rctx)).toThrow(
      /depsHash/,
    );
    expect(() => releaseCheck(baseIso, prev, rctx)).toThrow(/role/);
    expect(() => releaseCheck(prev, rc(), { ...rctx, releasedSkillSetHash: H('d') })).toThrow(
      /not the accepted skill set/,
    );
  });
});

describe('gate config', () => {
  it('bench/gate.json holds the defaults', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../../../../bench/gate.json', import.meta.url), 'utf8'),
    );
    expect(loadGateConfig(json)).toEqual(GateConfigSchema.parse({}));
    expect(loadGateConfig(json)).toEqual({
      alpha: 0.05,
      runs: 3,
      resamples: 1000,
      acceptShorterOnTie: false,
      maxBaselineAgeDays: 30,
    });
  });
  it('enables the tie-break from config', () => {
    const flat = record('cand', 'isolation', (w) => {
      Object.assign(w, cleanCell('isolation').base);
    });
    const tie = { ...isoCtx, skillLines: { before: 100, after: 80 } };
    expect(decide(baseIso, flat, tie).decision).toBe('reject');
    const d = decide(baseIso, flat, { ...tie, config: { acceptShorterOnTie: true } });
    expect(d.decision).toBe('accept');
    expect(d.ledgerEvent?.reason).toMatch(/tie/);
  });
});
