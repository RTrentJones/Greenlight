import type { Page } from 'playwright';
import {
  type AgentWebAssert,
  type AgentWebScenario,
  type AgentWebSpec,
  type VerifyCheck,
  type VerifyReport,
  msg,
  report,
} from './types';

/** Minimal shapes for the dynamically-imported Anthropic SDK (optional dep). */
interface ContentBlock {
  type: string;
  [k: string]: unknown;
}
interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

const TOOLS = [
  {
    name: 'browser_snapshot',
    description: 'Get the current URL and the accessibility tree of the page.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element identified by its ARIA role and accessible name.',
    input_schema: {
      type: 'object' as const,
      properties: { role: { type: 'string' }, name: { type: 'string' } },
      required: ['role', 'name'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into a field by role + accessible name; submit=true presses Enter.',
    input_schema: {
      type: 'object' as const,
      properties: {
        role: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['role', 'name', 'text'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a path on the same site (e.g. "/login").',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'browser_finish',
    description: 'Finish the task. success=false if you could not complete it.',
    input_schema: {
      type: 'object' as const,
      properties: { success: { type: 'boolean' }, summary: { type: 'string' } },
      required: ['success'],
    },
  },
];

const SYSTEM =
  'You are a QA agent validating a deployed web app. Use the browser tools to accomplish the ' +
  'given task, then call browser_finish. Identify elements by the ARIA role + accessible name ' +
  'shown in the snapshot. Start by calling browser_snapshot. Be efficient — no more steps than needed.';

type Role = Parameters<Page['getByRole']>[0];

async function execTool(
  page: Page,
  base: string,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'browser_snapshot': {
        const tree = await page.locator('body').ariaSnapshot();
        return `URL: ${page.url()}\n${tree}`.slice(0, 6000);
      }
      case 'browser_click': {
        await page
          .getByRole(input.role as Role, { name: String(input.name) })
          .first()
          .click({ timeout: 5000 });
        return `clicked ${input.role} "${input.name}"`;
      }
      case 'browser_type': {
        const el = page.getByRole(input.role as Role, { name: String(input.name) }).first();
        await el.fill(String(input.text), { timeout: 5000 });
        if (input.submit) await el.press('Enter');
        return `typed into ${input.role} "${input.name}"${input.submit ? ' + submitted' : ''}`;
      }
      case 'browser_navigate': {
        await page.goto(base + String(input.path), { waitUntil: 'domcontentloaded' });
        return `navigated to ${input.path}`;
      }
      case 'browser_finish':
        return 'finished';
      default:
        return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${msg(e)}`;
  }
}

async function evalAsserts(page: Page, asserts: AgentWebAssert[]): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  let text = '';
  let textError = ''; // why the body text couldn't be read (e.g. a render timeout)
  if (asserts.some((a) => a.textContains)) {
    try {
      text = await page.locator('body').innerText({ timeout: 3000 });
    } catch (e) {
      // Surface the cause: an empty `text` here would otherwise make every `textContains` fail as
      // if the text were merely absent, hiding that the real problem was a render timeout/error.
      textError = msg(e);
    }
  }
  for (const a of asserts) {
    if (a.urlContains !== undefined) {
      const ok = page.url().includes(a.urlContains);
      checks.push({
        name: `url contains "${a.urlContains}"`,
        pass: ok,
        detail: ok ? undefined : page.url(),
      });
    }
    if (a.textContains !== undefined) {
      const ok = text.includes(a.textContains);
      checks.push({
        name: `text contains "${a.textContains}"`,
        pass: ok,
        detail: ok ? undefined : textError ? `could not read page text: ${textError}` : undefined,
      });
    }
    if (a.selector !== undefined) {
      let count = 0;
      try {
        count = await page.locator(a.selector).count();
      } catch {
        /* invalid selector → 0 */
      }
      checks.push({ name: `selector ${a.selector}`, pass: count > 0 });
    }
  }
  return checks;
}

export async function runScenario(
  client: {
    messages: {
      create(body: unknown): Promise<{
        content: ContentBlock[];
        usage?: { input_tokens?: number; output_tokens?: number };
      }>;
    };
  },
  page: Page,
  base: string,
  spec: AgentWebSpec,
  scenario: AgentWebScenario,
): Promise<{ checks: VerifyCheck[]; tokensIn: number; tokensOut: number }> {
  const tag = `[${scenario.name}]`;
  await page.goto(base + (scenario.start ?? '/'), { waitUntil: 'domcontentloaded' });

  const messages: AnthropicMessage[] = [{ role: 'user', content: `Task: ${scenario.task}` }];
  const maxSteps = spec.maxSteps ?? 12;
  const historyTurns = spec.historyWindow ?? 6;
  const maxRepeats = spec.maxRepeats ?? 3;
  let finish: { success?: boolean; summary?: string } | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let budgetExceeded = false;
  let lastFailSig = ''; // signature of the previous step's tool calls, if they all errored
  let repeats = 0; // consecutive identical all-failing steps
  let stuckOn = '';

  for (let step = 0; step < maxSteps && !finish; step++) {
    // Stop before another model call if a token budget is set and already reached.
    if (spec.maxTokens && tokensIn + tokensOut >= spec.maxTokens) {
      budgetExceeded = true;
      break;
    }
    const resp = await client.messages.create({
      model: spec.model ?? 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    tokensIn += resp.usage?.input_tokens ?? 0;
    tokensOut += resp.usage?.output_tokens ?? 0;
    const blocks = resp.content;
    messages.push({ role: 'assistant', content: blocks });
    const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) break; // model stopped without acting

    const results = [];
    for (const tu of toolUses) {
      const out = await execTool(page, base, tu.name, tu.input);
      if (tu.name === 'browser_finish') {
        finish = tu.input as { success?: boolean; summary?: string };
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: results });

    // Stuck-loop guard: if this step's tool calls are identical to the previous step's AND every
    // result was an error, the agent is retrying a dead action — abort instead of repeating it.
    const sig = toolUses.map((tu) => `${tu.name}:${JSON.stringify(tu.input)}`).join('|');
    const allErrored = results.every((r) => r.content.startsWith('error:'));
    repeats = allErrored && sig === lastFailSig ? repeats + 1 : 0;
    lastFailSig = allErrored ? sig : '';
    if (repeats + 1 >= maxRepeats) {
      stuckOn = toolUses.map((tu) => tu.name).join(', ');
      break;
    }

    // Sliding context window: keep the task (messages[0]) + the last `historyTurns` turns. Each
    // turn is an (assistant, user-tool-result) pair, so we drop whole pairs from the front to keep
    // every tool_use matched with its tool_result. Stops old page snapshots inflating input tokens.
    const keep = historyTurns * 2;
    if (messages.length > keep + 1) {
      messages.splice(1, messages.length - keep - 1);
    }
  }

  const checks: VerifyCheck[] = [];
  if (budgetExceeded) {
    checks.push({
      name: `${tag} token budget`,
      pass: false,
      detail: `exceeded maxTokens (${spec.maxTokens}) — ${tokensIn + tokensOut} tokens used`,
    });
  } else if (stuckOn) {
    checks.push({
      name: `${tag} progress`,
      pass: false,
      detail: `agent stuck repeating failing action(s): ${stuckOn}`,
    });
  } else if (!finish) {
    checks.push({
      name: `${tag} completed`,
      pass: false,
      detail: 'agent did not finish in maxSteps',
    });
  } else if (finish.success === false) {
    checks.push({ name: `${tag} agent succeeded`, pass: false, detail: finish.summary });
  }
  for (const c of await evalAsserts(page, scenario.asserts ?? [])) {
    checks.push({ ...c, name: `${tag} ${c.name}` });
  }
  // A scenario with no asserts and a successful finish still needs one passing check.
  if (checks.length === 0) checks.push({ name: `${tag} agent succeeded`, pass: true });
  return { checks, tokensIn, tokensOut };
}

/**
 * agent-web mode — an LLM drives the live UI via Playwright to accomplish each scenario's
 * task, then assertions confirm the outcome. Optional deps (playwright + @anthropic-ai/sdk)
 * are lazy-loaded; a missing dep or ANTHROPIC_API_KEY yields a failing check (the gate is
 * honest that it could not validate) rather than a throw.
 */
export async function verifyAgentWeb(baseUrl: string, spec: AgentWebSpec): Promise<VerifyReport> {
  const base = baseUrl.replace(/\/+$/, '');

  if (!process.env.ANTHROPIC_API_KEY) {
    return report('agent-web', baseUrl, [
      {
        name: 'ANTHROPIC_API_KEY set',
        pass: false,
        detail: 'set ANTHROPIC_API_KEY to run agent-web',
      },
    ]);
  }

  let chromium: typeof import('playwright').chromium;
  let Anthropic: new (opts: { apiKey: string; timeout?: number; maxRetries?: number }) => {
    messages: { create(body: unknown): Promise<{ content: ContentBlock[] }> };
  };
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return report('agent-web', baseUrl, [
      {
        name: 'playwright available',
        pass: false,
        detail: 'pnpm add playwright && playwright install chromium',
      },
    ]);
  }
  try {
    // Non-literal specifier: @anthropic-ai/sdk is an optional dep we don't bundle/typecheck;
    // load it at runtime only (graceful if absent).
    const sdkName = '@anthropic-ai/sdk';
    const sdk = (await import(sdkName)) as { default: typeof Anthropic };
    Anthropic = sdk.default;
  } catch {
    return report('agent-web', baseUrl, [
      { name: '@anthropic-ai/sdk available', pass: false, detail: 'pnpm add @anthropic-ai/sdk' },
    ]);
  }

  // Bound each model call (60s) with one retry, so a hung Anthropic request can't stall the gate.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 60_000,
    maxRetries: 1,
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: !spec.headed });
  } catch (e) {
    return report('agent-web', baseUrl, [
      {
        name: 'launch browser',
        pass: false,
        detail: `${msg(e)} (try \`playwright install chromium\`)`,
      },
    ]);
  }

  const checks: VerifyCheck[] = [];
  const started = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    for (const scenario of spec.scenarios) {
      const page = await browser.newPage();
      try {
        const r = await runScenario(client, page, base, spec, scenario);
        checks.push(...r.checks);
        tokensIn += r.tokensIn;
        tokensOut += r.tokensOut;
      } catch (e) {
        checks.push({ name: `[${scenario.name}]`, pass: false, detail: msg(e) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  // Run metadata for the `--json` export: the driver model + its token usage + wall-clock.
  return {
    ...report('agent-web', baseUrl, checks),
    model: spec.model ?? 'claude-sonnet-4-6',
    durationMs: Date.now() - started,
    ...(tokensIn || tokensOut ? { tokensIn, tokensOut } : {}),
  };
}
