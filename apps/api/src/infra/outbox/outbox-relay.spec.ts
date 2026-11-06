import { OutboxEventType } from './outbox-events';
import {
  claimOutboxBatch,
  markPublished,
  markRetry,
  nextRetryAt,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_MAX_MS,
  OUTBOX_STALE_CLAIM_MS,
  reasonOf,
  type OutboxDb,
  reclaimStaleClaims,
  retryDelayMs,
} from './outbox-relay';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const EVENT_ID = '01a3a1aa-7100-7679-b8b1-000000000001';

interface Statement {
  sql: string;
  values: unknown[];
}

/** Stand-in for the Prisma client: records every statement, answers from `rows` in order. */
function mockDb(rows: unknown[][] = []) {
  const statements: Statement[] = [];
  const record = (strings: TemplateStringsArray, values: unknown[]) =>
    statements.push({ sql: strings.join('$').replace(/\s+/g, ' ').trim(), values });
  const db = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(rows.shift() ?? []);
    }),
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(1);
    }),
  };
  return { db: db as unknown as OutboxDb, statements };
}

describe('retryDelayMs', () => {
  it('doubles from 2 s and is capped', () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(3)).toBe(8_000);
    expect(retryDelayMs(99)).toBe(OUTBOX_RETRY_MAX_MS);
  });

  it('treats a missing attempt count as the first try', () => {
    expect(retryDelayMs(0)).toBe(2_000);
  });

  it('nextRetryAt adds the delay to now', () => {
    expect(nextRetryAt(NOW, 2).toISOString()).toBe('2026-11-05T10:00:04.000Z');
  });
});

describe('claimOutboxBatch', () => {
  it('claims due events of known types with FOR UPDATE SKIP LOCKED', async () => {
    const { db, statements } = mockDb([
      [
        {
          id: EVENT_ID,
          type: OutboxEventType.SEATS_RELEASED,
          aggregate_id: 'booking-1',
          payload: { seatIds: ['a'] },
          attempts: 1,
        },
      ],
    ]);

    const events = await claimOutboxBatch(db, {
      now: NOW,
      lockedBy: 'host-1',
      types: [OutboxEventType.SEATS_RELEASED],
    });

    expect(events).toEqual([
      {
        id: EVENT_ID,
        type: OutboxEventType.SEATS_RELEASED,
        aggregateId: 'booking-1',
        payload: { seatIds: ['a'] },
        attempts: 1,
      },
    ]);
    const [claim] = statements;
    expect(claim?.sql).toContain("WHERE status = 'PENDING'");
    expect(claim?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim?.sql).toContain("SET status = 'PROCESSING'");
    expect(claim?.sql).toContain('attempts = e.attempts + 1');
    expect(claim?.values).toEqual([
      NOW,
      [OutboxEventType.SEATS_RELEASED],
      OUTBOX_BATCH_SIZE,
      NOW,
      'host-1',
    ]);
  });

  it('writes nothing when this build can deliver no event type', async () => {
    const { db, statements } = mockDb();

    await expect(
      claimOutboxBatch(db, { now: NOW, lockedBy: 'host-1', types: [] }),
    ).resolves.toEqual([]);

    expect(statements).toEqual([]);
  });

  it('replaces a payload that is not an object with an empty one', async () => {
    const { db } = mockDb([
      [
        {
          id: EVENT_ID,
          type: OutboxEventType.SEATS_RELEASED,
          aggregate_id: 'booking-1',
          payload: 'nonsense',
          attempts: 1,
        },
      ],
    ]);

    const [event] = await claimOutboxBatch(db, {
      now: NOW,
      lockedBy: 'host-1',
      types: [OutboxEventType.SEATS_RELEASED],
    });

    expect(event?.payload).toEqual({});
  });
});

describe('markPublished', () => {
  it('clears the claim and the last error', async () => {
    const { db, statements } = mockDb();

    await markPublished(db, [EVENT_ID]);

    expect(statements[0]?.sql).toContain("SET status = 'PUBLISHED'");
    expect(statements[0]?.sql).toContain('last_error = NULL');
    expect(statements[0]?.values).toEqual([[EVENT_ID]]);
  });

  it('runs no statement for an empty list', async () => {
    const { db, statements } = mockDb();

    await expect(markPublished(db, [])).resolves.toBe(0);

    expect(statements).toEqual([]);
  });
});

describe('markRetry', () => {
  it('goes back to PENDING with a backoff and the reason', async () => {
    const { db, statements } = mockDb();

    const status = await markRetry(db, { id: EVENT_ID, attempts: 2 }, NOW, new Error('Redis down'));

    expect(status).toBe('PENDING');
    expect(statements[0]?.values).toEqual([
      'PENDING',
      new Date('2026-11-05T10:00:04.000Z'),
      'Redis down',
      EVENT_ID,
    ]);
  });

  it('gives up once the attempts are used up', async () => {
    const { db, statements } = mockDb();

    const status = await markRetry(
      db,
      { id: EVENT_ID, attempts: OUTBOX_MAX_ATTEMPTS },
      NOW,
      new Error('Redis down'),
    );

    expect(status).toBe('FAILED');
    expect(statements[0]?.values[0]).toBe('FAILED');
  });
});

describe('reclaimStaleClaims', () => {
  it('only touches claims older than the stale window', async () => {
    const { db, statements } = mockDb();

    await reclaimStaleClaims(db, NOW);

    expect(statements[0]?.sql).toContain("WHERE status = 'PROCESSING' AND locked_at < $");
    expect(statements[0]?.values).toEqual([
      OUTBOX_MAX_ATTEMPTS,
      NOW,
      expect.stringContaining('claim expired'),
      new Date(NOW.getTime() - OUTBOX_STALE_CLAIM_MS),
    ]);
  });
});

describe('reasonOf', () => {
  it('keeps the first line and bounds the length', () => {
    expect(reasonOf(new Error('boom\nat somewhere'))).toBe('boom');
    expect(reasonOf('x'.repeat(900))).toHaveLength(500);
    expect(reasonOf(undefined)).toBe('undefined');
  });
});
