import { type ApiSpec, type VerifyCheck, type VerifyReport, msg, report } from './types';

const trimSlash = (s: string) => s.replace(/\/+$/, '');

async function checkRoute(
  base: string,
  c: NonNullable<ApiSpec['checks']>[number],
): Promise<VerifyCheck> {
  const name = `GET ${c.path}`;
  try {
    const res = await fetch(base + c.path, { redirect: 'manual', headers: c.requestHeaders });
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
): Promise<VerifyCheck> {
  for (const path of candidates) {
    try {
      const res = await fetch(base + path, { redirect: 'manual' });
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

async function checkInternalLinks(base: string, max = 25): Promise<VerifyCheck> {
  try {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    const html = await res.text();
    const hrefs = new Set<string>();
    for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1];
      if (href && !href.startsWith('//')) hrefs.add(href);
      if (hrefs.size >= max) break;
    }
    const broken: string[] = [];
    for (const href of hrefs) {
      try {
        const r = await fetch(base + href, { redirect: 'manual' });
        if (r.status >= 400) broken.push(`${href} (${r.status})`);
      } catch {
        broken.push(`${href} (unreachable)`);
      }
    }
    return {
      name: `no broken internal links (${hrefs.size} checked)`,
      pass: broken.length === 0,
      detail: broken.length ? `broken: ${broken.join(', ')}` : undefined,
    };
  } catch (e) {
    return { name: 'no broken internal links', pass: false, detail: msg(e) };
  }
}

async function runChecks(base: string, spec: ApiSpec): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];

  for (const c of spec.checks ?? []) checks.push(await checkRoute(base, c));
  if (spec.rssValid) {
    checks.push(
      await checkXml(base, ['/rss.xml', '/feed.xml', '/index.xml'], 'rss', /<(rss|feed)[\s>]/i),
    );
  }
  if (spec.sitemapValid) {
    checks.push(
      await checkXml(
        base,
        ['/sitemap.xml', '/sitemap-index.xml'],
        'sitemap',
        /<(urlset|sitemapindex)[\s>]/i,
      ),
    );
  }
  if (spec.noBrokenInternalLinks) checks.push(await checkInternalLinks(base));

  return checks;
}

export async function verifyApi(baseUrl: string, spec: ApiSpec): Promise<VerifyReport> {
  const base = trimSlash(baseUrl);
  const retries = Math.max(0, spec.settleRetries ?? 0);
  const delayMs = spec.settleMs ?? 5000;

  // Eventual-consistency settle: re-run the whole set while anything fails, up to `retries` extra
  // times. A just-deployed static host can serve some paths before others; this absorbs that lag
  // without masking a real failure (which still fails, after the retries).
  let checks = await runChecks(base, spec);
  for (let i = 0; i < retries && !checks.every((c) => c.pass); i++) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    checks = await runChecks(base, spec);
  }

  return report('api', baseUrl, checks);
}
