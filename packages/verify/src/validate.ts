/**
 * Strict spec validation. A verify spec is plain data (often an untyped `verify.config.ts`), and a
 * harness that silently ignores a field it doesn't know turns a typo — or a field from a NEWER
 * Greenlight than the one installed — into an assertion that never runs while the gate reads
 * green. So every unknown key, wrong-typed key or uncompilable regex is a hard, named failure.
 */

const BASE = ['mode', 'logsOnFailure', 'concurrency'];
const VALUE = ['equals', 'exists', 'matches', 'gte', 'lte', 'maxAgeHours', 'minFutureDays'];

const MODE_KEYS: Record<string, string[]> = {
  api: [
    'checks',
    'rssValid',
    'sitemapValid',
    'noBrokenInternalLinks',
    'maxLinks',
    'timeoutMs',
    'settleRetries',
    'settleMs',
    'requireIdentity',
  ],
  mcp: ['expectTools', 'exactTools', 'call', 'requireAuthRejection', 'headers', 'timeoutMs'],
  playwright: ['renders', 'suite'],
  test: ['command', 'cwd', 'timeoutMs'],
  'agent-web': [
    'scenarios',
    'model',
    'maxSteps',
    'historyWindow',
    'maxTokens',
    'maxRepeats',
    'headed',
  ],
  eval: ['cases', 'model'],
};

const API_CHECK = [
  'path',
  'method',
  'body',
  'status',
  'contains',
  'notContains',
  'header',
  'json',
  'text',
  'maxMs',
  'requestHeaders',
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKeys(where: string, obj: unknown, allowed: string[], out: string[]): void {
  if (!isObj(obj)) {
    out.push(`${where} must be an object`);
    return;
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) out.push(`${where}: unsupported field "${k}"`);
  }
}

function regexOk(where: string, src: unknown, flags: unknown, out: string[]): void {
  if (src === undefined) return;
  if (typeof src !== 'string') {
    out.push(`${where} must be a string`);
    return;
  }
  try {
    new RegExp(src, typeof flags === 'string' ? flags : undefined);
  } catch (e) {
    out.push(`${where} is not a valid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eachOf(
  where: string,
  list: unknown,
  fn: (item: unknown, at: string) => void,
  out: string[],
) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    out.push(`${where} must be an array`);
    return;
  }
  list.forEach((item, i) => fn(item, `${where}[${i}]`));
}

/** Returns every problem found in `spec` (empty = valid). */
export function validateSpec(spec: unknown): string[] {
  const out: string[] = [];
  if (!isObj(spec)) return ['spec must be an object'];
  const mode = spec.mode;
  if (typeof mode !== 'string' || !(mode in MODE_KEYS)) {
    return [
      `unknown mode ${JSON.stringify(mode)} (expected one of ${Object.keys(MODE_KEYS).join(', ')})`,
    ];
  }
  unknownKeys(`${mode} spec`, spec, [...BASE, ...(MODE_KEYS[mode] as string[])], out);

  if (mode === 'api') {
    eachOf(
      'checks',
      spec.checks,
      (c, at) => {
        unknownKeys(at, c, API_CHECK, out);
        if (!isObj(c)) return;
        if (typeof c.path !== 'string') out.push(`${at}.path must be a string`);
        if (c.header !== undefined) unknownKeys(`${at}.header`, c.header, ['name', 'value'], out);
        eachOf(
          `${at}.json`,
          c.json,
          (j, jat) => {
            unknownKeys(jat, j, ['path', ...VALUE], out);
            if (isObj(j)) {
              if (typeof j.path !== 'string') out.push(`${jat}.path must be a string`);
              regexOk(`${jat}.matches`, j.matches, undefined, out);
            }
          },
          out,
        );
        eachOf(
          `${at}.text`,
          c.text,
          (t, tat) => {
            unknownKeys(tat, t, ['regex', 'flags', ...VALUE], out);
            if (isObj(t)) {
              if (typeof t.regex !== 'string') out.push(`${tat}.regex must be a string`);
              regexOk(`${tat}.regex`, t.regex, t.flags, out);
              regexOk(`${tat}.matches`, t.matches, undefined, out);
            }
          },
          out,
        );
      },
      out,
    );
  } else if (mode === 'mcp') {
    if (spec.call !== undefined) {
      unknownKeys('call', spec.call, ['name', 'args', 'expectKeys', 'expectText'], out);
    }
  } else if (mode === 'playwright') {
    if (spec.suite !== undefined) {
      unknownKeys('suite', spec.suite, ['command', 'cwd', 'timeoutMs', 'env'], out);
    }
  } else if (mode === 'agent-web') {
    eachOf(
      'scenarios',
      spec.scenarios,
      (s, at) => {
        unknownKeys(at, s, ['name', 'task', 'start', 'asserts'], out);
        if (isObj(s)) {
          eachOf(
            `${at}.asserts`,
            s.asserts,
            (a, aat) => unknownKeys(aat, a, ['urlContains', 'textContains', 'selector'], out),
            out,
          );
        }
      },
      out,
    );
  } else if (mode === 'eval') {
    eachOf(
      'cases',
      spec.cases,
      (c, at) => unknownKeys(at, c, ['name', 'tool', 'args', 'rubric', 'minScore'], out),
      out,
    );
  }
  return out;
}
