import { describe, expect, it } from 'vitest';
import { parseFlags } from '../args';

describe('parseFlags', () => {
  it('separates positionals, value flags, and boolean flags', () => {
    const p = parseFlags('verify', ['blog', '--env', 'prod', '--json'], {
      value: ['--env'],
      boolean: ['--json'],
    });
    expect(p.positional).toEqual(['blog']);
    expect(p.values['--env']).toBe('prod');
    expect(p.flags.has('--json')).toBe(true);
  });

  it('rejects an unknown flag instead of silently ignoring it (the typo footgun)', () => {
    expect(() => parseFlags('verify', ['blog', '--waitt', '30'], { value: ['--wait'] })).toThrow(
      /unknown flag "--waitt"/,
    );
  });

  it('lists the known flags in the unknown-flag error', () => {
    expect(() => parseFlags('deploy', ['--bogus'], { value: ['--env'] })).toThrow(/--env/);
  });

  it('requires a value for a value flag', () => {
    expect(() => parseFlags('deploy', ['blog', '--env'], { value: ['--env'] })).toThrow(
      /--env needs a value/,
    );
  });

  it('keeps positional order across interleaved flags', () => {
    const p = parseFlags('secrets', ['gather', '--repo', 'o/r', 'bamcp'], {
      value: ['--repo'],
    });
    expect(p.positional).toEqual(['gather', 'bamcp']);
  });

  it('accepts no flags at all', () => {
    const p = parseFlags('status', ['blog']);
    expect(p.positional).toEqual(['blog']);
    expect(p.values).toEqual({});
    expect(p.flags.size).toBe(0);
  });
});
