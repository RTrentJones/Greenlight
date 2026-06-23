import { type ApiSpec, type VerifyCheck, type VerifyReport, msg, report } from './types';

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LINKS = 50;

/** A single fetch, bounded by `timeoutMs` so a hung endpoint fails the check instead of blocking the
 * whole gate forever (the settle loop and CI both depend on this returning). */
function timedFetch(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  return fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeoutMs) });
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
      const body = await res.text();
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
        const body = await res.text();
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
    const html = await res.text();
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
    const broken: string[] = [];
    for (const href of hrefs) {
      try {
        const r = await timedFetch(base + href, timeoutMs);
        if (r.status >= 400) broken.push(`${href} (${r.status})`);
      } catch {
        broken.push(`${href} (unreachable)`);
      }
    }
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

export async function verifyApi(baseUrl: string, spec: ApiSpec): Promise<VerifyReport> {
  const base = trimSlash(baseUrl);
  const retries = Math.max(0, spec.settleRetries ?? 0);
  const delayMs = spec.settleMs ?? 5000;

  // Pair each task with its latest result so the settle loop can re-run ONLY the still-failing ones.
  const state = await Promise.all(
    buildTasks(base, spec).map(async (task) => ({ task, check: await task() })),
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
          s.check = await s.task();
        }),
    );
  }

  return report(
    'api',
    baseUrl,
    state.map((s) => s.check),
  );
}
