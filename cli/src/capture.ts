import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type VerifyReport, toExportResult } from '@rtrentjones/greenlight-verify';
import { type CaptureEnv, captureRecord, rawOff } from '@rtrentjones/greenlight-wiki';
import { VERIFY_CONFIG_FILES } from './manifest';

/**
 * The raw record a gate leaves behind (vision 07 §2.4 step 1, 08 §5, roadmap M3-04): one file
 * under `.greenlight/raw/` per `preview`, `verify` or `ship`, pass or fail, with the run's
 * identity, the verify document and a redacted excerpt. Best effort: capture never changes a
 * gate's result, and `--no-capture` or `GREENLIGHT_RAW=off` turns it off.
 */

export interface GateCapture {
  kind: 'preview' | 'verify' | 'ship';
  tool: string;
  env: CaptureEnv;
  reports: readonly VerifyReport[];
  /** The tool's directory, relative to the wrapper root. */
  dir?: string;
  /** A registry (submodule) tool: its verify config lives at `verify/<tool>.config.ts`. */
  external?: boolean;
  /** An explicit verify config path (`verify --spec`). */
  specPath?: string;
  gitSha?: string | null;
  startedAt?: Date;
  wikiHits?: readonly string[];
  stages?: readonly Record<string, unknown>[];
  noCapture?: boolean;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
  log?: (s: string) => void;
}

const LOG_TAIL = 60;

/** What a reader needs first: the failing checks with their details, then the platform log tail. */
export function gateExcerpt(reports: readonly VerifyReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    const failed = r.checks.filter((c) => !c.pass);
    lines.push(
      `verify ${r.mode} ${r.url}: ${r.pass ? 'pass' : 'FAIL'} (${r.checks.length - failed.length}/${r.checks.length} checks)`,
    );
    for (const c of failed) {
      lines.push(`  ✘ ${c.id ? `[${c.id}] ` : ''}${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    if (!r.pass && r.logs) lines.push(...r.logs.split('\n').slice(-LOG_TAIL));
  }
  return lines.join('\n');
}

function verifyConfigPath(o: GateCapture, cwd: string): string | undefined {
  if (o.specPath) return resolve(cwd, o.specPath);
  if (o.external) {
    return VERIFY_CONFIG_FILES.map((f) =>
      resolve(cwd, 'verify', f.replace(/^verify/, o.tool)),
    ).find(existsSync);
  }
  return VERIFY_CONFIG_FILES.map((f) => resolve(cwd, o.dir ?? '.', f)).find(existsSync);
}

/** Writes the record and returns its raw id, or nothing when capture is off or fails. */
export function captureGate(o: GateCapture): string | undefined {
  const env = o.processEnv ?? process.env;
  if (o.noCapture || rawOff(env)) return undefined;
  try {
    const cwd = o.cwd ?? process.cwd();
    const dir = o.dir ? resolve(cwd, o.dir) : cwd;
    // A submodule has its own `.git`, so its commit is the tool's identity, not the wrapper's.
    const toolDir = dir !== cwd && existsSync(join(dir, '.git')) ? dir : cwd;
    const now = new Date();
    const pass = o.reports.length > 0 && o.reports.every((r) => r.pass);
    const record = captureRecord({
      cwd,
      toolDir,
      tool: o.tool,
      env: o.env,
      kind: o.kind,
      passed: pass,
      excerpt: o.reports.length > 0 ? gateExcerpt(o.reports) : 'the gate did not reach verify',
      verifyConfigPath: verifyConfigPath(o, cwd),
      verify: toExportResult([...o.reports], {
        tool: o.tool,
        env: o.env,
        gitSha: o.gitSha ?? null,
        wikiHits: o.wikiHits,
      }),
      stages: o.stages,
      wikiHits: o.wikiHits,
      startedAt: o.startedAt,
      now,
      processEnv: env,
    });
    (o.log ?? console.error)(`raw: ${record.rawId}`);
    return record.rawId;
  } catch {
    return undefined;
  }
}
