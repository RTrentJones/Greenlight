import { describe, expect, it } from 'vitest';
import {
  CELLS,
  F,
  RADII,
  S,
  TASKS,
  VECTORS,
  buildVector,
  cleanCell,
  expand,
} from '../../__tests__/fixtures/policy/vectors';
import { GateResultSchema } from '../../schema/ledger';
import { type PolicyInput, applyPolicy, earlyStop, releasePolicy } from '../policy';

const LETTER = { accept: 'A', reject: 'R', invalid: 'I' } as const;

describe('policy boundary vectors (13 §2.8)', () => {
  const rows = VECTORS.flatMap((v) =>
    RADII.flatMap((radius) =>
      CELLS.map((cell, i) => ({
        v,
        radius,
        i,
        name: `${v.id} · ${radius} · ${cell.model}/${cell.mode}`,
        want: v.expect[radius][i] as string,
      })),
    ),
  );

  it.each(rows)('$name → $want', ({ v, radius, i, want }) => {
    const { input, baseline } = buildVector(v, radius, i);
    if (v.earlyStop) {
      const stop = earlyStop({
        models: input.models,
        modes: input.modes,
        tasks: input.tasks,
        baseline,
      });
      expect(stop.stop ? 'N' : 'gate').toBe(want);
      return;
    }
    const out = applyPolicy(input);
    expect(LETTER[out.decision]).toBe(want);
    expect(out.path).toBe(v.path);
    if (out.decision === 'invalid') {
      expect(out.results).toEqual([]);
      expect(out.reasons.some((r) => r.severity === 'invalid')).toBe(true);
    } else {
      expect(out.results).toHaveLength(4);
      for (const r of out.results) GateResultSchema.parse(r);
      // the overall decision is exactly "every model × mode passes and no path rule failed"
      const allPass = out.results.every((r) => r.decision === 'pass');
      if (out.decision === 'accept') expect(allPass).toBe(true);
      if (out.decision === 'reject') {
        expect(out.reasons.some((r) => r.severity === 'fail')).toBe(true);
        if (v.rejectCode) expect(out.reasons.map((r) => r.code)).toContain(v.rejectCode);
      }
    }
    // pending and quarantined tasks never count (06 §4.1)
    for (const r of out.results) expect(r.replay.regressions).not.toContain('replay/p');
    expect(out.reasons.filter((r) => r.code === 'excluded-task').map((r) => r.task)).toEqual([
      'replay/p',
      'replay/q',
    ]);
  });

  it('is deterministic: the same vector gives byte-identical output', () => {
    const v = VECTORS.find((x) => x.id === 'replay-2of3');
    if (!v) throw new Error('missing vector');
    const a = applyPolicy(buildVector(v, 'medium', 0).input);
    const b = applyPolicy(buildVector(v, 'medium', 0).input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

function clean(over: Partial<PolicyInput> = {}): PolicyInput {
  const baseline = CELLS.flatMap((c) => expand(cleanCell(c.mode).base, c.model, c.mode));
  const candidate = CELLS.flatMap((c) => expand(cleanCell(c.mode).cand, c.model, c.mode));
  return {
    radius: 'medium',
    path: 'standard',
    models: { frontier: F, small: S },
    modes: ['isolation', 'production'],
    tasks: TASKS,
    baseline,
    candidate,
    seed: 'clean',
    ...over,
  };
}

describe('applyPolicy details', () => {
  it('accepts the clean world with real bootstrap p-values and reports the GateResult figures', () => {
    const out = applyPolicy(clean());
    expect(out.decision).toBe('accept');
    const iso = out.results[0];
    expect(iso?.model).toBe(F);
    expect(iso?.mode).toBe('isolation');
    expect(iso?.capability.before).toBeCloseTo(0.5);
    expect(iso?.capability.after).toBeCloseTo(0.9);
    expect(iso?.capability.pValue).toBeLessThan(0.05);
    expect(iso?.replay).toEqual({
      total: 3,
      baselinePassing: 3,
      candidatePassing: 3,
      regressions: [],
    });
    expect(out.results[1]?.capability.pValue).toBeNull(); // production: not computed
  });

  it('bootstraps over tasks sorted by id: the p-value does not depend on ctx.tasks order', () => {
    // An uneven gain, so resampling by position would see different diffs under a reorder.
    const base = clean();
    const uneven = {
      ...base,
      candidate: base.candidate.map((o) =>
        o.task === 'cap/c6' && o.mode === 'isolation' && o.run === 3
          ? { ...o, score: 0 as const }
          : o,
      ),
    };
    const a = applyPolicy(uneven);
    const shuffled = [...TASKS].reverse();
    const b = applyPolicy({ ...uneven, tasks: shuffled });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('requires every mode the gated tasks declare unless the caller declares fewer', () => {
    const base = clean();
    const iso = (o: { mode: string }) => o.mode === 'isolation';
    const isoOnly = {
      ...base,
      modes: ['isolation'] as const,
      baseline: base.baseline.filter(iso),
      candidate: base.candidate.filter(iso),
    };
    const silent = applyPolicy(isoOnly);
    expect(silent.decision).toBe('invalid');
    expect(silent.reasons).toContainEqual(
      expect.objectContaining({ code: 'mode-missing', mode: 'production' }),
    );
    const declared = applyPolicy({ ...isoOnly, declaredModes: ['isolation'] });
    expect(declared.decision).toBe('accept');
    expect(declared.reasons.map((r) => r.code)).toContain('modes-partial');
  });

  it('treats pending tasks as absent: a pending task whose candidate regresses changes nothing', () => {
    const withPending = applyPolicy(clean());
    const activated = applyPolicy(
      clean({
        tasks: TASKS.map((t) => (t.id === 'replay/p' ? { ...t, state: 'active' as const } : t)),
      }),
    );
    expect(withPending.decision).toBe('accept');
    expect(activated.decision).toBe('reject');
    expect(activated.reasons.find((r) => r.code === 'replay-regression')?.task).toBe('replay/p');
  });

  it('is invalid when a gated task is missing a run', () => {
    const base = clean();
    const out = applyPolicy({
      ...base,
      candidate: base.candidate.filter((o) => !(o.task === 'cap/c1' && o.run === 3)),
    });
    expect(out.decision).toBe('invalid');
    expect(out.reasons.map((r) => r.code)).toContain('incomplete-outcomes');
  });

  it('is invalid when a fallback-served outcome sits even on an excluded task', () => {
    const base = clean();
    const out = applyPolicy({
      ...base,
      baseline: base.baseline.map((o) =>
        o.task === 'replay/q' && o.run === 1 ? { ...o, servedBy: 'fallback-model' } : o,
      ),
    });
    expect(out.decision).toBe('invalid');
    expect(out.reasons.find((r) => r.code === 'fallback-served')).toMatchObject({
      task: 'replay/q',
      severity: 'invalid',
    });
  });

  it('is invalid for an outcome on a task, model or mode outside the gate', () => {
    const base = clean();
    const extra = expand({ 'cap/zz': 3 }, F, 'isolation');
    expect(applyPolicy({ ...base, candidate: [...base.candidate, ...extra] }).decision).toBe(
      'invalid',
    );
    expect(applyPolicy({ ...base, modes: ['isolation'] }).decision).toBe('invalid');
  });

  it('needs isolation mode on the standard path', () => {
    const base = clean();
    const prodOnly = (o: { mode: string }) => o.mode === 'production';
    const out = applyPolicy({
      ...base,
      modes: ['production'],
      baseline: base.baseline.filter(prodOnly),
      candidate: base.candidate.filter(prodOnly),
    });
    expect(out.decision).toBe('invalid');
    expect(out.reasons.map((r) => r.code)).toContain('mode-missing');
  });

  it('rejects a safety-fix with no targets, an unknown target, or a target that already passes', () => {
    expect(applyPolicy(clean({ path: 'safety-fix' })).reasons.map((r) => r.code)).toContain(
      'safety-fix-no-targets',
    );
    expect(
      applyPolicy(clean({ path: 'safety-fix', safetyFixTargets: ['replay/nope'] })).decision,
    ).toBe('reject');
    const passing = applyPolicy(clean({ path: 'safety-fix', safetyFixTargets: ['replay/a'] }));
    expect(passing.decision).toBe('reject');
    expect(passing.reasons.map((r) => r.code)).toContain('safety-fix-target-not-failing');
  });

  it('rejects a second pending neutral change for the same skill', () => {
    const out = applyPolicy(
      clean({ path: 'neutral', neutralReason: 'prereq', neutralPendingForSkill: true }),
    );
    expect(out.decision).toBe('reject');
    expect(out.reasons.map((r) => r.code)).toContain('neutral-already-pending');
  });

  it('rejects with no objective tasks (strict improvement is impossible) and says so', () => {
    const tasks = TASKS.filter((t) => t.kind === 'replay');
    const base = clean({ tasks });
    const keep = (o: { task: string }) => o.task.startsWith('replay/');
    const out = applyPolicy({
      ...base,
      baseline: base.baseline.filter(keep),
      candidate: base.candidate.filter(keep),
    });
    expect(out.decision).toBe('reject');
    expect(out.results[0]?.capability).toEqual({ before: 0, after: 0, delta: 0, pValue: null });
    expect(out.reasons.map((r) => r.code)).toContain('no-objective-tasks');
  });

  describe('tie-break (06 §5.5)', () => {
    const flat = () => {
      const base = clean();
      return { ...base, candidate: base.baseline.map((o) => o) } as PolicyInput;
    };
    it('is off by default: a flat candidate is rejected', () => {
      expect(applyPolicy(flat()).decision).toBe('reject');
    });
    it('accepts a flat candidate that shrinks SKILL.md by ≥ 10% when enabled', () => {
      const ok = applyPolicy({
        ...flat(),
        candidate: flat().baseline.map((o) =>
          o.task.startsWith('replay/p') || o.task.startsWith('replay/q') ? { ...o, score: 0 } : o,
        ),
        tieBreak: { enabled: true, linesBefore: 100, linesAfter: 90 },
      });
      expect(ok.decision).toBe('accept');
      expect(ok.tieBreak).toBe(true);
      expect(ok.reasons.map((r) => r.code)).toContain('tie-break-shorter');
    });
    it('needs at least 10% fewer lines', () => {
      const out = applyPolicy({
        ...flat(),
        tieBreak: { enabled: true, linesBefore: 100, linesAfter: 91 },
      });
      expect(out.decision).toBe('reject');
    });
    it('does not apply when capability moved by a whole task-mean', () => {
      const base = flat();
      const out = applyPolicy({
        ...base,
        candidate: base.candidate.map((o) =>
          o.task === 'cap/c1' && o.model === S ? { ...o, score: 0 } : o,
        ),
        tieBreak: { enabled: true, linesBefore: 100, linesAfter: 50 },
      });
      expect(out.decision).toBe('reject');
    });
    it('never overrides a replay regression', () => {
      const base = flat();
      const out = applyPolicy({
        ...base,
        candidate: base.candidate.map((o) =>
          o.task === 'replay/a' && o.run > 1 ? { ...o, score: 0 } : o,
        ),
        tieBreak: { enabled: true, linesBefore: 100, linesAfter: 50 },
      });
      expect(out.decision).toBe('reject');
      expect(out.tieBreak).toBe(false);
    });
  });
});

describe('earlyStop', () => {
  const allPass = CELLS.flatMap((c) => {
    const w = cleanCell(c.mode).base;
    for (const k of Object.keys(w)) w[k] = 3;
    return expand(w, c.model, c.mode);
  });
  const input = {
    models: { frontier: F, small: S },
    modes: ['isolation', 'production'] as const,
    tasks: TASKS,
    baseline: allPass,
  };
  it('stops at R = 1.0', () => expect(earlyStop(input).stop).toBe(true));
  it('does not stop when one run on one model is short of 1.0', () => {
    const b = allPass.map((o) =>
      o.task === 'cap/c3' && o.model === S && o.run === 2 ? { ...o, score: 0 as const } : o,
    );
    expect(earlyStop({ ...input, baseline: b }).stop).toBe(false);
  });
  it('does not stop on a fallback-served baseline', () => {
    const b = allPass.map((o, i) => (i === 0 ? { ...o, servedBy: 'other' } : o));
    expect(earlyStop({ ...input, baseline: b }).stop).toBe(false);
  });
});

describe('releasePolicy (06 §5.7)', () => {
  const both = (fn?: (w: ReturnType<typeof cleanCell>, model: string) => void) => {
    const previous = CELLS.flatMap((c) => expand(cleanCell(c.mode).base, c.model, c.mode));
    const candidate = CELLS.flatMap((c) => {
      const w = cleanCell(c.mode);
      w.cand = { ...w.base };
      fn?.(w, c.model);
      return expand(w.cand, c.model, c.mode);
    });
    return {
      models: { frontier: F, small: S },
      modes: ['isolation', 'production'] as const,
      tasks: TASKS,
      previous,
      candidate,
    };
  };
  it('passes an unchanged skill set', () => expect(releasePolicy(both()).decision).toBe('pass'));
  it('blocks a test replay regression on the small model', () => {
    const out = releasePolicy(
      both((w, m) => {
        if (m === S) w.cand['replay/a'] = 1;
      }),
    );
    expect(out.decision).toBe('blocked');
    expect(out.results.every((r) => r.split === 'test')).toBe(true);
  });
  it('allows a drop of exactly one task-mean and blocks one run beyond', () => {
    expect(
      releasePolicy(
        both((w) => {
          w.cand['cap/c1'] = 0;
        }),
      ).decision,
    ).toBe('pass');
    expect(
      releasePolicy(
        both((w) => {
          w.cand['cap/c1'] = 0;
          w.cand['cap/c2'] = 2;
        }),
      ).decision,
    ).toBe('blocked');
  });
  it('uses 3 of 3 at high radius', () => {
    const input = both((w) => {
      w.cand['replay/a'] = 2;
    });
    expect(releasePolicy(input).decision).toBe('pass');
    expect(releasePolicy({ ...input, radius: 'high' }).decision).toBe('blocked');
  });
});
