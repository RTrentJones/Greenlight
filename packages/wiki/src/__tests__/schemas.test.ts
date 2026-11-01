import { describe, expect, it } from 'vitest';
import {
  type BaselineIdentity,
  BaselineIdentitySchema,
  type EvaluationRecord,
  EvaluationRecordSchema,
  GateInputRecordSchema,
  type GateResult,
  LedgerEventSchema,
  MaintainerOutputSchema,
  ModelsConfigSchema,
  PageSchema,
  ProposerOutputSchema,
  TaskSpecSchema,
  TrajectoryRuleSchema,
  canonicalJson,
  checkProposalHistory,
  comparable,
  evalEvidencePath,
  identityDiff,
  sealEvent,
  sealGateInput,
  sealRecord,
  touchesVersion,
} from '../index';

// Vision 08 §3, §8, §9, §10 / roadmap M0-03..M0-06; acceptance rows in 13 §2.1 and §2.7.

const H = (c: string) => c.repeat(64);
const TS = '2026-11-01T00:00:00.000Z';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success).toBe(true);
const bad = (
  schema: {
    safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  },
  v: unknown,
  msg?: RegExp,
) => {
  const r = schema.safeParse(v);
  expect(r.success).toBe(false);
  if (msg) expect(r.error?.issues.map((i) => i.message).join('\n')).toMatch(msg);
};

describe('canonicalJson', () => {
  it('is key-order independent and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, u: undefined })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });
});

describe('pages (M0-06)', () => {
  const pattern = {
    id: 'pattern/keepalive-probe-misses-postgres',
    type: 'pattern',
    title: 'Keepalive probe misses Postgres',
    updated: '2026-11-01',
    status: 'confirmed',
    kind: 'failure',
    class: 'proxy-check',
    atRisk: 'store idle timer',
    probed: 'schema cache',
    cells: ['next/vercel/supabase'],
    affects: '>=0.1 <0.9',
    relevance: 'both',
    evidence: ['issue:o/r#55'],
    catches: { description: 'probe reads a real table' },
    remediation: [{ outlet: 'mechanism', ref: 'greenlight@0.9.0', verified: true }],
    skills: ['provider-supabase'],
  };

  it('accepts a confirmed failure pattern with evidence, catches and a verified remediation', () => {
    ok(PageSchema, pattern);
  });

  it('LR-05: a confirmed failure pattern without a verified remediation is invalid', () => {
    bad(
      PageSchema,
      { ...pattern, remediation: [{ outlet: 'skill', ref: 'x', verified: false }] },
      /verified remediation/,
    );
    bad(PageSchema, { ...pattern, catches: undefined }, /catches/);
    bad(PageSchema, { ...pattern, evidence: [] }, /evidence/);
  });

  it('the same page as a hypothesis needs none of that', () => {
    ok(PageSchema, {
      ...pattern,
      status: 'hypothesis',
      remediation: [],
      evidence: [],
      catches: undefined,
    });
  });

  it('framework-version relevance needs an affects range', () => {
    bad(PageSchema, { ...pattern, relevance: 'framework-version', affects: undefined }, /affects/);
  });

  it('supersededBy iff superseded', () => {
    bad(PageSchema, { ...pattern, status: 'superseded' }, /supersededBy/);
    ok(PageSchema, { ...pattern, status: 'superseded', supersededBy: 'pattern/other' });
    bad(PageSchema, { ...pattern, supersededBy: 'pattern/other' }, /supersededBy/);
  });

  it('decision and contract pages require skills[] for LR-11 back-links', () => {
    const decision = {
      id: 'decision/x',
      type: 'decision',
      title: 't',
      updated: '2026-11-01',
      status: 'confirmed',
      decided: '2026-10-01',
      scope: ['blog'],
    };
    bad(PageSchema, decision);
    ok(PageSchema, { ...decision, skills: ['greenlight-build'] });
  });

  it('rejects the retired applies field and unknown fields', () => {
    bad(PageSchema, { ...pattern, applies: '>=0.1' });
  });

  it('intent criteria cite kebab check ids', () => {
    const intent = {
      id: 'intent/vote',
      type: 'intent',
      title: 'Vote',
      updated: '2026-11-01',
      status: 'confirmed',
      tool: 'vote',
      criteria: [
        {
          id: 'AC-1',
          text: 'members vote once',
          source: 'kickoff',
          added: '2026-11-01',
          checks: ['vote-rejects-duplicate'],
        },
      ],
    };
    ok(PageSchema, intent);
    bad(PageSchema, { ...intent, criteria: [{ ...intent.criteria[0], checks: ['Bad Id'] }] });
  });
});

describe('ledger (M0-04)', () => {
  const result: GateResult = {
    model: 'gemini-3.8-flash',
    mode: 'isolation',
    split: 'val',
    runs: 3,
    replay: { total: 2, baselinePassing: 2, candidatePassing: 2, regressions: [] },
    capability: { before: 0.5, after: 0.7, delta: 0.2, pValue: 0.03 },
    decision: 'pass',
  };
  const accepted = () =>
    sealEvent({
      ts: '2026-11-01T00:00:00.000Z',
      proposalId: 'prop-1',
      stage: 'candidate-accepted',
      path: 'standard',
      outlet: 'skill',
      skill: 'greenlight-build',
      evidence: {
        kind: 'bench',
        gateInput: H('c'),
        evaluationRecords: [H('a'), H('b')],
        results: [result, { ...result, model: 'gemini-3.6-flash' }],
      },
    });

  it('accepts a sealed event with per-model results', () => {
    ok(LedgerEventSchema, accepted());
  });

  it('rejects a tampered event (eventId no longer matches)', () => {
    bad(LedgerEventSchema, { ...accepted(), skill: 'other' }, /eventId/);
  });

  it('rejects non-harness writers', () => {
    bad(LedgerEventSchema, { ...accepted(), writer: 'agent' });
  });

  it('requires a path on candidate events and reasons where documented', () => {
    bad(
      LedgerEventSchema,
      sealEvent({ ts: '2026-11-01T00:00:00.000Z', proposalId: 'p', stage: 'candidate-rejected' }),
      /path/,
    );
    bad(
      LedgerEventSchema,
      sealEvent({ ts: '2026-11-01T00:00:00.000Z', proposalId: 'p', stage: 'no-action' }),
      /reason/,
    );
    bad(
      LedgerEventSchema,
      sealEvent({
        ts: '2026-11-01T00:00:00.000Z',
        proposalId: 'p',
        stage: 'candidate-accepted',
        path: 'neutral',
      }),
      /reason/,
    );
  });

  it('verified-in-production needs field evidence; spend events carry spend and no proposal', () => {
    bad(
      LedgerEventSchema,
      sealEvent({
        ts: '2026-11-01T00:00:00.000Z',
        proposalId: 'p',
        stage: 'verified-in-production',
      }),
      /field evidence/,
    );
    ok(
      LedgerEventSchema,
      sealEvent({
        ts: '2026-11-01T00:00:00.000Z',
        stage: 'spend',
        spend: { usd: 0, rollouts: 4, requests: 60, tokensIn: 1000, tokensOut: 200 },
      }),
    );
  });

  it('a control-arm proposal is never merged', () => {
    bad(
      LedgerEventSchema,
      sealEvent({
        ts: '2026-11-01T00:00:00.000Z',
        proposalId: 'p',
        stage: 'merged',
        control: true,
      }),
      /control/,
    );
  });

  it('stage machine: accepted → merged → released → verified; rejection is final', () => {
    const e = (stage: string) => ({ stage }) as never;
    expect(
      checkProposalHistory([
        e('candidate-accepted'),
        e('merged'),
        e('released'),
        e('verified-in-production'),
      ]),
    ).toEqual([]);
    expect(checkProposalHistory([e('candidate-rejected'), e('merged')])).toEqual([
      'stage "merged" cannot follow "candidate-rejected"',
    ]);
    expect(checkProposalHistory([e('merged')])).toEqual(['stage "merged" cannot follow "start"']);
  });

  it('stage machine by outlet: only the verify outlet skips released (06 §3.5, §6.1)', () => {
    const e = (stage: string, outlet?: string) => ({ stage, outlet }) as never;
    // CLI-released outlets: verified-in-production needs released first.
    for (const outlet of ['skill', 'template', 'mechanism', 'doctor', undefined]) {
      expect(
        checkProposalHistory([
          e('candidate-accepted', outlet),
          e('merged'),
          e('verified-in-production'),
        ]),
        String(outlet),
      ).toEqual(['stage "verified-in-production" cannot follow "merged"']);
    }
    // The verify outlet lives in the wrapper: merged → verified-in-production, never released.
    expect(
      checkProposalHistory([
        e('candidate-accepted', 'verify'),
        e('merged'),
        e('verified-in-production'),
        e('withdrawn'),
      ]),
    ).toEqual([]);
    expect(
      checkProposalHistory([e('candidate-accepted', 'verify'), e('merged'), e('released')]),
    ).toEqual(['stage "released" cannot follow "merged" (outlet verify has no CLI release)']);
    expect(checkProposalHistory([e('candidate-accepted', 'skill'), e('merged', 'verify')])).toEqual(
      ['events name more than one outlet (skill, verify)'],
    );
  });

  it('candidate bench evidence names its gate input; release-check evidence need not', () => {
    const results = [
      {
        model: 'm',
        mode: 'isolation' as const,
        split: 'val' as const,
        runs: 3,
        replay: { total: 0, baselinePassing: 0, candidatePassing: 0, regressions: [] },
        capability: { before: 0, after: 0, delta: 0, pValue: null },
        decision: 'pass' as const,
      },
    ];
    bad(
      LedgerEventSchema,
      sealEvent({
        ts: TS,
        proposalId: 'p',
        stage: 'candidate-rejected',
        path: 'standard',
        evidence: { kind: 'bench', evaluationRecords: [H('a')], results },
      }),
      /gate input/,
    );
    ok(
      LedgerEventSchema,
      sealEvent({
        ts: TS,
        stage: 'release-check',
        reason: 'release check passed',
        evidence: { kind: 'bench', evaluationRecords: [H('a'), H('b')], results },
      }),
    );
  });
});

describe('maintainer and proposer I/O (M0-05)', () => {
  it('maintainer output requires update_index and append_log', () => {
    ok(MaintainerOutputSchema, {
      create_pages: [],
      update_pages: [],
      update_index: '# index',
      append_log: 'no changes: why',
    });
    bad(MaintainerOutputSchema, { create_pages: [], update_pages: [], append_log: 'x' });
  });

  it('maintainer output may not touch one page twice', () => {
    bad(
      MaintainerOutputSchema,
      {
        create_pages: [{ id: 'pattern/a', content: '---' }],
        update_pages: [{ id: 'pattern/a', ops: [{ op: 'append', text: 'x' }] }],
        update_index: 'i',
        append_log: 'l',
      },
      /more than once/,
    );
  });

  it('proposer patch carries edits to SKILL.md and PURPOSE.md together', () => {
    ok(ProposerOutputSchema, {
      action: 'patch',
      outlet: 'skill',
      name: 'greenlight-build',
      patterns: ['pattern/probe-touches-wrong-layer'],
      edits: [
        {
          file: 'SKILL.md',
          op: 'insert_after',
          target: '## Rules',
          text: '\n- probe only the layer at risk',
        },
        { file: 'PURPOSE.md', op: 'append', text: '\n  - id: pattern/probe-touches-wrong-layer' },
      ],
    });
  });

  it('refuses edits that escape the target directory', () => {
    bad(ProposerOutputSchema, {
      action: 'patch',
      outlet: 'skill',
      name: 's',
      patterns: ['p'],
      edits: [{ file: '../other/SKILL.md', op: 'append', text: 'x' }],
    });
  });

  it('a proposal must cite a pattern; no_action needs a reason', () => {
    bad(ProposerOutputSchema, {
      action: 'issue',
      outlet: 'doctor',
      title: 't',
      body: 'b',
      patterns: [],
    });
    bad(ProposerOutputSchema, { action: 'no_action', reason: '' });
  });

  it('touchesVersion flags any edit to the version field', () => {
    const p = ProposerOutputSchema.parse({
      action: 'patch',
      outlet: 'skill',
      name: 's',
      patterns: ['p'],
      edits: [{ file: 'SKILL.md', op: 'replace', target: 'version: "3"', text: 'version: "4"' }],
    });
    expect(touchesVersion(p)).toBe(true);
  });
});

describe('bench (M0-03)', () => {
  const task = {
    id: 'loop/fixture-preview-before-push',
    kind: 'loop',
    graders: ['trajectory'],
    cell: 'astro/workers/none',
    skills: ['deploy-verify-promote'],
    fidelity: 'runtime',
    split: 'val',
    state: 'pending',
    timeoutMin: 20,
    trajectory: {
      rules: [
        {
          rule: 'before',
          first: { cmd: 'greenlight', args: ['preview', '*'], meta: { passed: 'true' } },
          next: { cmd: 'git', args: ['push', 'origin', 'develop'] },
        },
      ],
    },
    mutants: [
      {
        id: 'push-first',
        grader: 'trajectory',
        description: 'push recorded before any preview',
        kind: 'trajectory',
      },
    ],
  };

  it('accepts a loop task with trajectory rules and a mutant per grader', () => {
    ok(TaskSpecSchema, task);
    expect(TaskSpecSchema.parse(task).modes).toEqual(['isolation', 'production']);
  });

  it('enforces the kind prefix, required fields and grader↔mutant coverage', () => {
    bad(TaskSpecSchema, { ...task, id: 'replay/x' }, /starts with "loop\/"/);
    bad(TaskSpecSchema, { ...task, trajectory: undefined }, /trajectory rules are required/);
    bad(TaskSpecSchema, { ...task, graders: ['trajectory', 'app'] }, /grader "app" has no mutant/);
    bad(TaskSpecSchema, { ...task, mutants: [] }, /at least one mutant/);
    bad(TaskSpecSchema, { ...task, kind: 'replay', id: 'replay/x' }, /needs a pattern/);
    bad(TaskSpecSchema, { ...task, state: 'quarantined' }, /quarantineReason/);
  });

  it('count rules need a bound and a sane range', () => {
    bad(TrajectoryRuleSchema, { rule: 'count', match: { cmd: 'git' } }, /min or max/);
    bad(
      TrajectoryRuleSchema,
      { rule: 'count', match: { cmd: 'git' }, min: 3, max: 1 },
      /min must be/,
    );
    ok(TrajectoryRuleSchema, { rule: 'count', match: { cmd: 'git' }, max: 0 });
  });

  const identity: BaselineIdentity = {
    taskSetHash: H('1'),
    splitsHash: H('2'),
    graderSetHash: H('3'),
    depsHash: H('4'),
    harness: { runnerVersion: '0.1.0', imageDigest: 'sha256:abc' },
    agent: { vendor: 'greenlight-harness', version: '0.1.0' },
    models: ['gemini-3.8-flash', 'gemini-3.6-flash'],
    skillSetHash: H('5'),
    mode: 'isolation',
    wikiSnapshotHash: null,
    proxyPolicyHash: null,
  };

  it('identities are comparable iff only the skill set differs', () => {
    ok(BaselineIdentitySchema, identity);
    expect(comparable(identity, { ...identity, skillSetHash: H('6') })).toBe(true);
    for (const change of [
      { taskSetHash: H('7') },
      { graderSetHash: H('7') },
      { splitsHash: H('7') },
      { depsHash: H('7') },
      { models: ['gemini-3.8-flash'] },
      { agent: { vendor: 'greenlight-harness', version: '0.2.0' } },
      { harness: { runnerVersion: '0.1.0', imageDigest: 'sha256:def' } },
      { proxyPolicyHash: H('8') },
    ]) {
      const other = { ...identity, ...change } as BaselineIdentity;
      expect(comparable(identity, other), JSON.stringify(change)).toBe(false);
      expect(identityDiff(identity, other)).toEqual(Object.keys(change));
    }
  });

  it('production mode needs a wiki snapshot', () => {
    bad(BaselineIdentitySchema, { ...identity, mode: 'production' }, /wikiSnapshotHash/);
  });

  const outcome: EvaluationRecord['outcomes'][number] = {
    task: 'loop/x',
    run: 1,
    model: 'gemini-3.8-flash',
    mode: 'isolation',
    score: 1,
    graders: [{ kind: 'trajectory', passed: true }],
    seed: 's',
    rawId: 'r',
    durationMs: 5,
    servedBy: 'gemini-3.8-flash',
    cost: { usd: 0, requests: 12, tokensIn: 100, tokensOut: 20 },
  };

  it('evaluation records are content-addressed and internally consistent', () => {
    const rec = sealRecord({ identity, role: 'baseline', createdAt: TS, outcomes: [outcome] });
    ok(EvaluationRecordSchema, rec);
    bad(EvaluationRecordSchema, { ...rec, role: 'release-check' }, /hash/);
    bad(
      EvaluationRecordSchema,
      sealRecord({ identity, role: 'candidate', createdAt: TS, outcomes: [outcome] }),
      /names its proposal/,
    );
    bad(
      EvaluationRecordSchema,
      sealRecord({ identity, role: 'baseline', createdAt: TS, outcomes: [outcome, outcome] }),
      /duplicate outcome/,
    );
    bad(
      EvaluationRecordSchema,
      sealRecord({
        identity,
        role: 'baseline',
        createdAt: TS,
        outcomes: [{ ...outcome, score: 0 }],
      }),
      /score is 1 iff/,
    );
    const { createdAt: _c, ...undated } = rec;
    bad(EvaluationRecordSchema, undated);
  });

  it('gate input records are content-addressed and canonical (08 §10.4)', () => {
    const input = sealGateInput({
      kind: 'gate-input',
      proposalId: 'prop-1',
      ts: TS,
      outlet: 'skill',
      radius: 'medium',
      path: 'standard',
      seed: 'gate:prop-1',
      config: {
        alpha: 0.05,
        runs: 3,
        resamples: 1000,
        acceptShorterOnTie: false,
        maxBaselineAgeDays: 30,
      },
      models: { frontier: 'gemini-3.8-flash', small: 'gemini-3.6-flash' },
      modes: ['isolation'],
      modesDeclared: true,
      acceptedSkillSetHash: H('5'),
      candidateSkillSetHash: H('6'),
      tasks: [
        { id: 'loop/x', kind: 'loop', state: 'active', modes: ['isolation', 'production'] },
        { id: 'replay/y', kind: 'replay', state: 'pending', modes: ['isolation'] },
      ],
      baselineRecords: [H('a')],
      candidateRecords: [H('b')],
    });
    ok(GateInputRecordSchema, input);
    expect(evalEvidencePath(input.hash)).toBe(`evidence/eval/${input.hash}.json`);
    bad(GateInputRecordSchema, { ...input, seed: 'other' }, /hash/);
    const reseal = (over: Record<string, unknown>) => {
      const { hash: _h, ...rest } = input;
      return sealGateInput({ ...rest, ...over } as never);
    };
    bad(GateInputRecordSchema, reseal({ tasks: [...input.tasks].reverse() }), /sorted by id/);
    bad(
      GateInputRecordSchema,
      reseal({ modes: ['production', 'isolation'] }),
      /isolation, production order/,
    );
    bad(GateInputRecordSchema, reseal({ candidateRecords: [H('b'), H('c')] }), /one baseline/);
    bad(GateInputRecordSchema, reseal({ candidateSkillSetHash: H('5') }), /equals the accepted/);
    bad(GateInputRecordSchema, reseal({ outlet: 'template' }), /template results/);
  });

  it('the models config needs two distinct gate models', () => {
    const entry = (id: string) => ({ id, limits: { rpm: 5, rpd: 100 } });
    const cfg = {
      provider: 'gemini',
      keyEnv: 'GEMINI_API_KEY',
      temperature: 0.2,
      roles: {
        frontier: { ...entry('gemini-3.8-flash'), fallback: 'gemini-3.6-flash' },
        small: entry('gemini-3.6-flash'),
        maintainer: 'frontier',
        proposer: 'frontier',
        judge: 'small',
      },
    };
    ok(ModelsConfigSchema, cfg);
    bad(
      ModelsConfigSchema,
      { ...cfg, roles: { ...cfg.roles, small: entry('gemini-3.8-flash') } },
      /two different models/,
    );
  });
});
