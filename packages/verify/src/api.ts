import { type ApiSpec, type VerifyCheck, type VerifyReport, msg, report } from './types';

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LINKS = 50;
/** Concurrent fetches for the internal-link crawl. Serial was the gate's slowest path: 50 links
 * × a 10s timeout each is minutes of wall time per settle attempt when an origin is degraded. */
const LINK_POOL_SIZE = 6;

/** Run tasks with at most `limit` in flight; results keep task order. Exported for unit tests. */
export async function pool<T>(
  tasks: Array<() => Promise<T>>,
  limit = LINK_POOL_SIZE,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await (tasks[i] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
/** Cap on how much of a response body we buffer. The `contains`/feed/link checks only need a prefix;
 * without a cap a huge or cached error body would be read fully into memory. */
const MAX_BODY_CHARS = 2_000_000;

/** A single fetch, bounded by `timeoutMs` so a hung endpoint fails the check instead of blocking the
 * whole gate forever (the settle loop and CI both depend on this returning). */
function timedFetch(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  return fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Read a response body as text but stop after `max` chars, cancelling the stream — so a giant body
 * can't be fully buffered. Falls back to `res.text()` (then slices) when the body isn't streamable. */
async function boundedText(res: Response, max = MAX_BODY_CHARS): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, max);
}

async function checkRoute(
  base: string,
  c: NonNullable<ApiSpec['checks']>[number],
  timeoutMs: number,
): Promise<VerifyCheck> {
  const name = `GET ${c.path}`;
  try {
    const res = await timedFetch(base + c.path, timeoutMs, { headers: c.requestHeaders });
    const reasons: string[] = [];
    if (c.status !== undefined && res.status !== c.status) {
      reasons.push(`status ${res.status} != ${c.status}`);
    }
    if (c.contains !== undefined) {
      const body = await boundedText(res);
      if (!body.includes(c.contains)) reasons.push(`body missing "${c.contains}"`);
    }
    if (c.header) {
      const v = res.headers.get(c.header.name);
      if (v === null) reasons.push(`header ${c.header.name} absent`);
      else if (c.header.value !== undefined && v !== c.header.value) {
        reasons.push(`header ${c.header.name}="${v}" != "${c.header.value}"`);
      }
    }
    return { name, pass: reasons.length === 0, detail: reasons.join('; ') || undefined };
  } catch (e) {
    return { name, pass: false, detail: msg(e) };
  }
}

async function checkXml(
  base: string,
  candidates: string[],
  label: string,
  marker: RegExp,
  timeoutMs: number,
): Promise<VerifyCheck> {
  for (const path of candidates) {
    try {
      const res = await timedFetch(base + path, timeoutMs);
      if (res.status === 200) {
        const body = await boundedText(res);
        const ok = marker.test(body);
        return {
          name: `${label} (${path})`,
          pass: ok,
          detail: ok ? undefined : `200 but content did not look like ${label}`,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return { name: label, pass: false, detail: `none of ${candidates.join(', ')} returned 200` };
}

async function checkInternalLinks(
  base: string,
  timeoutMs: number,
  max = DEFAULT_MAX_LINKS,
): Promise<VerifyCheck> {
  try {
    const res = await timedFetch(`${base}/`, timeoutMs);
    const html = await boundedText(res);
    const hrefs = new Set<string>();
    let capped = false;
    for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1];
      if (href && !href.startsWith('//')) hrefs.add(href);
      if (hrefs.size >= max) {
        capped = true;
        break;
      }
    }
    // A 200 that yields no internal links means we verified NOTHING (empty/unparseable page, or a
    // cached error body). Fail rather than vacuously pass — "0 checked" must not read as green.
    if (hrefs.size === 0) {
      return {
        name: 'no broken internal links',
        pass: false,
        detail: `no internal links found on ${base}/ (status ${res.status}) — page empty or unparseable`,
      };
    }
    const results = await pool(
      [...hrefs].map((href) => async () => {
        try {
          const r = await timedFetch(base + href, timeoutMs);
          return r.status >= 400 ? `${href} (${r.status})` : null;
        } catch {
          return `${href} (unreachable)`;
        }
      }),
    );
    const broken = results.filter((r): r is string => r !== null);
    const capNote = capped ? `; capped at first ${max} — raise maxLinks to check more` : '';
    return {
      name: `no broken internal links (${hrefs.size} checked${capped ? `, capped at ${max}` : ''})`,
      pass: broken.length === 0,
      detail: broken.length ? `broken: ${broken.join(', ')}${capNote}` : capNote || undefined,
    };
  } catch (e) {
    return { name: 'no broken internal links', pass: false, detail: msg(e) };
  }
}

/** Build the check set as independent tasks (closures) so the settle loop can re-run ONLY the ones
 * that failed, instead of hammering already-passing endpoints. */
function buildTasks(base: string, spec: ApiSpec): Array<() => Promise<VerifyCheck>> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tasks: Array<() => Promise<VerifyCheck>> = [];
  for (const c of spec.checks ?? []) tasks.push(() => checkRoute(base, c, timeoutMs));
  if (spec.rssValid) {
    tasks.push(() =>
      checkXml(
        base,
        ['/rss.xml', '/feed.xml', '/index.xml'],
        'rss',
        /<(rss|feed)[\s>]/i,
        timeoutMs,
      ),
    );
  }
  if (spec.sitemapValid) {
    tasks.push(() =>
      checkXml(
        base,
        ['/sitemap.xml', '/sitemap-index.xml'],
        'sitemap',
        /<(urlset|sitemapindex)[\s>]/i,
        timeoutMs,
      ),
    );
  }
  if (spec.noBrokenInternalLinks) {
    tasks.push(() => checkInternalLinks(base, timeoutMs, spec.maxLinks));
  }
  return tasks;
}

/** Run a task and stamp the check with its wall time + how many attempts it has had so far —
 * the raw per-check signal for gate-latency trends and the flake burndown (a fail-then-pass at
 * attempts>1 is eventual consistency, measured instead of guessed). */
async function timedAttempt(
  task: () => Promise<VerifyCheck>,
  attempt: number,
): Promise<VerifyCheck> {
  const start = Date.now();
  const check = await task();
  check.durationMs = Date.now() - start;
  check.attempts = attempt;
  return check;
}

/** E3 artifact identity: probe `<base>/__version` for `{ sha }` and compare to the sha this
 * verify is gating. Graceful adoption path — a tool that doesn't expose the endpoint (404 /
 * non-JSON) or was built without a sha (`sha: null`) gets a PASSING "sha unverified" check, so
 * enforcement turns on per-tool by exposing the route. A present-but-DIFFERENT sha fails hard:
 * the URL is serving a different artifact than the one being gated. Prefix comparison so a
 * short sha on either side still matches. */
async function checkDeployedSha(
  base: string,
  expectedSha: string,
  timeoutMs: number,
): Promise<VerifyCheck> {
  const name = 'deployed sha matches expected';
  const unverified = (why: string): VerifyCheck => ({
    name,
    pass: true,
    detail: `${why} — sha unverified (serve { sha } at /__version to enforce artifact identity)`,
  });
  try {
    const res = await timedFetch(`${base}/__version`, timeoutMs);
    if (res.status !== 200) return unverified(`/__version → ${res.status}`);
    const body = await boundedText(res, 10_000);
    let sha: unknown;
    try {
      sha = (JSON.parse(body) as { sha?: unknown }).sha;
    } catch {
      return unverified('/__version is not JSON');
    }
    if (sha == null || sha === '') return unverified('/__version has no sha (built without one)');
    if (typeof sha !== 'string') {
      return { name, pass: false, detail: `/__version sha is not a string: ${String(sha)}` };
    }
    const match = sha.startsWith(expectedSha) || expectedSha.startsWith(sha);
    return {
      name,
      pass: match,
      detail: match
        ? `sha ${sha.slice(0, 12)}`
        : `deployed ${sha.slice(0, 12)} != expected ${expectedSha.slice(0, 12)} — this URL is serving a DIFFERENT artifact than the one being gated`,
    };
  } catch (e) {
    return { name, pass: false, detail: msg(e) };
  }
}

export async function verifyApi(
  baseUrl: string,
  spec: ApiSpec,
  expectedSha?: string,
): Promise<VerifyReport> {
  const base = trimSlash(baseUrl);
  let retries = Math.max(0, spec.settleRetries ?? 0);
  const delayMs = spec.settleMs ?? 5000;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Identity gate FIRST, inside the settle budget: content checks against a not-yet-propagated
  // (or wrong) deployment are worse than wasted — a green there is a false green for the sha
  // being gated. Consumes settle retries while waiting for the right artifact to appear; if it
  // never does, the content checks are SKIPPED (they would validate the wrong deployment).
  const identityChecks: VerifyCheck[] = [];
  if (expectedSha) {
    const task = () => checkDeployedSha(base, expectedSha, timeoutMs);
    let check = await timedAttempt(task, 1);
    while (!check.pass && retries > 0) {
      retries -= 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      check = await timedAttempt(task, (check.attempts ?? 1) + 1);
    }
    identityChecks.push(check);
    if (!check.pass) return report('api', baseUrl, identityChecks);
  }

  // Pair each task with its latest result so the settle loop can re-run ONLY the still-failing ones.
  const state = await Promise.all(
    buildTasks(base, spec).map(async (task) => ({ task, check: await timedAttempt(task, 1) })),
  );

  // Eventual-consistency settle: re-run ONLY the still-failing checks, up to `retries` more times.
  // A just-deployed static host can serve some paths before others; this absorbs that lag without
  // re-hitting passing endpoints and without masking a real failure (which still fails, after the
  // retries). Each fetch is timeout-bounded, so the total settle window is finite.
  for (let i = 0; i < retries && !state.every((s) => s.check.pass); i++) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await Promise.all(
      state
        .filter((s) => !s.check.pass)
        .map(async (s) => {
          s.check = await timedAttempt(s.task, (s.check.attempts ?? 1) + 1);
        }),
    );
  }

  return report('api', baseUrl, [...identityChecks, ...state.map((s) => s.check)]);
}
