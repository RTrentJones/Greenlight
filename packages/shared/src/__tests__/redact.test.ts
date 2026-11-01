import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSecrets, isCodeExpression, redact } from '../redact';

// Vision 11 §6: plant one example of every shape, plus known values, and assert zero survivors.
// Samples are assembled at runtime so this file itself never contains a token-shaped literal.

const alnum = (n: number, seed = 'Ab3'): string =>
  seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const basic = (userPass: string): string => Buffer.from(userPass).toString('base64');
/** A random base62 token with no recognizable prefix: only key-name context can find it. */
const RANDOM = ['Zk3q', '9TnW', '2vLp', '8RxY'].join('');

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
  ['postgres-password', 'DATABASE_URL=postgresql://app:%s@db.example.com/x', 'pa55w0rdValue'],
  ['url-password', 'mysql://root:%s@127.0.0.1:3306/app', 'my5qlPassw0rd'],
  ['url-password', 'REDIS_URL=redis://default:%s@cache.example.com:6379', 'r3disPassw0rd'],
  ['url-password', 'REDIS_URL=rediss://:%s@cache.example.com:6380', 'r3disPassw0rd'],
  ['url-password', 'mongodb+srv://app:%s@cluster0.example.net/db', 'm0ngoPassw0rd'],
  ['bearer', 'Authorization: Bearer %s', alnum(40)],
  ['basic-auth', 'Authorization: Basic %s', basic('deploy:hunter2-hunter2')],
  ['basic-auth', '> authorization: Basic %s', basic('ci-bot:s3cr3t')],
  ['cloudflare', 'CF_API_TOKEN=%s', alnum(40)],
  ['vercel', 'VERCEL_DEPLOY_TOKEN=%s', alnum(24)],
  ['generic', 'password: %s', 'correct-horse-battery'],
  ['generic', '"api_key": "%s"', 'zz9-plural-z-alpha'],
  // Key names with a prefix: no word boundary before the keyword (9a).
  ['generic', 'GITHUB_TOKEN=%s', 'hunter2hunter2xyz'],
  ['generic', 'DB_PASSWORD=%s', 'Sup3rS3cretPass'],
  ['generic', 'MY_API_KEY=%s', 'k3y-value-0001'],
  ['generic', 'ACCESS_TOKEN: %s', 'tok-abcdef-123456'],
  ['generic', 'client_secret: %s', 'cl1ent-s3cret-value'],
  ['generic', 'PGPASSWORD=%s psql -h db', 'pgPassw0rdValue'],
  ['generic', 'export SECRET_KEY="%s"', 'django-insecure-abc123'],
  ['generic', 'passwd=%s', 'pa55wd-literal'],
  // Literal secrets inside source code are still caught (9b).
  ['generic', "const headers = { apikey: '%s' };", 'literal-anon-key-value'],
  ['generic', 'fetch(url, { headers: { token: "%s" } })', 'abcdefgh12345678'],
  ['generic', 'const apiKey = `%s`;', 'templated-literal-key'],
  // A random token is not an identifier, even before `,` `;` `)` (the code-expression exemption
  // must not swallow it), and an unspaced `key=value` is never code.
  ['generic', 'request failed (token=%s)', RANDOM],
  ['generic', 'secret=%s;', RANDOM],
  ['generic', 'apikey=%s, retrying', RANDOM],
  ['generic', 'const headers = { token: %s, other };', RANDOM],
  ['generic', 'connect({ password: %s })', RANDOM],
  ['generic', 'api_key = %s;', `zk${RANDOM}`],
  // Quoted literals inside a code expression: a `||` / `??` fallback, a ternary, a call argument.
  ['generic', 'const token = process.env.X || "%s"', RANDOM],
  ['generic', 'const token = env?.TOKEN ?? `%s`;', RANDOM],
  ['generic', "const secret = isProd ? cfg.secret : '%s';", RANDOM],
  ['generic', 'password: decrypt("%s")', RANDOM],
  ['generic', "apiKey: Buffer.from('%s', 'base64'),", RANDOM],
  // Env-style `KEY=value`: a dotted value is a value, not a member chain.
  ['generic', 'PGPASSWORD=%s', 'correct.horse.battery.staple'],
  ['generic', 'PGPASSWORD = %s', 'correct.horse.battery.staple'],
  ['generic', 'export DB_PASSWORD=%s', 'hunter2.hunter2'],
  ['generic', 'GET /v1/items?api_key=%s&page=2', 'abc.def.ghi.jkl'],
  ['cloudflare', 'CLOUDFLARE_API_TOKEN=%s', 'cfg.token.value'],
  [
    'private-key',
    'key:\n%s\nafter',
    `${'-----BEGIN '}RSA PRIVATE KEY-----\nMIIEow\n${'-----END '}RSA PRIVATE KEY-----`,
  ],
];

const REPO = resolve(__dirname, '../../../..');

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

describe('findSecrets / redact', () => {
  it.each(SAMPLES)('finds and redacts a %s secret in %j', (kind, line, secret) => {
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
    ['an agent placeholder', 'GITHUB_TOKEN=gl-placeholder-GITHUB_TOKEN'],
    ['a member access passed along', 'headers = { apikey: t.anonKey, Authorization: x };'],
    ['a member access at end of line', 'const KEY = { apikey: config.anonKey };'],
    ['optional chaining', 'const token = env?.GEMINI_API_KEY ?? fallback;'],
    ['a function call', 'password: z.string().min(1),'],
    ['a call with arguments', 'const token = await getToken(scope);'],
    ['an index expression', 'const secret = m[group];'],
    ['a bare identifier argument', 'connect({ password: dbPassword, host })'],
    ['a type annotation', 'secret: string][] = ['],
    ['an undefined value', 'apiToken: undefined,'],
    [
      'an env-var name as value',
      "tokenOverrides: { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN_X' }",
    ],
    ['an HCL interpolation', 'access_token = var.${name}_supabase_access_token'],
    ['an explicit placeholder', 'TF_VAR_x_database_password=import-placeholder'],
    ['a markdown key list', 'a fine-grained token: `contents: write`'],
    ['Basic in prose', 'Basic authentication is disabled; use Basic authorization headers.'],
    ['a URL without a password', 'redis://cache.example.com:6379 and https://example.com/a:b'],
    ['a URL password reference', 'postgres://app:${DB_PASSWORD}@db.example.com/x'],
    ['a comparison', 'if (token === other) return;'],
  ])('does not flag %s', (_n, text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  // Code expressions taken verbatim from this repo's source, emitted IaC and vendored fixtures:
  // a credential passed along by name is not a leak.
  it.each([
    // packages/keepalive/src/index.ts (and every vendored keepalive worker under bench/)
    [
      'keepalive probe headers',
      'headers = { apikey: t.anonKey, Authorization: `Bearer ${t.anonKey}` };',
    ],
    [
      'keepalive alert sink',
      '{ githubRepo: env.ALERT_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },',
    ],
    [
      'keepalive dispatch sink',
      '{ dispatchRepo: env.DISPATCH_GITHUB_REPO, githubToken: env.GITHUB_TOKEN },',
    ],
    ['keepalive bearer header', 'Authorization: `Bearer ${sink.githubToken}`,'],
    // packages/verify/src/eval.ts, agent-web.ts
    ['an SDK key from env', 'apiKey: process.env.ANTHROPIC_API_KEY,'],
    ['a constructor option type', 'default: new (o: { apiKey: string; timeout?: number }) => {'],
    // packages/wiki/src/llm/models.ts
    ['a pagination token fallback', 'pageToken = data.nextPageToken || undefined;'],
    // cli/src/tf-emit.ts
    ['an override map', "'tokenOverrides.NEON_API_KEY': opts.tokenOverrides?.NEON_API_KEY,"],
    ['an emitted tunnel token', '  tunnel_token   = module.bamcp_tunnel.token'],
    ['an emitted Neon key', '  api_key = var.notes_neon_api_key'],
    // cli/src/commands/ship.ts
    ['an ingest token from env', 'const token = process.env.TRACER_INGEST_TOKEN;'],
    // cli/src/commands/adopt.ts, init.ts (workflow YAML)
    ['a workflow secret', '          password: ${{ secrets.GITHUB_TOKEN }}'],
    ['a workflow github.token', '  GITHUB_TOKEN: ${{ github.token }} # github provider'],
    // bench/fixtures/*-shaped/server.mjs, bench/fixtures/*/infra/keepalive.tf
    [
      'a generated admin token',
      "const adminToken = options.adminToken ?? randomBytes(16).toString('hex');",
    ],
    ['a keepalive tf var', '  github_token      = var.keepalive_github_token'],
    // infra/modules/supabase/main.tf, infra/modules/tunnel/main.tf
    ['a module var', '  database_password       = var.database_password'],
    ['an OAuth client secret var', '      external_discord_secret    = var.discord_client_secret'],
    ['a random_bytes attribute', '  tunnel_secret = random_bytes.tunnel_secret.base64'],
    ['an encoded token', '  token = base64encode(jsonencode({'],
    // tools/_template-agent/src/index.ts
    ['a bearer check', 'if (!env.RUN_TOKEN || auth !== `Bearer ${env.RUN_TOKEN}`) {'],
    // Common shapes the same code takes elsewhere: names, not values, in call arguments.
    ['an env lookup by name', "const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');"],
    ['a storage key', "token: localStorage.getItem('supabase.auth.token'),"],
    ['an input name', "const token = core.getInput('github-token');"],
    ['a validation message', "password: z.string().min(8, 'Password must be at least 8 chars'),"],
    ['a header name', "const apiKey = req.headers.get('x-api-key');"],
    ['an index by name', 'const token = process.env["GITHUB_TOKEN"];'],
    ['a snake_case identifier', 'connect({ password: db_password, user })'],
    ['a digit-suffixed identifier', 'const client = new Octokit({ token: oauth2Token, baseUrl });'],
  ])('does not flag repo code: %s', (_n, text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  it('reports overlapping shapes once', () => {
    const token = `${'gh'}p_${alnum(36)}`;
    const found = findSecrets(`Authorization: Bearer ${token}`);
    expect(found).toHaveLength(1);
  });

  it('tells code expressions from literals', () => {
    expect(isCodeExpression('t.anonKey,')).toBe(true);
    expect(isCodeExpression('anonKey,')).toBe(true);
    expect(isCodeExpression('getToken()')).toBe(true);
    expect(isCodeExpression('Sup3rS3cretPass')).toBe(false);
    expect(isCodeExpression('correct-horse-battery')).toBe(false);
    expect(isCodeExpression('abc123/def456+xyz=')).toBe(false);
    // A random token before a terminator is not an identifier.
    expect(isCodeExpression(`${RANDOM},`)).toBe(false);
    expect(isCodeExpression(`${RANDOM})`)).toBe(false);
    expect(isCodeExpression(`zk${RANDOM};`)).toBe(false);
    expect(isCodeExpression('serviceRoleKey,')).toBe(true);
    expect(isCodeExpression('process.env.GITHUB_TOKEN,')).toBe(true);
  });

  it('reports a log-line value without its trailing punctuation', () => {
    const text = `request failed (token=${RANDOM}), secret=${RANDOM};`;
    expect(redact(text)).toBe(
      'request failed (token=gl-redacted-generic), secret=gl-redacted-generic;',
    );
  });

  // The detector guards the LLM send guard and bundles: the repo's own source must scan clean, or
  // legitimate work is refused. Test fixtures (`__tests__`) plant secrets on purpose.
  it('scans the repo source clean', () => {
    const roots = ['packages', 'cli/src', 'bench/fixtures', 'bench/graders'].map((r) =>
      join(REPO, r),
    );
    const isSource = (f: string): boolean => {
      const rel = relative(REPO, f);
      if (rel.startsWith('bench/')) return true;
      if (rel.split('/').includes('__tests__')) return false;
      return rel.startsWith('cli/src/')
        ? rel.endsWith('.ts')
        : /^packages\/[^/]+\/src\/.*\.ts$/.test(rel);
    };
    let scanned = 0;
    const flagged: string[] = [];
    for (const root of roots) {
      for (const f of files(root)) {
        if (!isSource(f)) continue;
        scanned += 1;
        for (const s of findSecrets(readFileSync(f, 'utf8'))) {
          flagged.push(`${relative(REPO, f)}@${s.index}: ${s.kind}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(flagged).toEqual([]);
  });

  // 9b: every vendored source file a rollout reads or sends must scan clean, or the harness would
  // refuse the bundle; a credential passed along in code (`apikey: t.anonKey`) is not a leak.
  it('scans every file under bench/fixtures and bench/tasks/*/fixture clean', () => {
    const roots = [join(REPO, 'bench/fixtures')];
    const tasks = join(REPO, 'bench/tasks');
    for (const family of readdirSync(tasks)) {
      for (const task of readdirSync(join(tasks, family))) {
        const f = join(tasks, family, task, 'fixture');
        if (existsSync(f)) roots.push(f);
      }
    }
    let scanned = 0;
    const flagged: string[] = [];
    for (const root of roots) {
      for (const f of files(root)) {
        scanned += 1;
        for (const s of findSecrets(readFileSync(f, 'utf8'))) {
          flagged.push(`${relative(REPO, f)}@${s.index}: ${s.kind}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(10);
    expect(flagged).toEqual([]);
  });
});
