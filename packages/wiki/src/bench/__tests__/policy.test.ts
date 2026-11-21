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

const LETTER = {
  accept: 'A',
  reject: 'R',
  invalid: 'I',
  blocked: 'B',
  underpowered: 'U',
} as const;

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
      if (out.decision === 'blocked') {
        // 06 §5.4: a flaky baseline is the baseline's problem; nothing is held against the candidate.
        expect(out.reasons.some((r) => r.severity === 'fail')).toBe(false);
        const why = out.reasons.filter((r) => r.severity === 'blocked');
        expect(why.map((r) => r.code)).toEqual(['flaky-baseline']);
        expect(why[0]?.task).toBe('replay/b');
        expect(why[0]?.detail).toMatch(/fix or quarantine replay\/b/);
      }
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
    ...over,
  };
}

describe('non-regression by algorithm version (06 §5.4, §5.8)', () => {
  const vector = (id: string) => {
    const v = VECTORS.find((x) => x.id === id);
    if (!v) throw new Error(`missing vector ${id}`);
    return v;
  };
  // Target cell 2 is small/isolation; at medium radius its only rule is non-regression.
  const smallIso = (id: string, over: Partial<PolicyInput> = {}) =>
    applyPolicy({ ...buildVector(vector(id), 'medium', 2).input, ...over });

  it('the default is the current algorithm: the exact test, rejecting at p ≤ alpha', () => {
    const out = smallIso('capability-loss-p-at-alpha');
    expect(out.decision).toBe('reject');
    expect(out.reasons.filter((r) => r.severity === 'fail')).toEqual([
      {
        code: 'capability-regression',
        severity: 'fail',
        model: S,
        mode: 'isolation',
        detail:
          'baseline 15/30, candidate 12/30: Δ -3 passes over 10 tasks × 3 runs; one-sided exact p 0.05 ≤ alpha 0.05',
      },
    ]);
    expect(JSON.stringify(smallIso('capability-loss-p-at-alpha', { algorithm: 3 }))).toBe(
      JSON.stringify(out),
    );
  });

  it('a loss that is not significant passes and is not reported', () => {
    const out = smallIso('capability-loss-p-above-alpha');
    expect(out.decision).toBe('accept');
    expect(out.reasons.map((r) => r.code)).not.toContain('capability-regression');
    expect(out.results.every((r) => r.decision === 'pass')).toBe(true);
  });

  it('the same evidence under algorithm 2 is decided by the fixed count, with its own wording', () => {
    // −3 of 30 on one task: within the legacy bound of 3, although p = alpha.
    expect(smallIso('capability-loss-p-at-alpha', { algorithm: 2 }).decision).toBe('accept');
    // −3 of 30 over two tasks: within the bound under both.
    expect(smallIso('capability-loss-p-above-alpha', { algorithm: 2 }).decision).toBe('accept');
    const beyond = smallIso('capability-loss-significant', { algorithm: 2 });
    expect(beyond.decision).toBe('reject');
    expect(beyond.reasons).toContainEqual(
      expect.objectContaining({
        code: 'capability-regression',
        detail: 'Δ -4 passes over 10 tasks × 3 runs; at most 3 may be lost',
      }),
    );
  });

  it('alpha is the configured one, and nonRegressionFraction is ignored from algorithm 3', () => {
    const at = (over: Partial<PolicyInput>) => smallIso('capability-loss-p-at-alpha', over);
    expect(at({ alpha: 0.04 }).reasons.map((r) => r.code)).not.toContain('capability-regression');
    expect(JSON.stringify(at({ nonRegressionFraction: 0.5 }))).toBe(JSON.stringify(at({})));
    expect(at({ algorithm: 2, nonRegressionFraction: 0.05 }).decision).toBe('reject');
  });

  it('production mode uses the same rule under its own code', () => {
    const v = vector('capability-loss-p-at-alpha');
    const out = applyPolicy(buildVector(v, 'medium', 3).input);
    expect(out.reasons.filter((r) => r.severity === 'fail').map((r) => r.code)).toEqual([
      'production-regression',
    ]);
  });
});

describe('applyPolicy details', () => {
  it('a grader crash is invalid (grader-error), never a fail or a regression, on any task', () => {
    const crash = (o: PolicyInput['candidate'][number]) => ({
      ...o,
      score: 0 as const,
      graders: [{ kind: 'app' as const, passed: false }],
      graderError: 'grader timed out',
    });
    for (const [task, side] of [
      ['replay/a', 'candidate'],
      ['replay/q', 'candidate'], // a quarantined (excluded) task still invalidates
      ['cap/c1', 'baseline'],
    ] as const) {
      const base = clean();
      const list = base[side].map((o) =>
        o.task === task && o.model === S && o.mode === 'isolation' && o.run === 2 ? crash(o) : o,
      );
      const out = applyPolicy({ ...base, [side]: list });
      expect(out.decision, task).toBe('invalid');
      expect(out.results).toEqual([]);
      expect(out.reasons).toContainEqual(
        expect.objectContaining({ code: 'grader-error', severity: 'invalid', task, model: S }),
      );
      expect(out.reasons.some((r) => r.severity === 'fail')).toBe(false);
    }
  });

  it('accepts the clean world with the exact p-value and reports the GateResult figures', () => {
    const out = applyPolicy(clean());
    expect(out.decision).toBe('accept');
    const iso = out.results[0];
    expect(iso?.model).toBe(F);
    expect(iso?.mode).toBe('isolation');
    expect(iso?.capability.before).toBeCloseTo(0.5);
    expect(iso?.capability.after).toBeCloseTo(0.9);
    // c6–c9 go 0/3 → 3/3 (each 1/20), c1–c5 and c10 do not move (each 1): p = 20⁻⁴ exactly.
    expect(iso?.capability.pValue).toBeCloseTo(1 / 160000, 12);
    // Against this baseline the best any candidate could do is lift c6–c10: 20⁻⁵.
    expect(iso?.capability.minP).toBeCloseTo(1 / 3200000, 12);
    expect(iso?.replay).toEqual({
      total: 3,
      baselinePassing: 3,
      candidatePassing: 3,
      regressions: [],
    });
    expect(out.results[1]?.capability.pValue).toBeNull(); // production: not computed
  });

  it('does not depend on ctx.tasks order', () => {
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

  it('is underpowered with no objective tasks: no slice, so no decision, and it says so', () => {
    const tasks = TASKS.filter((t) => t.kind === 'replay');
    const base = clean({ tasks });
    const keep = (o: { task: string }) => o.task.startsWith('replay/');
    const out = applyPolicy({
      ...base,
      baseline: base.baseline.filter(keep),
      candidate: base.candidate.filter(keep),
    });
    expect(out.decision).toBe('underpowered');
    expect(out.results[0]?.capability).toEqual({
      before: 0,
      after: 0,
      delta: 0,
      pValue: null,
      minP: null,
    });
    expect(out.reasons.map((r) => r.code)).toContain('no-objective-tasks');
    // With no objective task there is no non-regression set to report.
    expect(out.reasons.map((r) => r.code)).not.toContain('non-regression-set');
    expect(out.reasons).toContainEqual(
      expect.objectContaining({ code: 'no-slice', severity: 'blocked', model: F }),
    );
    expect(out.reasons.some((r) => r.severity === 'fail')).toBe(false);
  });

  it('refuses a gate pair that is one model twice (06 §5.3)', () => {
    const out = applyPolicy(clean({ models: { frontier: F, small: F } }));
    expect(out.decision).toBe('invalid');
    expect(out.reasons.map((r) => r.code)).toContain('models-not-distinct');
  });

  describe('tie-break (06 §5.5)', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
    const BEFORE = lines(100);
    /** The first `n` lines of BEFORE: a pure deletion. */
    const cut = (n: number) => lines(n);
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
        tieBreak: { enabled: true, before: BEFORE, after: cut(90) },
      });
      expect(ok.decision).toBe('accept');
      expect(ok.tieBreak).toBe(true);
      expect(ok.reasons.find((r) => r.code === 'tie-break-shorter')?.detail).toBe(
        'SKILL.md 100 → 90 lines, deletions only',
      );
    });
    it('verifies the claim from the texts: a rewrite of the same length saving is not a deletion', () => {
      // 90 lines, but one of them is new text: shorter by 10%, yet not deletions only.
      const rewritten = `${cut(89)}\na new instruction`;
      const out = applyPolicy({
        ...flat(),
        tieBreak: { enabled: true, before: BEFORE, after: rewritten },
      });
      expect(out.decision).toBe('reject');
      expect(out.tieBreak).toBe(false);
      // reordered lines are not a deletion either
      const reordered = [...cut(90).split('\n')].reverse().join('\n');
      expect(
        applyPolicy({ ...flat(), tieBreak: { enabled: true, before: BEFORE, after: reordered } })
          .decision,
      ).toBe('reject');
    });
    it('a tie is equal pass counts within ⌊rollouts/20⌋: −1 of 30 ties, −2 does not', () => {
      const drop = (n: number) => {
        const base = flat();
        return applyPolicy({
          ...base,
          candidate: base.candidate.map((o) =>
            o.task === 'cap/c1' && o.model === S && o.run <= n ? { ...o, score: 0 } : o,
          ),
          tieBreak: { enabled: true, before: BEFORE, after: cut(50) },
        });
      };
      expect(drop(1).decision).toBe('accept');
      // Under the old "|Δ| < one task-mean" rule this −2 on both modes was a tie.
      expect(drop(2).decision).toBe('reject');
    });
    it('needs at least 10% fewer lines', () => {
      const out = applyPolicy({
        ...flat(),
        tieBreak: { enabled: true, before: BEFORE, after: cut(91) },
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
        tieBreak: { enabled: true, before: BEFORE, after: cut(50) },
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
        tieBreak: { enabled: true, before: BEFORE, after: cut(50) },
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
  it('does not stop on a grader-error baseline', () => {
    const b = allPass.map((o, i) => (i === 0 ? { ...o, graderError: 'crashed' } : o));
    expect(earlyStop({ ...input, baseline: b })).toEqual({
      stop: false,
      detail: 'grader-error baseline outcome',
    });
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
  it('is invalid on a grader crash, not blocked', () => {
    const input = both();
    const candidate = input.candidate.map((o, i) =>
      i === 0
        ? {
            ...o,
            score: 0 as const,
            graders: [{ kind: 'app' as const, passed: false }],
            graderError: 'x',
          }
        : o,
    );
    const out = releasePolicy({ ...input, candidate });
    expect(out.decision).toBe('invalid');
    expect(out.reasons.map((r) => r.code)).toContain('grader-error');
  });
  it('blocks a test replay regression on the small model', () => {
    const out = releasePolicy(
      both((w, m) => {
        if (m === S) w.cand['replay/a'] = 1;
      }),
    );
    expect(out.decision).toBe('blocked');
    expect(out.results.every((r) => r.split === 'test')).toBe(true);
  });
  it('allows a drop of exactly the bound (3 of 30 passes) and blocks one pass beyond', () => {
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

describe('the non-regression set is stated for every cell', () => {
  it('reports the totals over every objective task as an info reason', () => {
    const out = applyPolicy(clean());
    const notes = out.reasons.filter((r) => r.code === 'non-regression-set');
    expect(notes).toHaveLength(out.results.length);
    for (const n of notes) {
      expect(n.severity).toBe('info');
      expect(n.detail).toMatch(
        /^baseline \d+\/\d+, candidate \d+\/\d+ over \d+ objective task\(s\)/,
      );
    }
  });
});
