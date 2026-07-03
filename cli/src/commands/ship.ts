import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSha, createAdapter } from '@rtrentjones/greenlight-adapters';
import { type StageEvent, runShip } from '@rtrentjones/greenlight-loop';
import type { DeployEnv } from '@rtrentjones/greenlight-shared';
import { parseFlags } from '../args';
import {
  type VerifyConfigContext,
  loadExternalVerifySpec,
  loadManifest,
  loadVerifySpec,
  resolveEntry,
} from '../manifest';
import { REMOTE_REACHABLE_MS, readyTimeout } from '../timeouts';
import { defaultSpec, printReport, runVerify, warnDefaultSpec } from './verify';

/**
 * `greenlight ship <name> --env <beta|prod>` — one in-process loop turn: build → deploy →
 * SHA-gated verify → rollback-on-failure. The paved road that replaces the
 * `greenlight deploy X && greenlight verify X` pair every workflow used to compose in shell
 * (where a failed verify could only ever be a red X — the deploy context was already gone).
 *
 * Every stage emits a StageEvent: a JSON line on stderr, appended to `--events <file>` when
 * given, and POSTed to `$GREENLIGHT_INGEST_URL` (bearer `$TRACER_INGEST_TOKEN`) when both are
 * set — best-effort, 5s timeout, never fails the ship. These events are the loop's own
 * telemetry: push→healthy-in-prod latency, first-pass gate rate, rollback MTTR.
 */

/** Map a StageEvent to the tracer-compatible ingest shape (free-form `mode` carries the stage;
 * `model` is required by the schema, so the producer name stands in). Exported for tests. */
export function stageEventToIngest(e: StageEvent): Record<string, unknown> {
  return {
    tool: e.tool,
    model: 'greenlight',
    mode: e.stage,
    env: e.env,
    passed: e.passed,
    git_sha: e.gitSha,
    duration_ms: e.durationMs,
    cases: [],
  };
}

/** Best-effort POST of a stage event to the configured ingest endpoint. Never throws — a
 * metrics sink outage must not fail a ship. */
async function postStageEvent(e: StageEvent): Promise<void> {
  const url = process.env.GREENLIGHT_INGEST_URL;
  const token = process.env.TRACER_INGEST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(stageEventToIngest(e)),
    });
  } catch {
    // best-effort — the ship's outcome is the gate, the event stream is telemetry
  }
}

/** The deploy-verify-promote skill version driving this run: explicit env override, else the
 * `version:` frontmatter of the repo's installed skill. Stamped on stage events so skill-text
 * changes can be compared against gate outcomes (first-pass rate per skill version). */
export function skillVersion(cwd: string = process.cwd()): string | undefined {
  if (process.env.GREENLIGHT_SKILL_VERSION) return process.env.GREENLIGHT_SKILL_VERSION;
  try {
    const text = readFileSync(
      resolve(cwd, '.claude/skills/deploy-verify-promote/SKILL.md'),
      'utf8',
    );
    return text.match(/^version:\s*["']?([\w.-]+)/m)?.[1];
  } catch {
    return undefined;
  }
}

export function stageEventSink(eventsFile?: string): (e: StageEvent) => Promise<void> {
  return async (e) => {
    const line = JSON.stringify({ type: 'greenlight.stage', ...e });
    console.error(line);
    if (eventsFile) {
      try {
        appendFileSync(eventsFile, `${line}\n`);
      } catch (err) {
        console.error(
          `(could not append to ${eventsFile}: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    await postStageEvent(e);
  };
}

export async function shipCommand(args: string[]): Promise<number> {
  const parsed = parseFlags('ship', args, {
    value: ['--env', '--expect-sha', '--events'],
    boolean: ['--no-rollback'],
  });
  const name = parsed.positional[0];
  if (!name) {
    throw new Error(
      'usage: greenlight ship <name> --env <beta|prod> [--expect-sha <sha>] [--events <file>] [--no-rollback]',
    );
  }
  const env = parsed.values['--env'] as DeployEnv | undefined;
  if (env !== 'beta' && env !== 'prod') {
    throw new Error('ship needs --env beta|prod (preview stays `greenlight preview`)');
  }

  const { config } = await loadManifest();
  const entry = resolveEntry(config, name);
  if (entry.external && entry.target !== 'oci' && entry.target !== 'docker') {
    throw new Error(`"${name}" is external (registry pointer) — ship it from its own repo`);
  }
  const adapter = createAdapter(entry.target, { domain: config.domain, name: entry.name });
  const toolDir = resolve(process.cwd(), entry.dir ?? '.');

  // The identity this ship gates: explicit flag, else the commit being built (CI's GITHUB_SHA,
  // else local HEAD). Unlike standalone `verify`, defaulting is CORRECT here — ship builds and
  // deploys this very commit, so it is by construction the sha the verify must see.
  const gitSha = parsed.values['--expect-sha'] ?? buildSha(toolDir);

  const ctx: VerifyConfigContext = { env, url: undefined, preview: false };
  const loaded = entry.external
    ? await loadExternalVerifySpec(name, ctx)
    : await loadVerifySpec(entry.dir, ctx);
  if (!loaded) warnDefaultSpec(name, entry.lane);
  const resolvedSpecs = loaded ?? defaultSpec(entry.lane);
  const specs = Array.isArray(resolvedSpecs) ? resolvedSpecs : [resolvedSpecs];

  console.log(
    `ship ${name} (${entry.lane}/${entry.target}) → ${env}${gitSha ? ` @ ${gitSha.slice(0, 7)}` : ''}`,
  );
  const result = await runShip({
    adapter,
    toolDir,
    tool: name,
    env,
    connectPath: entry.lane === 'mcp' ? '/mcp' : undefined,
    gitSha,
    skillVersion: skillVersion(),
    rollbackOnFailure: !parsed.flags.has('--no-rollback'),
    onStage: stageEventSink(parsed.values['--events']),
    verify: (url) =>
      runVerify(specs, url, {
        toolDir,
        reachableTimeoutMs: readyTimeout(entry.readyTimeoutMs, REMOTE_REACHABLE_MS),
        expectedSha: gitSha,
      }),
  });

  for (const report of result.reports) printReport(report);
  if (result.rollback) {
    console.log(
      `${result.rollback.ok ? '↩ rolled back' : '⚠ rollback unavailable'} — ${result.rollback.detail}`,
    );
  }
  console.log(`\n${result.ok ? `✔ shipped ${name} → ${env}` : `✘ ship failed (${name} → ${env})`}`);
  return result.ok ? 0 : 1;
}
