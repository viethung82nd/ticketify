import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '../support/database';

const ERD_PATH = join(__dirname, '..', '..', '..', '..', 'docs', 'erd.md');

/** Parses `name { type column ... }` blocks of the Mermaid erDiagram in docs/erd.md. */
function erdTables(markdown: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const block of markdown.matchAll(/^ {4}(\w+) \{\n([\s\S]*?)\n {4}\}/gm)) {
    const [, table, body] = block;
    const columns = (body ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((column): column is string => Boolean(column));
    tables.set(table!, columns.sort());
  }
  return tables;
}

describe('docs/erd.md', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('documents exactly the tables and columns of the migrated database', async () => {
    const rows = await db.prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      ORDER BY table_name, column_name`;
    const actual = new Map<string, string[]>();
    for (const { table_name, column_name } of rows) {
      actual.set(table_name, [...(actual.get(table_name) ?? []), column_name]);
    }

    const documented = erdTables(readFileSync(ERD_PATH, 'utf8'));

    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(actual));
  });
});
