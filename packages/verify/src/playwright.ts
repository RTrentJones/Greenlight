import { spawnSync } from 'node:child_process';
import { type PlaywrightSpec, type VerifyCheck, type VerifyReport, msg, report } from './types';

/**
 * playwright mode (greenlight-v1.md §9/§11). Two complementary checks, either or both:
 *
 *  - `renders`: a light render smoke via the accessibility tree. Playwright is an optional
 *    dependency, dynamically imported, so api/mcp users don't pull a browser; if it (or a
 *    browser) is unavailable the report says so rather than throwing.
 *  - `suite`: run a real `playwright test` suite against the EXACT deployed URL, gating on the
 *    suite's exit code. The deploy URL is injected as `PLAYWRIGHT_BASE_URL` (Playwright's de-facto
 *    baseURL var) and `GREENLIGHT_VERIFY_URL`, so the same suite runs unchanged in PR CI (local
 *    stack) and as the deploy gate — the path to gating on full authenticated journeys.
 *
 * `toolDir` is the dir the CLI resolves; it's the default cwd for the suite command.
 */
export async function verifyPlaywright(
  baseUrl: string,
  spec: PlaywrightSpec,
  toolDir: string = process.cwd(),
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];

  if (spec.suite) checks.push(runSuite(baseUrl, spec.suite, toolDir));
  if (spec.renders?.length) checks.push(...(await runRenders(baseUrl, spec.renders)));

  if (checks.length === 0) {
    checks.push({
      name: 'playwright spec',
      pass: false,
      detail: 'nothing to run — set `renders` and/or `suite`',
    });
  }

  return report('playwright', baseUrl, checks);
}

/** Pull a one-line summary out of Playwright/vitest/jest output. */
function summarize(output: string): string | undefined {
  const lines = output.split('\n');
  const hit = lines.find((l) =>
    /\d+\s+(passed|failed|flaky|skipped)|Tests?\s+\d+\s+(passed|failed)|Tests:/.test(l),
  );
  if (hit) return hit.trim();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l?.trim()) return l.trim();
  }
  return undefined;
}

/** Run a real Playwright suite against the deployed URL, gating on exit code. */
function runSuite(
  baseUrl: string,
  suite: NonNullable<PlaywrightSpec['suite']>,
  toolDir: string,
): VerifyCheck {
  const command = suite.command ?? 'pnpm exec playwright test';
  const cwd = suite.cwd ?? toolDir;
  try {
    const res = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: suite.timeoutMs ?? 600_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // The deployed URL the suite must target. PLAYWRIGHT_BASE_URL is what a stock
        // playwright.config reads for `use.baseURL`; GREENLIGHT_VERIFY_URL mirrors the rest of the
        // harness so one convention works everywhere.
        PLAYWRIGHT_BASE_URL: baseUrl,
        GREENLIGHT_VERIFY_URL: baseUrl,
        ...suite.env,
      },
    });
    if (res.error) {
      return { name: command, pass: false, detail: msg(res.error) };
    }
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const summary = summarize(out);
    const pass = res.status === 0;
    return {
      name: `suite: ${command}`,
      pass,
      detail: pass ? summary : `exit ${res.status ?? 'signal'}${summary ? ` — ${summary}` : ''}`,
    };
  } catch (e) {
    return { name: command, pass: false, detail: msg(e) };
  }
}

/** Light render smoke via the accessibility tree (no auth, no suite). */
async function runRenders(baseUrl: string, renders: string[]): Promise<VerifyCheck[]> {
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return [
      {
        name: 'playwright available',
        pass: false,
        detail:
          'playwright not installed — run `pnpm add playwright && pnpm exec playwright install chromium`',
      },
    ];
  }

  const base = baseUrl.replace(/\/+$/, '');
  const checks: VerifyCheck[] = [];

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (e) {
    return [
      {
        name: 'launch browser',
        pass: false,
        detail: `${msg(e)} (try \`playwright install chromium\`)`,
      },
    ];
  }

  try {
    for (const path of renders) {
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

  return checks;
}
