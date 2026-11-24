import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { type GateConfig, GateConfigSchema, loadGateConfig } from '../gate';

// ---------------------------------------------------------------------------------------------

/** `<benchDir>/gate.json`, validated; the defaults when the file is absent. One reader for the
 * runner and the iteration, so a typo (`"runs": "5"`) is refused by both (exit 3) instead of
 * silently changing how many rollouts the evidence holds. */
export function readGateConfigFile(benchDir: string): GateConfig {
  const file = join(benchDir, 'gate.json');
  if (!existsSync(file)) return loadGateConfig({});
  return readJson(file, GateConfigSchema as unknown as z.ZodType<GateConfig>, 'bench/gate.json');
}

export function readJson<T>(path: string, schema: z.ZodType<T>, what: string): T {
  if (!existsSync(path)) throw new PrerequisiteError(`missing ${what} at ${path}`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new PrerequisiteError(`${what} at ${path} is not JSON: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new PrerequisiteError(
      `${what} at ${path} is not valid: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export class PrerequisiteError extends Error {}
