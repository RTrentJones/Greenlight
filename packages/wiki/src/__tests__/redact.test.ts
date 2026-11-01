import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findSecrets, redact } from '../redact';

// Vision 11 §6: plant one example of every shape, plus known values, and assert zero survivors.
// Samples are assembled at runtime so this file itself never contains a token-shaped literal.

const alnum = (n: number, seed = 'Ab3'): string =>
  seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

const SAMPLES: [kind: string, line: string, secret: string][] = [
  ['github', 'push with %s', `${'gh'}p_${alnum(36)}`],
  ['github', 'refresh %s', `${'gh'}r_${alnum(40)}`],
  ['github', 'fine-grained %s', `${'github'}_pat_${alnum(62)}`],
  ['google', 'key=%s in a URL', `${'AI'}za${alnum(35)}`],
  ['anthropic', 'export X=%s', `${'sk-'}ant-${alnum(30)}`],
  ['openai', 'header %s', `${'sk-'}${alnum(40)}`],
  ['xai', 'header %s', `${'xai-'}${alnum(24)}`],
  ['aws', 'access key %s', `${'AK'}IA${'ABCDEFGH23456789'}`],
  ['neon', 'neon %s', `${'napi_'}${alnum(48)}`],
  ['supabase', 'supabase %s', `${'sbp_'}${alnum(40)}`],
  ['jwt', 'anon key %s', `${'eyJ'}hbGciOiJIUzI1NiJ9.${alnum(20)}.${alnum(20)}`],
  ['hcp', 'tfe %s', `${alnum(14)}.${'atlas'}v1.${alnum(64)}`],
  ['postgres-password', 'postgres://app:%s@db.example.com/x', 'pa55w0rdValue'],
  ['bearer', 'Authorization: Bearer %s', alnum(40)],
  ['cloudflare', 'CF_API_TOKEN=%s', alnum(40)],
  ['vercel', 'VERCEL_DEPLOY_TOKEN=%s', alnum(24)],
  ['generic', 'password: %s', 'correct-horse-battery'],
  ['generic', '"api_key": "%s"', 'zz9-plural-z-alpha'],
  [
    'private-key',
    'key:\n%s\nafter',
    `${'-----BEGIN '}RSA PRIVATE KEY-----\nMIIEow\n${'-----END '}RSA PRIVATE KEY-----`,
  ],
];

describe('findSecrets / redact', () => {
  it.each(SAMPLES)('finds and redacts a %s secret', (kind, line, secret) => {
    const text = line.replace('%s', secret);
    const [finding, ...rest] = findSecrets(text);
    expect(rest).toEqual([]);
    expect(finding?.kind).toBe(kind);
    expect(text.slice(finding?.index, (finding?.index ?? 0) + (finding?.length ?? 0))).toBe(secret);
    expect(redact(text)).toBe(line.replace('%s', `gl-redacted-${kind}`));
  });

  it('leaves zero survivors in a log planted with every shape and every known value', () => {
    const values = ['NEON_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN'].map(
      (name) => `${name}-${randomBytes(12).toString('hex')}`,
    );
    const log = [
      ...SAMPLES.map(([, line, secret]) => line.replace('%s', secret)),
      ...values.map(
        (v, i) =>
          `step ${i}: ${v} / ${encodeURIComponent(v)} / ${Buffer.from(v).toString('base64')}`,
      ),
    ].join('\n');
    const clean = redact(log, values);
    for (const [, , secret] of SAMPLES) expect(clean).not.toContain(secret);
    for (const v of values) {
      expect(clean).not.toContain(v);
      expect(clean).not.toContain(Buffer.from(v).toString('base64'));
    }
    expect(findSecrets(clean, values)).toEqual([]);
  });

  it('matches known values in URL-encoded and base64 form', () => {
    const v = 'p@ss word/123';
    const text = `a ${encodeURIComponent(v)} b ${Buffer.from(v).toString('base64')} c ${v}`;
    expect(findSecrets(text, [v]).map((f) => f.kind)).toEqual(['value', 'value', 'value']);
  });

  it('ignores values too short to match safely', () => {
    expect(findSecrets('abc abc', ['abc'])).toEqual([]);
  });

  it.each([
    ['a sha256', `commit ${'a1b2c3'.repeat(10)}abcd`],
    ['an env-var reference', 'token: ${{ secrets.GITHUB_TOKEN }}'],
    ['a placeholder', 'password: <your-password>'],
    ['prose about tokens', 'Set the GEMINI_API_KEY secret, then rotate tokens monthly.'],
    ['a kebab id', 'see pattern/task-abcdefghijklmnopqrstuvwxyzabcdefgh'],
    ['an already redacted value', 'token: gl-redacted-github'],
  ])('does not flag %s', (_n, text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  it('reports overlapping shapes once', () => {
    const token = `${'gh'}p_${alnum(36)}`;
    const found = findSecrets(`Authorization: Bearer ${token}`);
    expect(found).toHaveLength(1);
  });
});
