import type { Prisma } from '../../../generated/prisma/client';

/** One statement the mock transaction received: SQL (whitespace squeezed) and its values. */
export interface Statement {
  sql: string;
  values: unknown[];
}

interface CreateArgs {
  data: unknown;
}

/**
 * Stand-in for the transaction client of the IPN code: `$queryRaw` answers from `rows` in order,
 * `$executeRaw` answers `affected` (row counts) in order. The two Prisma API writes the IPN uses
 * are recorded as `INSERT INTO tickets` / `INSERT INTO outbox_events`, with their `data` as the
 * only value. Every statement is recorded, in order.
 */
export function mockTx(rows: unknown[][], affected: number[] = []) {
  const statements: Statement[] = [];
  const record = (sql: string, values: unknown[]) => statements.push({ sql, values });
  const raw = (strings: TemplateStringsArray, values: unknown[]) =>
    record(strings.join('$').replace(/\s+/g, ' ').trim(), values);
  const tx = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      raw(strings, values);
      return Promise.resolve(rows.shift() ?? []);
    }),
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      raw(strings, values);
      return Promise.resolve(affected.shift() ?? 0);
    }),
    ticket: {
      createManyAndReturn: jest.fn(({ data }: CreateArgs) => {
        record('INSERT INTO tickets', [data]);
        const lines = Array.isArray(data) ? data : [data];
        return Promise.resolve(lines.map((_, i) => ({ id: mockTicketId(i + 1) })));
      }),
    },
    outboxEvent: {
      create: jest.fn(({ data }: CreateArgs) => {
        record('INSERT INTO outbox_events', [data]);
        return Promise.resolve({ id: 'outbox-1' });
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements, mock: tx };
}

/**
 * Id the mock gives the n-th ticket (1-based). A real uuid v7, not `ticket-1`: the outbox payload
 * it ends up in is parsed as uuids by the delivery worker (ROADMAP 4.1).
 */
export const mockTicketId = (n: number): string =>
  `01a17e75-7100-7679-b8b1-${String(n).padStart(12, '0')}`;

/** The statements that write (raw UPDATE/INSERT and the recorded Prisma inserts). */
export const writes = (statements: readonly Statement[]): Statement[] =>
  statements.filter((s) => /^(UPDATE|INSERT)\b/.test(s.sql));
