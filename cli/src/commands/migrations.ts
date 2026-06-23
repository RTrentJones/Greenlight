import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanSqlFiles } from '@rtrentjones/greenlight-shared';

const DEFAULT_DIR = 'supabase/migrations';

/**
 * `greenlight migrations scan [<dir>] [--strict]` — the pre-apply dangerous-SQL gate. Scans the
 * `.sql` files in a migrations dir and exits non-zero on a `danger` finding (data-destroying op),
 * `--strict` also fails on `warn`s. Wire it into a data tool's CI before `supabase db push` / the
 * apply step. Acknowledge an intentional op with an inline `-- greenlight:allow`.
 */
export async function migrationsCommand(args: string[]): Promise<void> {
  if (args[0] !== 'scan') {
    console.log(
      `usage: greenlight migrations scan [<dir>] [--strict]
  scan SQL migrations for data-destroying / lock-heavy statements (the pre-apply gate).
  default dir: ${DEFAULT_DIR}. Acknowledge an intentional op with \`-- greenlight:allow\`.`,
    );
    process.exit(args[0] ? 1 : 0);
  }

  const dir = args.slice(1).find((a) => !a.startsWith('-')) ?? DEFAULT_DIR;
  const strict = args.includes('--strict');

  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log(`· no migrations dir at ${dir} — nothing to scan`);
    process.exit(0);
  }
  if (names.length === 0) {
    console.log(`· no .sql files in ${dir} — nothing to scan`);
    process.exit(0);
  }

  const files = names.map((f) => ({
    path: join(dir, f),
    content: readFileSync(join(dir, f), 'utf8'),
  }));
  const findings = scanSqlFiles(files);

  if (findings.length === 0) {
    console.log(`✔ migrations scan: ${names.length} file(s) clean (${dir})`);
    process.exit(0);
  }

  for (const f of findings) {
    console.log(
      `  ${f.severity === 'danger' ? '✘' : '!'} ${f.file}:${f.line} [${f.rule}] ${f.detail}\n      ${f.snippet}`,
    );
  }
  const dangers = findings.filter((f) => f.severity === 'danger');
  const blocking = strict ? findings : dangers;
  const verdict =
    blocking.length === 0 ? '✔ no blocking findings' : `✘ ${blocking.length} blocking finding(s)`;
  console.log(
    `\n${verdict} (${dangers.length} danger, ${findings.length - dangers.length} warn). Acknowledge an intentional op with \`-- greenlight:allow\`.`,
  );
  process.exit(blocking.length === 0 ? 0 : 1);
}
