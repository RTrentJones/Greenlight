import type { ModelsConfig } from '../../schema/bench';

// ---------------------------------------------------------------------------------------------
// selection

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Role names or ids → configured model ids, in models.json order (frontier, small). */
export function resolveModels(config: ModelsConfig, wanted?: readonly string[]): string[] {
  const entries = [
    ['frontier', config.roles.frontier.id],
    ['small', config.roles.small.id],
  ] as const;
  if (!wanted || wanted.length === 0) return entries.map(([, id]) => id);
  for (const w of wanted) {
    if (!entries.some(([r, id]) => r === w || id === w))
      throw new UsageError(`unknown model "${w}" (expected frontier, small or a configured id)`);
  }
  return entries.filter(([r, id]) => wanted.includes(r) || wanted.includes(id)).map(([, id]) => id);
}

export const roleOf = (config: ModelsConfig, id: string): 'frontier' | 'small' =>
  config.roles.frontier.id === id ? 'frontier' : 'small';

export class UsageError extends Error {}

/** `models/x` and `x` name one model (the API's `modelVersion` may carry the prefix). */
export const normalizeModelId = (id: string): string => id.replace(/^models\//, '');
