import { describe, expect, it } from 'vitest';
import { scanSql } from '../sql-scan';

const rules = (sql: string) => scanSql(sql).map((f) => f.rule);

describe('scanSql — dangerous-SQL gate', () => {
  it('flags data-destroying statements as danger', () => {
    expect(rules('DROP TABLE users;')).toContain('drop-table');
    expect(rules('ALTER TABLE users DROP COLUMN email;')).toContain('drop-column');
    expect(rules('TRUNCATE sessions;')).toContain('truncate');
    expect(scanSql('DROP TABLE users;')[0]?.severity).toBe('danger');
  });

  it('flags DELETE/UPDATE without WHERE, but not the guarded forms', () => {
    expect(rules('DELETE FROM users;')).toContain('delete-without-where');
    expect(rules("DELETE FROM users WHERE id = '1';")).not.toContain('delete-without-where');
    expect(rules('UPDATE users SET active = false;')).toContain('update-without-where');
    expect(rules("UPDATE users SET active = false WHERE id = '1';")).not.toContain(
      'update-without-where',
    );
  });

  it('does not false-positive on ON UPDATE CASCADE (a FK clause, not an UPDATE statement)', () => {
    const sql =
      'CREATE TABLE t (id uuid, parent uuid REFERENCES p(id) ON UPDATE CASCADE ON DELETE CASCADE);';
    expect(scanSql(sql)).toHaveLength(0);
  });

  it('warns (not danger) on a non-concurrent index', () => {
    const f = scanSql('CREATE INDEX idx_users_email ON users (email);');
    expect(f[0]?.rule).toBe('non-concurrent-index');
    expect(f[0]?.severity).toBe('warn');
    expect(scanSql('CREATE INDEX CONCURRENTLY idx_users_email ON users (email);')).toHaveLength(0);
  });

  it('an inline `-- greenlight:allow` acknowledges and suppresses the statement', () => {
    expect(scanSql('DROP TABLE legacy; -- greenlight:allow one-time cleanup')).toHaveLength(0);
  });

  it('ignores a commented-out dangerous statement', () => {
    expect(scanSql('-- DROP TABLE users;\nSELECT 1;')).toHaveLength(0);
    expect(scanSql('/* DROP TABLE users; */ SELECT 1;')).toHaveLength(0);
  });

  it('reports the file + a 1-based line number', () => {
    const f = scanSql('SELECT 1;\nSELECT 2;\nTRUNCATE big;', 'm/0001.sql');
    expect(f[0]?.file).toBe('m/0001.sql');
    expect(f[0]?.line).toBe(3);
  });

  it('a normal CREATE TABLE migration is clean', () => {
    expect(scanSql('CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);')).toHaveLength(
      0,
    );
  });
});
