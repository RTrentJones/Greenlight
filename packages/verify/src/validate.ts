/**
 * Strict spec validation. A verify spec is plain data (often an untyped `verify.config.ts`), and a
 * harness that silently ignores a field it doesn't know — or compares against a value of the wrong
 * type — turns a typo, a field from a NEWER Greenlight than the one installed, or `maxMs: "slow"`
 * into an assertion that never fails while the gate reads green. So every unknown key, missing
 * required key, wrong type, out-of-set enum value and uncompilable regex is a hard, named failure.
 */

import { show } from './assert';

type Kind =
  | 'string'
  | 'number'
  | 'nonneg' // a finite number >= 0 (thresholds, budgets, counts — a sign error must not invert a guard)
  | 'boolean'
  | 'scalar' // string | number | boolean | null
  | 'regex' // a string that must compile
  | 'record' // an object of string values (headers, env)
  | 'any-object' // an object of anything (tool args)
  | 'body'; // string | object | array

interface Field {
  kind?: Kind;
  /** Allowed values (implies a string). */
  oneOf?: readonly string[];
  /** A nested object with its own schema. */
  obj?: Schema;
  /** An array; `items` is the element kind, or `of` the element object schema. */
  array?: true;
  items?: Kind;
  of?: Schema;
  required?: true;
}
type Schema = Record<string, Field>;

const NUM: Field = { kind: 'number' };
const NONNEG: Field = { kind: 'nonneg' };
const BOOL: Field = { kind: 'boolean' };
const STR: Field = { kind: 'string' };

const VALUE: Schema = {
  equals: { kind: 'scalar' },
  exists: BOOL,
  matches: { kind: 'regex' },
  gte: NUM,
  lte: NUM,
  maxAgeHours: NONNEG,
  minFutureDays: NONNEG,
};

const API_CHECK: Schema = {
  path: { ...STR, required: true },
  method: { oneOf: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
  body: { kind: 'body' },
  status: NUM,
  contains: STR,
  notContains: STR,
  header: { obj: { name: { ...STR, required: true }, value: STR } },
  json: { array: true, of: { path: { ...STR, required: true }, ...VALUE } },
  // `regex` compiles with `flags`; checked specially below so the flags participate.
  text: { array: true, of: { regex: { ...STR, required: true }, flags: STR, ...VALUE } },
  maxMs: NONNEG,
  requestHeaders: { kind: 'record' },
};

const BASE: Schema = {
  mode: STR,
  logsOnFailure: STR,
  concurrency: { oneOf: ['serial', 'parallel'] },
};

const MODES: Record<string, Schema> = {
  api: {
    checks: { array: true, of: API_CHECK },
    rssValid: BOOL,
    sitemapValid: BOOL,
    noBrokenInternalLinks: BOOL,
    maxLinks: NONNEG,
    timeoutMs: NONNEG,
    settleRetries: NONNEG,
    settleMs: NONNEG,
    requireIdentity: BOOL,
  },
  mcp: {
    expectTools: { array: true, items: 'string', required: true },
    exactTools: BOOL,
    call: {
      obj: {
        name: { ...STR, required: true },
        args: { kind: 'any-object' },
        expectKeys: { array: true, items: 'string' },
        expectText: STR,
      },
    },
    requireAuthRejection: BOOL,
    headers: { kind: 'record' },
    timeoutMs: NONNEG,
  },
  playwright: {
    renders: { array: true, items: 'string' },
    suite: { obj: { command: STR, cwd: STR, timeoutMs: NONNEG, env: { kind: 'record' } } },
  },
  test: { command: STR, cwd: STR, timeoutMs: NONNEG },
  'agent-web': {
    scenarios: {
      array: true,
      required: true,
      of: {
        name: { ...STR, required: true },
        task: { ...STR, required: true },
        start: STR,
        asserts: {
          array: true,
          of: { urlContains: STR, textContains: STR, selector: STR },
        },
      },
    },
    model: STR,
    maxSteps: NONNEG,
    historyWindow: NONNEG,
    maxTokens: NONNEG,
    maxRepeats: NONNEG,
    headed: BOOL,
  },
  eval: {
    cases: {
      array: true,
      required: true,
      of: {
        name: { ...STR, required: true },
        tool: { ...STR, required: true },
        args: { kind: 'any-object' },
        rubric: { ...STR, required: true },
        minScore: NONNEG,
      },
    },
    model: STR,
  },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function kindOk(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case 'string':
    case 'regex':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'nonneg':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    case 'boolean':
      return typeof v === 'boolean';
    case 'scalar':
      return v === null || ['string', 'number', 'boolean'].includes(typeof v);
    case 'record':
      return isObj(v) && Object.values(v).every((x) => typeof x === 'string');
    case 'any-object':
      return isObj(v);
    case 'body':
      return typeof v === 'string' || (typeof v === 'object' && v !== null);
  }
}

const KIND_NAME: Record<Kind, string> = {
  string: 'a string',
  regex: 'a regex string',
  number: 'a finite number',
  nonneg: 'a finite number >= 0',
  boolean: 'a boolean',
  scalar: 'a string, number, boolean or null',
  record: 'an object of strings',
  'any-object': 'an object',
  body: 'a string, object or array',
};

function regexOk(where: string, src: unknown, flags: unknown, out: string[]): void {
  if (typeof src !== 'string') return; // the kind check already reported it
  try {
    new RegExp(src, typeof flags === 'string' ? flags : undefined);
  } catch (e) {
    out.push(`${where} is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function checkValue(where: string, v: unknown, f: Field, out: string[]): void {
  if (f.oneOf) {
    if (typeof v !== 'string' || !f.oneOf.includes(v)) {
      out.push(`${where} must be one of ${f.oneOf.join(', ')}, got ${show(v)}`);
    }
    return;
  }
  if (f.array) {
    if (!Array.isArray(v)) {
      out.push(`${where} must be an array`);
      return;
    }
    // Index loop, not forEach: forEach skips the holes of a sparse array (`[,]`), which would
    // validate and then crash the runner when it dereferences the missing element.
    for (let i = 0; i < v.length; i++) {
      const at = `${where}[${i}]`;
      if (!(i in v)) {
        out.push(`${at} is missing (sparse array)`);
        continue;
      }
      const item = v[i];
      if (f.of) checkObject(at, item, f.of, out);
      else if (f.items && !kindOk(f.items, item)) out.push(`${at} must be ${KIND_NAME[f.items]}`);
    }
    return;
  }
  if (f.obj) {
    checkObject(where, v, f.obj, out);
    return;
  }
  if (f.kind) {
    if (!kindOk(f.kind, v)) out.push(`${where} must be ${KIND_NAME[f.kind]}`);
    else if (f.kind === 'regex') regexOk(where, v, undefined, out);
  }
}

function checkObject(where: string, v: unknown, schema: Schema, out: string[]): void {
  if (!isObj(v)) {
    out.push(`${where} must be an object`);
    return;
  }
  for (const k of Object.keys(v)) {
    if (!own(schema, k)) out.push(`${where}: unsupported field "${k}"`);
  }
  for (const [k, f] of Object.entries(schema)) {
    if (!own(v, k)) {
      if (f.required) out.push(`${where}: missing required field "${k}"`);
      continue;
    }
    // Present but undefined is almost always an unset env var (`contains: process.env.MARKER`):
    // treating it as omitted would silently disable the assertion, so it is an error.
    if (v[k] === undefined) {
      out.push(
        `${where}.${k} is undefined (an unset env var?) — omit the field or give it a value`,
      );
      continue;
    }
    checkValue(`${where}.${k}`, v[k], f, out);
  }
  // A text assertion's regex compiles WITH its flags (an invalid flag is an error too).
  if (own(schema, 'regex') && own(schema, 'flags'))
    regexOk(`${where}.regex`, v.regex, v.flags, out);
  // `exists: false` asserts absence, so any value assertion beside it is a contradiction.
  if (own(schema, 'exists') && v.exists === false) {
    const others = Object.keys(VALUE).filter((k) => k !== 'exists' && own(v, k));
    if (others.length) out.push(`${where}: exists:false contradicts ${others.join(', ')}`);
  }
}

/** Returns every problem found in `spec` (empty = valid). */
export function validateSpec(spec: unknown): string[] {
  if (!isObj(spec)) return ['spec must be an object'];
  const mode = spec.mode;
  if (typeof mode !== 'string' || !own(MODES, mode)) {
    return [`unknown mode ${show(mode)} (expected one of ${Object.keys(MODES).join(', ')})`];
  }
  const out: string[] = [];
  checkObject(`${mode} spec`, spec, { ...BASE, ...(MODES[mode] as Schema) }, out);
  return out;
}
