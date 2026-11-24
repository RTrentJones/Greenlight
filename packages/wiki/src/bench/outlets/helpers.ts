import type { z } from 'zod';

// ---- helpers --------------------------------------------------------------------------------

export function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const s = String((e as { stderr: unknown }).stderr ?? '').trim();
    if (s) return s;
  }
  return e instanceof Error ? e.message : String(e);
}

export function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function tail(s: string, lines = 15): string {
  return s.trimEnd().split('\n').slice(-lines).join('\n');
}
