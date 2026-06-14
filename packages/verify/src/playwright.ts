import { type PlaywrightSpec, type VerifyCheck, type VerifyReport, msg, report } from './types';

/**
 * Light render check via the accessibility tree (greenlight-v1.md §9/§11).
 * Playwright is an optional dependency, dynamically imported, so api/mcp users
 * don't pull a browser. If it (or a browser) is unavailable, the report says so
 * rather than throwing.
 */
export async function verifyPlaywright(
  baseUrl: string,
  spec: PlaywrightSpec,
): Promise<VerifyReport> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return report('playwright', baseUrl, [
      {
        name: 'playwright available',
        pass: false,
        detail:
          'playwright not installed — run `pnpm add playwright && pnpm exec playwright install chromium`',
      },
    ]);
  }

  const base = baseUrl.replace(/\/+$/, '');
  const checks: VerifyCheck[] = [];

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (e) {
    return report('playwright', baseUrl, [
      {
        name: 'launch browser',
        pass: false,
        detail: `${msg(e)} (try \`playwright install chromium\`)`,
      },
    ]);
  }

  try {
    for (const path of spec.renders) {
      const page = await browser.newPage();
      try {
        const res = await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        const ok = res?.ok() ?? false;
        const aria = await page.locator('body').ariaSnapshot();
        const nonEmpty = aria.trim().length > 0;
        checks.push({
          name: `renders ${path}`,
          pass: ok && nonEmpty,
          detail: !ok
            ? `status ${res?.status() ?? 'none'}`
            : nonEmpty
              ? undefined
              : 'empty accessibility tree',
        });
      } catch (e) {
        checks.push({ name: `renders ${path}`, pass: false, detail: msg(e) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return report('playwright', baseUrl, checks);
}
