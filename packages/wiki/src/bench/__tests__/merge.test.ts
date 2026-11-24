import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acceptedSkillSetState, appendEvents, readGateSkillSets } from '../../ledger';
import { LEDGER_FILE, SKILL_IMPACT_FILE, parseLedger } from '../../load';
import { type GateInputRecord, evalEvidencePath, sealGateInput } from '../../schema/bench';
import { type LedgerEvent, sealEvent } from '../../schema/ledger';
import { skillSetHashOf } from '../identity';
import { IterationError, unrecordedMerge } from '../iterate';
import { recordMerge } from '../merge';

const FIXTURES = join(__dirname, 'fixtures', 'merge');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const skill = (dir: string, name: string, body: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`,
  );
};

/** A wiki whose ledger holds one accepted skill proposal, gated from `base` to `candidate`. The
 * gate input and the accepted event are real records (fixtures) re-sealed over these two sets. */
function world(over: { control?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'greenlight-merge-'));
  dirs.push(root);
  const base = join(root, 'base');
  const candidate = join(root, 'candidate');
  const other = join(root, 'other');
  skill(base, 'greenlight-wiki', 'Compile evidence.');
  skill(candidate, 'greenlight-wiki', 'Compile evidence.\n\nCite every sentence.');
  skill(other, 'greenlight-wiki', 'Compile evidence.\n\nCite every sentence. And more.');
  const wiki = join(root, 'wiki');
  const { hash: _h, ...gi } = JSON.parse(
    readFileSync(join(FIXTURES, 'gate-input.json'), 'utf8'),
  ) as GateInputRecord;
  const gateInput = sealGateInput({
    ...gi,
    acceptedSkillSetHash: skillSetHashOf(base),
    candidateSkillSetHash: skillSetHashOf(candidate),
  });
  const giFile = join(wiki, evalEvidencePath(gateInput.hash));
  mkdirSync(dirname(giFile), { recursive: true });
  writeFileSync(giFile, `${JSON.stringify(gateInput, null, 2)}\n`);
  const {
    eventId: _e,
    writer: _w,
    ...accepted
  } = JSON.parse(readFileSync(join(FIXTURES, 'accepted-event.json'), 'utf8')) as LedgerEvent;
  if (accepted.evidence?.kind !== 'bench') throw new Error('fixture: bench evidence expected');
  const event = sealEvent({
    ...accepted,
    ...(over.control ? { control: true } : {}),
    evidence: { ...accepted.evidence, gateInput: gateInput.hash },
  });
  appendEvents(wiki, [event]);
  const ledger = () => parseLedger(readFileSync(join(wiki, LEDGER_FILE), 'utf8')).events;
  const acceptedSet = () => acceptedSkillSetState(ledger(), (h) => readGateSkillSets(wiki, h)).hash;
  return { wiki, base, candidate, other, id: event.proposalId as string, ledger, acceptedSet };
}

const refusal = (fn: () => unknown): IterationError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof IterationError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('bench merged: recording a merge (06 §6.1)', () => {
  it('moves the accepted skill set to the gated candidate, once', () => {
    const w = world();
    expect(w.acceptedSet()).toBe(skillSetHashOf(w.base));
    expect(unrecordedMerge(w.wiki, skillSetHashOf(w.candidate))).toBe(w.id);
    const r = recordMerge({
      wikiRoot: w.wiki,
      skillsDir: w.candidate,
      proposalId: w.id,
      ref: 'https://example.test/pull/1',
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(r.already).toBe(false);
    expect(r.event.stage).toBe('merged');
    expect(r.event.change).toEqual({ kind: 'pr', ref: 'https://example.test/pull/1' });
    expect(r.acceptedSkillSetHash).toBe(skillSetHashOf(w.candidate));
    expect(w.acceptedSet()).toBe(skillSetHashOf(w.candidate));
    expect(unrecordedMerge(w.wiki, skillSetHashOf(w.candidate))).toBeUndefined();
    expect(readFileSync(join(w.wiki, SKILL_IMPACT_FILE), 'utf8')).toMatch(/merged/);

    // Idempotent: a second call writes nothing and returns the same event.
    const before = w.ledger().length;
    const again = recordMerge({
      wikiRoot: w.wiki,
      skillsDir: w.candidate,
      proposalId: w.id,
      ref: 'another-ref',
    });
    expect(again.already).toBe(true);
    expect(again.event.eventId).toBe(r.event.eventId);
    expect(w.ledger().length).toBe(before);
  });

  it('refuses a tree the gate never evaluated, and says which case it is', () => {
    const w = world();
    const edited = refusal(() =>
      recordMerge({ wikiRoot: w.wiki, skillsDir: w.other, proposalId: w.id, ref: 'abc' }),
    );
    expect(edited.exitCode).toBe(4);
    expect(edited.message).toMatch(/not the candidate the gate evaluated/);
    const unmerged = refusal(() =>
      recordMerge({ wikiRoot: w.wiki, skillsDir: w.base, proposalId: w.id, ref: 'abc' }),
    );
    expect(unmerged.exitCode).toBe(4);
    expect(unmerged.message).toMatch(/still the pre-merge set/);
    expect(w.ledger().some((e) => e.stage === 'merged')).toBe(false);
    expect(w.acceptedSet()).toBe(skillSetHashOf(w.base));
  });

  it('refuses a control-arm proposal, an unknown proposal and a missing ref', () => {
    const control = world({ control: true });
    const c = refusal(() =>
      recordMerge({
        wikiRoot: control.wiki,
        skillsDir: control.candidate,
        proposalId: control.id,
        ref: 'abc',
      }),
    );
    expect(c.exitCode).toBe(4);
    expect(c.message).toMatch(/control-arm/);
    expect(unrecordedMerge(control.wiki, skillSetHashOf(control.candidate))).toBeUndefined();

    const w = world();
    expect(
      refusal(() =>
        recordMerge({
          wikiRoot: w.wiki,
          skillsDir: w.candidate,
          proposalId: 'prop-nope',
          ref: 'a',
        }),
      ).exitCode,
    ).toBe(2);
    expect(
      refusal(() =>
        recordMerge({ wikiRoot: w.wiki, skillsDir: w.candidate, proposalId: w.id, ref: '  ' }),
      ).exitCode,
    ).toBe(2);
  });

  it('refuses a proposal that is not at candidate-accepted (withdrawn after acceptance)', () => {
    const w = world();
    appendEvents(w.wiki, [
      sealEvent({
        ts: '2031-01-01T00:00:00.000Z',
        proposalId: w.id,
        stage: 'withdrawn',
        reason: 'abandoned',
      }),
    ]);
    const r = refusal(() =>
      recordMerge({ wikiRoot: w.wiki, skillsDir: w.candidate, proposalId: w.id, ref: 'abc' }),
    );
    expect(r.exitCode).toBe(4);
    expect(r.message).toMatch(/stage "withdrawn"/);
  });
});
