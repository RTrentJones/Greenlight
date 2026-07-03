/**
 * Readiness/reachability windows, in one place. These used to be three unrelated magic
 * numbers (120s / 30s / 90s) for what is one concept — "how long may a tool take to accept
 * connections". A tool that legitimately needs longer sets `readyTimeoutMs` on its manifest
 * entry instead of anyone editing a constant.
 */

/** `preview` descriptor path (docker compose up etc.) — image pulls make cold starts slow. */
export const DESCRIPTOR_READY_MS = 120_000;

/** `preview` built-in node serve — a local `pnpm run preview|start` should be up fast. */
export const BUILTIN_READY_MS = 30_000;

/** Remote verify (`--env beta|prod`) — absorbs the first-deploy TLS/DNS provisioning window. */
export const REMOTE_REACHABLE_MS = 90_000;

/** The effective window: the tool's manifest override, else the given default. */
export function readyTimeout(override: number | undefined, fallback: number): number {
  return override ?? fallback;
}
