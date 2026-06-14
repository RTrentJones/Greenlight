import type { GreenlightConfigInput } from './schema';

/**
 * Identity helper for authoring `greenlight.config.ts` with full type inference
 * and editor autocomplete. Runtime validation happens in `loadConfig`.
 */
export function defineConfig(config: GreenlightConfigInput): GreenlightConfigInput {
  return config;
}
