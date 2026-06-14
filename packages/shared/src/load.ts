import { createJiti } from 'jiti';
import { ConfigSchema, type GreenlightConfig } from './schema';

/**
 * Load and validate a `greenlight.config.ts` (or `.example.ts`).
 *
 * Uses jiti to evaluate the TypeScript manifest at runtime (no build step),
 * then runs it through the Zod schema — including the lane × target × data
 * matrix — returning a fully-typed, defaults-applied config. Throws with a
 * readable, multi-line message on any validation failure.
 */
export async function loadConfig(path: string): Promise<GreenlightConfig> {
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(path)) as Record<string, unknown>;
  const raw = 'default' in mod ? mod.default : mod;

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid Greenlight manifest at ${path}:\n${details}`);
  }
  return result.data;
}
