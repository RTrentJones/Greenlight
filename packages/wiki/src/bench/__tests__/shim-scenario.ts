import type { TrajectoryEvent } from '../../schema/bench';
import { type ShimContext, normalizeShimEvent } from '../trajectory';

/**
 * `shim.json` next to a loop mutant's / alternative's `trajectory.jsonl` records what the
 * runner's shims saw for each command (argv, exit, ShimContext), so the recorded `meta` can be
 * re-derived with `normalizeShimEvent` (trajectory.test.ts asserts it for every such file).
 * A `transcript` entry is an agent tool call, recorded verbatim (with any `meta` it claims).
 */
export interface ShimScenario {
  ctx?: ShimContext;
  events: Array<{
    transcript?: string;
    cmd?: string;
    argv: string[];
    exit?: number;
    ctx?: ShimContext;
    meta?: Record<string, string>;
    cwd?: string;
  }>;
}

const START = Date.parse('2026-11-01T10:00:00Z');

export function scenarioEvents(s: ShimScenario): TrajectoryEvent[] {
  return s.events.map((e, i) => {
    const ts = new Date(START + i * 7000).toISOString().replace('.000Z', 'Z');
    const cwd = e.cwd ?? '/sandbox';
    if (e.transcript) {
      return {
        seq: i,
        ts,
        source: 'transcript' as const,
        cmd: e.transcript,
        argv: e.argv,
        cwd,
        ...(e.meta ? { meta: e.meta } : {}),
      };
    }
    const ctx = { ...s.ctx, ...e.ctx };
    return { seq: i, ts, ...normalizeShimEvent(e.cmd ?? '', e.argv, cwd, e.exit ?? 0, ctx) };
  });
}

export const buildTrajectory = (s: ShimScenario): string =>
  `${scenarioEvents(s)
    .map((e) => JSON.stringify(e))
    .join('\n')}\n`;
