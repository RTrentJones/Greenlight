/**
 * The secret detector (vision 11 §6): one implementation for raw capture, `wiki ingest` bundles,
 * proxy response scrubbing, LR-20, `wiki contribute` and the LLM harness's send guard (06 §4.8).
 * It lives in `packages/shared` so every package that must refuse a leak can import it.
 *
 * It finds secrets two ways: by **shape** (always on — token formats with a recognizable prefix or
 * key-name context) and by **value** (literal values the caller holds, with their URL-encoded and
 * base64 forms, for secrets that have no shape). Findings never carry the secret text itself beyond
 * its offsets, so a report about a leak cannot become one.
 *
 * Context shapes (`password=…`, `CF_API_TOKEN: …`) flag values that look like literals and skip
 * values that are code expressions made of source-looking identifiers (`apikey: t.anonKey,`,
 * `token: getToken()`), so a vendored source file that merely passes a credential along is not
 * reported as leaking one. Quoted literals inside such an expression are still checked, and a
 * `key=value` pair with no spaces (a log line, an env file, a query string) is never code.
 */

export interface SecretFinding {
  kind: string;
  /** Offset of the secret part (for key=value shapes, the value only) and its length. */
  index: number;
  length: number;
}

interface Shape {
  kind: string;
  re: RegExp;
  /** Capture group holding the secret part; 0 (default) for the whole match. */
  group?: number;
  /** Extra check on the match; false drops it. */
  accept?: (m: RegExpMatchArray, secret: string) => boolean;
  /** A key-context shape: groups are 1 = separator with its spaces, 2 = opening quote, 3 = value. */
  context?: true;
}

/** Values shorter than this are too likely to occur by chance to match literally (11 §6). */
export const MIN_VALUE_LENGTH = 8;

/** Placeholders and references are names, not values: `$VAR`, `${{ secrets.X }}`, `<token>`,
 * `%TOKEN%`, an interpolation anywhere (`var.${name}_token`), a key that happens to follow
 * (`token: contents:`), or an explicit placeholder. */
const NOT_A_VALUE = /^(?:\$|<|%|gl-redacted-|gl-placeholder-)|\$\{|\{\{|:$|placeholder/i;
/** An env-var name (`GITHUB_TOKEN`, `'SUPABASE_ACCESS_TOKEN_HEISTMIND'`) after a key is a
 * reference to a secret, not the secret. */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/** JS/TS words that may follow `token:` in source without being a value. */
const CODE_WORDS = new Set(['undefined', 'null', 'true', 'false', 'string', 'number', 'boolean']);

const IDENT = '[A-Za-z_$][\\w$]*';
/** A member chain, index or call: `t.anonKey`, `env?.TOKEN`, `m[group]`, `config.get(...)`. */
const MEMBER_OR_CALL = new RegExp(`^${IDENT}(?:(?:\\?\\.|\\.)${IDENT}|\\[[^\\]]+\\])*(?:\\(.*)?$`);
/** A complete call or index (`getToken()`, `os.environ["X"]`): the only code an env-style or
 * log-style `KEY=value` may hold. */
const COMPLETE_CALL_OR_INDEX = new RegExp(
  `^${IDENT}(?:(?:\\?\\.|\\.)${IDENT})*(?:\\(.*\\)|\\[[^\\]]+\\])$`,
);
const HAS_ACCESS_OR_CALL = /\?\.|\.|\(|\[[^\]]+\]/;
/** What may close an expression: `,` `;` `)` `}` and `]`, or an array type suffix (`string[]`). */
const CODE_TERMINATOR = /[,;)[\]}]$/;

/** One camelCase word of an identifier part: an acronym (`URL` in `apiURLToken`), a capitalized or
 * lowercase word, a lone capital, or a digit run. */
const IDENT_WORD = /[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[A-Z]|\d+/g;

/**
 * True when one identifier (`anonKey`, `db_password`, `GITHUB_TOKEN`, `oauth2Client`) reads like a
 * name a person wrote rather than a random token. A shape test, not a dictionary: the identifier is
 * split on `_`/`$` and on camelCase humps, and it must have
 *
 * - at most one digit run, of at most 4 digits (`oauth2`, `sha256` — never `k3q9…p8`);
 * - no mixed-case acronym longer than 4 letters (`URL`, `HTTP`, `JSON`; random tokens produce
 *   capital runs such as `CIXUQ`), while a whole ALL_CAPS piece (`GITHUB`, `TOKEN`) is one word;
 * - at most one single-letter word (`xToken`; random tokens produce many: `TnW2vLp8RxY`);
 * - no word with a run of 5+ consonants (y counts as a vowel; `workflow` has 4, `qvhrtz` 6);
 * - with 2+ words, a mean word length of at least 3 (`dbPassword` 5, `serviceRoleKey` 4.7).
 *
 * Why shape rules and not a Shannon-entropy threshold: these values are 8–40 characters, too short
 * for per-character entropy to separate them (`serviceRoleKey` scores ≈3.2 bits/char,
 * `Zk3q9TnW2vLp8RxY` 4.0 — both near the log2(length) ceiling). The rules instead target what
 * uniform base62 does and hand-written code does not: a capital every ~2.4 letters, a digit every
 * ~6 characters, consonant clusters. Measured (200k samples per length, lowercase-led random
 * base62, i.e. tokens the bare-identifier rule could exempt at all): ~4.2% of 8-character, ~2.2% of
 * 16-character and ~0.3% of 24-character tokens pass (×26/62 for all random tokens: ~0.9% at
 * 16). Of the ~5,200 distinct lowercase-led identifiers and member chains of 8+ characters in this
 * repo's source and fixtures, 47 fail (`healthcheck`, `vi.spyOn`, `val.rawId`), which costs a false
 * positive only when one is the bare value of a secret-named key. The residual misses are bounded further by the context rules (a bare
 * identifier is exempt only before a terminator, and never in a `key=value` pair) and by value
 * matching for every secret the caller holds.
 */
function looksLikeIdentifier(ident: string): boolean {
  const words: string[] = [];
  let digitRuns = 0;
  for (const piece of ident.split(/[_$]+/)) {
    if (piece === '') continue;
    const caps = /^([A-Z]+)(\d{0,4})$/.exec(piece);
    if (caps) {
      words.push(caps[1] ?? '');
      if (caps[2]) digitRuns += 1;
      continue;
    }
    for (const w of piece.match(IDENT_WORD) ?? []) {
      if (/^\d/.test(w)) {
        digitRuns += 1;
        if (w.length > 4) return false;
      } else if (/^[A-Z]{5,}$/.test(w) || /[^aeiouy]{5}/i.test(w)) {
        return false;
      } else {
        words.push(w);
      }
    }
  }
  if (digitRuns > 1) return false;
  if (words.filter((w) => w.length === 1).length > 1) return false;
  const letters = words.reduce((n, w) => n + w.length, 0);
  return words.length < 2 || letters / words.length >= 3;
}

/**
 * True when a dotted chain (`t.anonKey`, `process.env.GITHUB_TOKEN`, `env?.KEY`) or a bare
 * identifier is made of source-looking identifiers. One-letter segments (`t`, `e`) are local
 * variables and skipped. A bare identifier (no `.`) must also be lowercase-led: a capitalized bare
 * value is far more often a token (`Zk3q…`) than a class name. A callee or receiver in a chain
 * may be capitalized (`Buffer.from`, `Deno.env`).
 */
export function looksLikeSourceName(chain: string): boolean {
  const segments = chain.split(/\??\./);
  if (segments.some((s) => !/^[A-Za-z_$][\w$]*$/.test(s))) return false;
  if (segments.length === 1 && !/^[a-z_$]/.test(chain)) return false;
  return segments.every((s) => s.length === 1 || looksLikeIdentifier(s));
}

/** The name part of an access, call or index (`config.get` in `config.get(x)`, `m` in `m[k]`):
 * like `looksLikeSourceName`, but a lone callee may be capitalized (`String(x)`). */
function isSourceCallee(name: string): boolean {
  return name.includes('.')
    ? looksLikeSourceName(name)
    : name.length === 1 || looksLikeIdentifier(name);
}

/** True when a quoted literal reads like a name (`supabase.auth.token`, `x-api-key`,
 * `localhost:8080`) rather than a credential: every alphanumeric run is a number or passes
 * `looksLikeIdentifier`. */
function looksLikeNameLiteral(literal: string): boolean {
  const runs = literal.split(/[^A-Za-z0-9]+/).filter((r) => r !== '');
  return runs.length > 0 && runs.every((r) => /^\d+$/.test(r) || looksLikeIdentifier(r));
}

/**
 * True when an unquoted value after `key:` / `key = ` is a code expression, not a literal:
 *
 * - a JS/TS word (`undefined`, `string`);
 * - a member access, index or call whose name part (before any `(` or `[`) is a chain of
 *   source-looking identifiers (`t.anonKey`, `getToken()`, `m[group]`, `z.string().min(1)`);
 * - a bare, lowercase-led, source-looking identifier immediately followed by a code terminator
 *   `,` `;` `)` `]` `}` (`token: anonKey,`, `password: dbPassword)`).
 *
 * A random token (`Zk3q9TnW2vLp8RxY,`) fails the identifier shape and stays a literal; a bare word
 * with nothing after it (one word after a YAML `password:`) stays a literal; anything quoted is a
 * literal. Two context rules live in the caller, not here: an unspaced or env-style `KEY=value`
 * admits only a complete call or index, and quoted literals inside an exempt expression are
 * checked on their own (`expressionLiterals`).
 */
export function isCodeExpression(value: string): boolean {
  // Peel terminators one at a time, so `m[group];` is tried as `m[group]` before `m[group`.
  for (let v = value; v !== ''; v = v.slice(0, -1)) {
    if (MEMBER_OR_CALL.test(v)) {
      if (CODE_WORDS.has(v)) return true;
      if (HAS_ACCESS_OR_CALL.test(v)) return isSourceCallee(v.split(/[([]/, 1)[0] ?? '');
      return v !== value && looksLikeSourceName(v);
    }
    if (!CODE_TERMINATOR.test(v)) return false;
  }
  return false;
}

/**
 * The quoted literals inside the code expression starting at `start` that are credentials, as
 * `[index, length]` of their contents. The expression ends at a newline, or at a `,` `;` or an
 * unopened closing bracket at depth 0 (so `{ token: a, other: 'x' }` stops at the comma).
 *
 * - A literal right after `||` / `??` (any depth) or a depth-0 ternary `?` / `:` is a value the
 *   key may take (`process.env.X || "…"`): flagged like a direct quoted value.
 * - Any other literal (a call argument, an index, a concatenation) is flagged unless it reads like
 *   a name: `decrypt("Zk3q…")` is flagged; `env.get('SUPABASE_URL')`, `getItem('auth-token')`
 *   and `min(1, 'Password is required')` are not.
 *
 * Either way the literal must be a plausible value: 8+ characters with no whitespace, not a
 * placeholder or reference, not an env-var name.
 */
function expressionLiterals(text: string, start: number): [number, number][] {
  const out: [number, number][] = [];
  const stop = Math.min(text.length, start + 400);
  let depth = 0;
  for (let i = start; i < stop; i += 1) {
    const c = text[i] ?? '';
    if (c === '\n') break;
    if (c === '"' || c === "'" || c === '`') {
      const close = text.indexOf(c, i + 1);
      const nl = text.indexOf('\n', i + 1);
      if (close < 0 || (nl >= 0 && nl < close)) break;
      const literal = text.slice(i + 1, close);
      const before = text.slice(start, i).trimEnd();
      const fallback =
        /(?:\|\||\?\?)$/.test(before) || (depth === 0 && /(?:^|[^?.])[?:]$/.test(before));
      if (
        /^[^\s"'`]{8,}$/.test(literal) &&
        !NOT_A_VALUE.test(literal) &&
        !ENV_VAR_NAME.test(literal) &&
        (fallback || !looksLikeNameLiteral(literal))
      ) {
        out.push([i + 1, literal.length]);
      }
      i = close;
    } else if ('([{'.includes(c)) {
      depth += 1;
    } else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (c === ',' || c === ';')) {
      break;
    }
  }
  return out;
}

/** Peels trailing punctuation a value does not own (`(token=abc…)`, `secret=abc…;` in a log line)
 * so the finding spans only the secret: `,` `;` and a closer whose opener is not in the value. */
function trimValue(value: string): string {
  let v = value;
  for (;;) {
    const last = v.at(-1) ?? '';
    const opener = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last];
    const peel = last === ',' || last === ';' || (opener !== undefined && !v.includes(opener));
    if (!peel || v.length <= MIN_VALUE_LENGTH) return v;
    v = v.slice(0, -1);
  }
}

/**
 * True when a key-context match is `key=value` text rather than source: an unspaced `=`
 * (`token=…` in a log line or a query string), or a line that starts with an ALL_CAPS env name and
 * `=` (`PGPASSWORD = …`, `export DB_PASSWORD=…`). There a dotted value is a value
 * (`correct.horse.battery.staple`), not a member chain.
 */
function isKeyValueText(text: string, m: RegExpMatchArray, sep: string): boolean {
  if (!sep.includes('=')) return false;
  if (sep === '=') return true;
  const at = m.index ?? 0;
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const [, , quote = '', value = ''] = m;
  const keyAndSep =
    text.slice(lineStart, at) + m[0].slice(0, m[0].length - quote.length - value.length);
  return /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*$/.test(keyAndSep);
}

/** A `Basic` credential is base64 of printable `user:password`; anything else is prose. */
function isBasicCredential(b64: string): boolean {
  const decoded = Buffer.from(b64, 'base64').toString('latin1');
  return decoded.includes(':') && /^[\x20-\x7e]+$/.test(decoded);
}

/** The key names whose value is a secret: `secret`, `token`, `password`/`passwd`, `api key`. No
 * left boundary, so `GITHUB_TOKEN`, `DB_PASSWORD`, `PGPASSWORD`, `client_secret` and
 * `MY_API_KEY` all match (11 §6's regex has none either); a trailing `_KEY` (`SECRET_KEY`) is part
 * of the name. */
const SECRET_KEY_NAME = '(?:secret|token|passw(?:or)?d|api[_-]?key)(?:[_-]?key)?';
/** Separator, opening quote and value of a key-context shape (groups 1–3). */
const CONTEXT_VALUE = '(\\s*(?:=(?!=)|:)\\s*)(["\'`]?)([^\\s"\'`]{8,})';

// Shapes from 11 §6, as tested regexes. Each must be confirmed against the provider's documented
// format before raw capture relies on it (M3).
const SHAPES: readonly Shape[] = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
  },
  { kind: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'github', re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { kind: 'xai', re: /\bxai-[A-Za-z0-9]{20,}/g },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'neon', re: /\bnapi_[A-Za-z0-9]{40,}/g },
  { kind: 'supabase', re: /\bsbp_[A-Za-z0-9]{40}/g },
  { kind: 'jwt', re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { kind: 'hcp', re: /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9]{60,}/g },
  { kind: 'postgres-password', re: /\bpostgres(?:ql)?:\/\/[^:/@\s]*:([^@\s/]+)@/g, group: 1 },
  {
    // Any other URL with userinfo: mysql, redis (also with an empty user), mongodb+srv, amqp, https
    kind: 'url-password',
    re: /\b(?!postgres(?:ql)?:)[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:([^@\s/]+)@/gi,
    group: 1,
  },
  { kind: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  {
    kind: 'basic-auth',
    re: /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g,
    group: 1,
    accept: (_m, secret) => isBasicCredential(secret),
  },
  {
    kind: 'cloudflare',
    re: new RegExp(`\\b(?:CF|CLOUDFLARE)_[A-Z0-9_]*(?:KEY|TOKEN)${CONTEXT_VALUE}`, 'g'),
    group: 3,
    context: true,
  },
  {
    kind: 'vercel',
    re: new RegExp(`\\bVERCEL_[A-Z0-9_]*TOKEN${CONTEXT_VALUE}`, 'g'),
    group: 3,
    context: true,
  },
  {
    kind: 'generic',
    re: new RegExp(`${SECRET_KEY_NAME}["'\`]?${CONTEXT_VALUE}`, 'gi'),
    group: 3,
    context: true,
  },
];

/** The literal forms a known value can take in a log: as-is, URL-encoded, base64. */
function valueForms(value: string): string[] {
  const forms = [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
  return [...new Set(forms)];
}

/**
 * A key-context match: the value's own span when it is a literal, else the credential literals
 * inside the code expression (often none). A quoted value is a literal. An unquoted one is code
 * only when `isCodeExpression` says so and, in `key=value` text, only as a complete call or index.
 */
function contextFindings(text: string, kind: string, m: RegExpMatchArray): SecretFinding[] {
  const [, sep = '', quote = ''] = m;
  let value = m[3] ?? '';
  const valueAt = (m.index ?? 0) + m[0].length - value.length;
  if (quote === '') {
    const keyValue = isKeyValueText(text, m, sep);
    // In `key=value` text the value ends where the next query parameter starts (`&page=2`).
    if (keyValue) value = value.replace(/&[\w.-]+=.*$/, '');
    const code = keyValue
      ? COMPLETE_CALL_OR_INDEX.test(value) && isCodeExpression(value)
      : isCodeExpression(value);
    if (code) {
      return expressionLiterals(text, valueAt).map(([index, length]) => ({ kind, index, length }));
    }
  }
  const secret = quote === '' ? trimValue(value) : value;
  return [{ kind, index: valueAt, length: secret.length }];
}

function shapeFindings(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, re, group = 0, accept, context } of SHAPES) {
    for (const m of text.matchAll(re)) {
      const secret = m[group];
      if (secret === undefined || NOT_A_VALUE.test(secret)) continue;
      if (context) {
        if (!ENV_VAR_NAME.test(secret)) out.push(...contextFindings(text, kind, m));
        continue;
      }
      if (accept && !accept(m, secret)) continue;
      // The secret part sits after the prefix; search from its end so a value that also occurs
      // inside the prefix text cannot be mislocated.
      const offset = group === 0 ? 0 : m[0].lastIndexOf(secret);
      out.push({ kind, index: (m.index ?? 0) + offset, length: secret.length });
    }
  }
  return out;
}

function valueFindings(text: string, values: readonly string[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const v of values) {
    if (v.length < MIN_VALUE_LENGTH) continue;
    for (const form of valueForms(v)) {
      for (let i = text.indexOf(form); i >= 0; i = text.indexOf(form, i + form.length)) {
        out.push({ kind: 'value', index: i, length: form.length });
      }
    }
  }
  return out;
}

/** Keeps the earliest, then longest, of any overlapping findings, so each span is reported once. */
function disjoint(findings: SecretFinding[]): SecretFinding[] {
  const sorted = findings.sort((a, b) => a.index - b.index || b.length - a.length);
  const out: SecretFinding[] = [];
  let end = -1;
  for (const f of sorted) {
    if (f.index < end) continue;
    out.push(f);
    end = f.index + f.length;
  }
  return out;
}

/** Every secret in `text`, by shape and by the literal `values` given, in text order. */
export function findSecrets(text: string, values: readonly string[] = []): SecretFinding[] {
  return disjoint([...valueFindings(text, values), ...shapeFindings(text)]);
}

/** Replaces each secret with `gl-redacted-<kind>`. */
export function redact(text: string, values: readonly string[] = []): string {
  let out = '';
  let at = 0;
  for (const f of findSecrets(text, values)) {
    out += `${text.slice(at, f.index)}gl-redacted-${f.kind}`;
    at = f.index + f.length;
  }
  return out + text.slice(at);
}
