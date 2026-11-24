import { describe, expect, it } from 'vitest';
import {
  bundleExcerpt,
  compareVersions,
  isAgentVisible,
  parseSampleSpec,
  parseSplits,
  sampleRecords as sampleWith,
  splitOf,
} from '../sample';
import { fixtureSplits, rec } from './raw-fixtures';

const splits = fixtureSplits();
const sampleRecords = (
  records: Parameters<typeof sampleWith>[0],
  opts: Parameters<typeof sampleWith>[1],
) => sampleWith(records, { splits, ...opts });

const ids = (rs: { rawId: string }[]) => rs.map((r) => r.rawId.slice(-8));

describe('sampleRecords (06 §3.2)', () => {
  const pool = [
    rec({ id: '00000001', split: 'train', wikiHits: ['pattern/x'] }),
    rec({ id: '00000002', split: 'train' }),
    rec({ id: '00000003' }),
    rec({ id: '00000004', split: 'train', wikiHits: ['pattern/y'] }),
    rec({ id: '00000005', split: 'val' }),
    rec({ id: '00000006', split: 'test' }),
    rec({ id: '00000007', passed: true, split: 'train' }),
    rec({ id: '00000008', passed: true, tool: 'other-tool' }),
    rec({ id: '00000009', passed: true, split: 'val' }),
  ];

  it('never samples a val or test record, whatever the limits', () => {
    const s = sampleRecords(pool, { seed: 's', failing: 100, passing: 100 });
    expect(ids([...s.failing, ...s.passing])).not.toContain('00000005');
    expect(ids([...s.failing, ...s.passing])).not.toContain('00000006');
    expect(ids([...s.failing, ...s.passing])).not.toContain('00000009');
  });

  it('takes the split from bench/splits.json by task id, never from the record', () => {
    // Self-declared train, but splits.json lists the task as val.
    const liar = rec({ id: '0000000d', split: 'train', task: 'replay/fixture-task-val' });
    // A bench record whose task splits.json does not list.
    const unknown = rec({ id: '0000000e', split: 'train', task: 'replay/not-in-splits-train' });
    const train = rec({ id: '0000000f', split: 'train' });
    const field = rec({ id: '00000010' });
    expect(splitOf(liar, splits)).toBe('val');
    expect(isAgentVisible(liar, splits)).toBe(false);
    expect(splitOf(unknown, splits)).toBeUndefined();
    expect(isAgentVisible(unknown, splits)).toBe(false);
    expect(isAgentVisible(train, splits)).toBe(true);
    // Without splits.json no bench record is visible; field records always are.
    expect(isAgentVisible(train)).toBe(false);
    expect(isAgentVisible(field)).toBe(true);
    const s = sampleWith([liar, unknown, train, field], { seed: 's', failing: 9, splits });
    expect(ids(s.failing).sort()).toEqual(['0000000f', '00000010']);
    expect(ids(sampleWith([liar, unknown, train, field], { seed: 's' }).failing)).toEqual([
      '00000010',
    ]);
  });

  it('parses splits.json strictly', () => {
    expect(parseSplits('{"a":"train","b":"val"}').get('b')).toBe('val');
    expect(() => parseSplits('{"a":"holdout"}')).toThrow(/split/);
    expect(() => parseSplits('[]')).toThrow(/object/);
  });

  it('is deterministic for a seed and independent of input order', () => {
    const a = sampleRecords(pool, { seed: 'seed-1' });
    const b = sampleRecords([...pool].reverse(), { seed: 'seed-1' });
    expect(ids(a.failing)).toEqual(ids(b.failing));
    expect(ids(a.passing)).toEqual(ids(b.passing));
  });

  it('ranks unexplained failures (empty wikiHits) first', () => {
    for (const seed of ['a', 'b', 'c', 'd']) {
      const s = sampleRecords(pool, { seed });
      expect(ids(s.failing.slice(0, 2)).sort()).toEqual(['00000002', '00000003']);
      expect(ids(s.failing.slice(2)).sort()).toEqual(['00000001', '00000004']);
    }
  });

  it('ranks failures from the newest skill version next', () => {
    const recs = [
      rec({ id: '0000000a', skill: { name: 'sk', version: '9' }, wikiHits: ['p'] }),
      rec({ id: '0000000b', skill: { name: 'sk', version: '10' }, wikiHits: ['p'] }),
      rec({ id: '0000000c', skill: { name: 'sk', version: '9' } }),
    ];
    for (const seed of ['a', 'b', 'c']) {
      expect(ids(sampleRecords(recs, { seed, skill: 'sk' }).failing)).toEqual([
        '0000000c',
        '0000000b',
        '0000000a',
      ]);
    }
  });

  it('prefers passing records in the same cell as a sampled failure, and honours the limits', () => {
    for (const seed of ['a', 'b', 'c']) {
      const s = sampleRecords(pool, { seed, failing: 1, passing: 1 });
      expect(s.failing).toHaveLength(1);
      expect(ids(s.passing)).toEqual(['00000007']);
    }
  });

  it('a different seed can reorder ties', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      rec({ id: `000000${(i + 16).toString(16)}`, split: 'train' }),
    );
    const orders = new Set(
      ['1', '2', '3', '4', '5'].map((seed) => ids(sampleRecords(many, { seed }).failing).join()),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('truncation and parsing', () => {
  it('keeps the failing-check list ahead of the output tail', () => {
    const text = `${'x'.repeat(200)}\n  FAIL the check that matters\n${'y'.repeat(200)}`;
    const out = bundleExcerpt(text, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.startsWith('  FAIL the check that matters\n')).toBe(true);
    expect(out).toContain('…[truncated');
    expect(out.endsWith('y')).toBe(true);
  });

  it('truncates the list itself head-first when it alone exceeds the budget', () => {
    const list = Array.from({ length: 40 }, (_, i) => `FAIL check ${i}`).join('\n');
    const out = bundleExcerpt(list, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/^…\[truncated \d+ chars\]…/);
    expect(out.endsWith('FAIL check 39')).toBe(true);
  });

  it('parses --sample and orders versions numerically', () => {
    expect(parseSampleSpec('5:3')).toEqual({ failing: 5, passing: 3 });
    expect(() => parseSampleSpec('5')).toThrow(/failing/);
    expect(compareVersions('10', '9')).toBe(1);
    expect(compareVersions('1.9', '1.10')).toBe(-1);
  });
});

describe('harness failures are not training evidence', () => {
  it('excludes bench records whose retained verdict is unknown', () => {
    const real = rec({ id: '0000000a', split: 'train' });
    const base = rec({ id: '0000000b', split: 'train' });
    const harness = { ...base, retained: { ...base.retained, verdict: 'unknown' as const } };
    const out = sampleRecords([real, harness], { seed: 's' });
    expect(ids(out.failing)).toEqual(['0000000a']);
  });
});
