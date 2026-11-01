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
 * Context shapes (`password=…`, `Authorization: Basic …`) flag values that look like literals and
 * skip values that are code expressions (`apikey: t.anonKey,`, `token: getToken()`), so a vendored
 * source file that merely passes a credential along is not reported as leaking one.
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
}

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
const HAS_ACCESS_OR_CALL = /\?\.|\.|\(|\[[^\]]+\]/;
/** What may close an expression: `,` `;` `)` `}` and `]`, or an array type suffix (`string[]`). */
const CODE_TERMINATOR = /[,;)[\]}]$/;

/**
 * True when an unquoted value is a code expression, not a literal: a member access, index or
 * function call (`t.anonKey`, `getToken()`), or a bare identifier immediately followed by a code
 * terminator (`token: anonKey,`). A bare identifier with nothing after it (an env file's
 * `DB_PASSWORD=` followed by one word) stays a literal, and so does anything quoted.
 */
export function isCodeExpression(value: string): boolean {
  // Peel terminators one at a time, so `m[group];` is tried as `m[group]` before `m[group`.
  for (let v = value; v !== ''; v = v.slice(0, -1)) {
    if (MEMBER_OR_CALL.test(v)) {
      return CODE_WORDS.has(v) || HAS_ACCESS_OR_CALL.test(v) || v !== value;
    }
    if (!CODE_TERMINATOR.test(v)) return false;
  }
  return false;
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
    re: /\b(?:CF|CLOUDFLARE)_[A-Z0-9_]*(?:KEY|TOKEN)\s*[=:]\s*(["'`]?)([^\s"'`]{8,})/g,
    group: 2,
    accept: (m, secret) => m[1] !== '' || !isCodeExpression(secret),
  },
  {
    kind: 'vercel',
    re: /\bVERCEL_[A-Z0-9_]*TOKEN\s*[=:]\s*(["'`]?)([^\s"'`]{8,})/g,
    group: 2,
    accept: (m, secret) => m[1] !== '' || !isCodeExpression(secret),
  },
  {
    kind: 'generic',
    re: new RegExp(`${SECRET_KEY_NAME}["'\`]?\\s*(?:=(?!=)|:)\\s*(["'\`]?)([^\\s"'\`]{8,})`, 'gi'),
    group: 2,
    accept: (m, secret) => m[1] !== '' || !isCodeExpression(secret),
  },
];

/** Shapes that find a value by its key-name context rather than its own format. */
const CONTEXT_KINDS = new Set(['cloudflare', 'vercel', 'generic']);

/** Values shorter than this are too likely to occur by chance to match literally (11 §6). */
export const MIN_VALUE_LENGTH = 8;

/** The literal forms a known value can take in a log: as-is, URL-encoded, base64. */
function valueForms(value: string): string[] {
  const forms = [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
  return [...new Set(forms)];
}

function shapeFindings(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, re, group = 0, accept } of SHAPES) {
    for (const m of text.matchAll(re)) {
      const secret = m[group];
      if (secret === undefined || NOT_A_VALUE.test(secret)) continue;
      if (CONTEXT_KINDS.has(kind) && ENV_VAR_NAME.test(secret)) continue;
      if (accept && !accept(m, secret)) continue;
      // The secret part sits after the key name; search from the end of the prefix so a value
      // that also occurs inside the key text cannot be mislocated.
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
