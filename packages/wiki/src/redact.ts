/**
 * The secret detector (vision 11 §6), shared by LR-20 and, later, raw capture and bundle export.
 * It finds secrets two ways: by **shape** (always on — token formats with a recognizable prefix or
 * context) and by **value** (literal values the caller holds, with their URL-encoded and base64
 * forms, for secrets that have no shape). Findings never carry the secret text itself beyond its
 * offsets, so a report about a leak cannot become one.
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
}

/** Placeholders and references (`$VAR`, `${{ secrets.X }}`, `<token>`) are names, not values. */
const NOT_A_VALUE = /^(\$|<|gl-redacted-)/;

// Illustrative shapes from 11 §6, as tested regexes. Each must be confirmed against the provider's
// documented format before raw capture relies on it (M3).
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
  { kind: 'postgres-password', re: /\bpostgres(?:ql)?:\/\/[^:/@\s]+:([^@\s]+)@/g, group: 1 },
  { kind: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  {
    kind: 'cloudflare',
    re: /\b(?:CF|CLOUDFLARE)_[A-Z0-9_]*(?:KEY|TOKEN)\s*[=:]\s*["']?([^\s"']{8,})/g,
    group: 1,
  },
  { kind: 'vercel', re: /\bVERCEL_[A-Z0-9_]*TOKEN\s*[=:]\s*["']?([^\s"']{8,})/g, group: 1 },
  {
    kind: 'generic',
    re: /\b(?:secret|token|password|api[_-]?key)["']?\s*[:=]\s*["']?([^\s"']{8,})/gi,
    group: 1,
  },
];

/** Values shorter than this are too likely to occur by chance to match literally (11 §6). */
export const MIN_VALUE_LENGTH = 8;

/** The literal forms a known value can take in a log: as-is, URL-encoded, base64. */
function valueForms(value: string): string[] {
  const forms = [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
  return [...new Set(forms)];
}

function shapeFindings(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, re, group = 0 } of SHAPES) {
    for (const m of text.matchAll(re)) {
      const secret = m[group];
      if (secret === undefined || NOT_A_VALUE.test(secret)) continue;
      const index = (m.index ?? 0) + m[0].indexOf(secret);
      out.push({ kind, index, length: secret.length });
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
