import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve the repo root from this file's location (robust to the test runner's cwd).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('supabase module safety', () => {
  it('keeps database_password in lifecycle.ignore_changes (removal would reset the live prod DB password)', () => {
    const tf = readFileSync(join(repoRoot, 'infra/modules/supabase/main.tf'), 'utf8');
    const m = tf.match(/ignore_changes\s*=\s*\[([^\]]*)\]/);
    expect(m, 'no ignore_changes block found in the supabase module').toBeTruthy();
    expect(m?.[1]).toContain('database_password');
  });
});
