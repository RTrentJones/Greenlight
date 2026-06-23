/**
 * Dangerous-SQL scan — the migration gate the security model promises ("migrations pass a
 * dangerous-SQL scan gate before apply"). A heuristic lint, not a SQL parser: it splits a file into
 * `;`-delimited statements and flags data-destroying or lock-heavy patterns. `danger` findings are
 * meant to FAIL the gate; `warn` findings are advisory. An intentional op is acknowledged with an
 * inline `-- greenlight:allow` comment in the statement, which suppresses its findings.
 *
 * Known limits (it's a lint): a `;` inside a string literal splits wrong, and a dynamic `EXECUTE`
 * can hide intent. Treat it as a tripwire that forces a human ack on the obvious foot-guns, not a
 * proof of safety.
 */

export type SqlSeverity = 'danger' | 'warn';

export interface SqlFinding {
  file: string;
  line: number;
  rule: string;
  severity: SqlSeverity;
  detail: string;
  snippet: string;
}

interface SqlRule {
  name: string;
  severity: SqlSeverity;
  detail: string;
  test: RegExp;
}

const RULES: SqlRule[] = [
  {
    name: 'drop-table',
    severity: 'danger',
    detail: 'DROP TABLE destroys a table and its data',
    test: /\bDROP\s+TABLE\b/i,
  },
  {
    name: 'drop-column',
    severity: 'danger',
    detail: 'DROP COLUMN destroys a column and its data',
    test: /\bDROP\s+COLUMN\b/i,
  },
  {
    name: 'drop-schema',
    severity: 'danger',
    detail: 'DROP SCHEMA destroys a schema',
    test: /\bDROP\s+SCHEMA\b/i,
  },
  {
    name: 'drop-database',
    severity: 'danger',
    detail: 'DROP DATABASE destroys a database',
    test: /\bDROP\s+DATABASE\b/i,
  },
  {
    name: 'truncate',
    severity: 'danger',
    detail: 'TRUNCATE empties a table irreversibly',
    test: /\bTRUNCATE\b/i,
  },
  {
    name: 'delete-without-where',
    severity: 'danger',
    detail: 'DELETE without WHERE removes every row',
    test: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i,
  },
  {
    name: 'update-without-where',
    severity: 'danger',
    detail: 'UPDATE … SET without WHERE rewrites every row',
    test: /\bUPDATE\s+[^\s;]+\s+SET\b(?![\s\S]*\bWHERE\b)/i,
  },
  {
    name: 'non-concurrent-index',
    severity: 'warn',
    detail: 'CREATE INDEX without CONCURRENTLY locks writes (fine on a new/empty table)',
    test: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?![\s\S]*\bCONCURRENTLY\b)/i,
  },
  {
    name: 'alter-column-type',
    severity: 'warn',
    detail: 'ALTER COLUMN … TYPE can rewrite + lock the table',
    test: /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i,
  },
];

const ALLOW = /greenlight:\s*allow/i;

/** Scan one SQL document; returns the findings (empty = clean). */
export function scanSql(content: string, file = '<sql>'): SqlFinding[] {
  // Lines carrying an explicit ack — a statement that overlaps one is suppressed.
  const allowLines = new Set<number>();
  content.split('\n').forEach((ln, i) => {
    if (ALLOW.test(ln)) allowLines.add(i + 1);
  });

  // Blank out comments to spaces BUT keep newlines, so (a) a `;` inside a comment can't split a
  // statement, (b) a commented-out DROP isn't matched, and (c) offsets/line numbers stay aligned
  // with the original (same length).
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

  const findings: SqlFinding[] = [];
  let pos = 0; // offset of the current statement in `stripped` (== offset in `content`)
  for (const stmt of stripped.split(';')) {
    const lead = stmt.length - stmt.trimStart().length; // skip the leading newline from `;\n`
    const startLine = content.slice(0, pos + lead).split('\n').length;
    const endLine = content.slice(0, pos + stmt.length).split('\n').length;
    pos += stmt.length + 1; // +1 for the ';' consumed by split
    if (!stmt.trim()) continue;

    let allowed = false;
    for (let l = startLine; l <= endLine; l++) {
      if (allowLines.has(l)) {
        allowed = true;
        break;
      }
    }
    if (allowed) continue;

    for (const rule of RULES) {
      if (rule.test.test(stmt)) {
        findings.push({
          file,
          line: startLine,
          rule: rule.name,
          severity: rule.severity,
          detail: rule.detail,
          snippet: stmt.replace(/\s+/g, ' ').trim().slice(0, 100),
        });
      }
    }
  }
  return findings;
}

/** Scan many files (e.g. a migrations dir already read into memory). */
export function scanSqlFiles(files: Array<{ path: string; content: string }>): SqlFinding[] {
  return files.flatMap((f) => scanSql(f.content, f.path));
}
