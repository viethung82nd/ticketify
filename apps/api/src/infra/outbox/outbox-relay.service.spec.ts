import { FakeClock } from '../clock/testing/fake-clock';
import type { PrismaService } from '../prisma/prisma.service';
import { DeliveryAction, type DeliveryJobData } from '../queue/delivery-queue';
import type { DeliveryQueueProducer } from '../queue/delivery-queue.producer';
import { OutboxEventType } from './outbox-events';
import { OUTBOX_MAX_ATTEMPTS } from './outbox-relay';
import { OutboxRelay } from './outbox-relay.service';

const EVENT_ID = '01a3a1aa-7100-7679-b8b1-0000000000f1';
const BOOKING_ID = '01a3a1aa-7100-7679-b8b1-000000000001';
const NOW = '2026-11-05T10:00:00.000Z';

const claimedRow = (attempts = 1) => ({
  id: EVENT_ID,
  type: OutboxEventType.SEATS_RELEASED,
  aggregate_id: BOOKING_ID,
  payload: { bookingId: BOOKING_ID, seatIds: ['a'] },
  attempts,
});

interface Statement {
  sql: string;
  values: unknown[];
}

function harness(claimed: unknown[] = [claimedRow()]) {
  const statements: Statement[] = [];
  const record = (strings: TemplateStringsArray, values: unknown[]) =>
    statements.push({ sql: strings.join('$').replace(/\s+/g, ' ').trim(), values });
  const prisma = {
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(claimed);
    }),
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(1);
    }),
  } as unknown as PrismaService;
  const enqueued: { data: DeliveryJobData; actions: readonly DeliveryAction[] }[] = [];
  const producer = {
    enqueue: jest.fn((data: DeliveryJobData, actions: readonly DeliveryAction[]) => {
      enqueued.push({ data, actions });
      return Promise.resolve();
    }),
  } as unknown as DeliveryQueueProducer;
  const relay = new OutboxRelay(prisma, new FakeClock(NOW), producer, 0);
  // The relay logs every round; a test that asserts on a line spies on it again.
  for (const level of ['debug', 'warn', 'error'] as const) {
    jest.spyOn(relay['logger'], level).mockImplementation(() => undefined);
  }
  return { relay, statements, enqueued, producer };
}

const sqlOf = (statements: readonly Statement[]) => statements.map((s) => s.sql);

describe('OutboxRelay.pollOnce', () => {
  it('reclaims abandoned claims before claiming anything', async () => {
    const { relay, statements } = harness();

    await relay.pollOnce();

    expect(statements[0]?.sql).toContain("WHERE status = 'PROCESSING'");
    expect(statements[1]?.sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('hands each claimed event to the queue and marks it PUBLISHED', async () => {
    const { relay, statements, enqueued } = harness();

    const report = await relay.pollOnce();

    expect(enqueued).toEqual([
      {
        data: {
          eventId: EVENT_ID,
          type: OutboxEventType.SEATS_RELEASED,
          aggregateId: BOOKING_ID,
          payload: { bookingId: BOOKING_ID, seatIds: ['a'] },
        },
        actions: [DeliveryAction.BROADCAST_SEATS],
      },
    ]);
    expect(report).toEqual({ reclaimed: 1, claimed: 1, published: 1, retried: 0, failed: 0 });
    expect(sqlOf(statements).some((sql) => sql.includes("SET status = 'PUBLISHED'"))).toBe(true);
  });

  it('claims nothing and publishes nothing when the outbox is empty', async () => {
    const { relay, enqueued } = harness([]);

    const report = await relay.pollOnce();

    expect(enqueued).toEqual([]);
    expect(report.claimed).toBe(0);
    expect(report.published).toBe(0);
  });

  it('leaves an event for later when the queue refuses it, and keeps going', async () => {
    const { relay, producer, statements } = harness([claimedRow(), claimedRow()]);
    jest
      .spyOn(producer, 'enqueue')
      .mockRejectedValueOnce(new Error('Redis did not answer within 5000ms'))
      .mockResolvedValueOnce(undefined);
    jest.spyOn(relay['logger'], 'warn').mockImplementation(() => undefined);

    const report = await relay.pollOnce();

    expect(report).toMatchObject({ claimed: 2, retried: 1, failed: 0 });
    // The retry of one event, not the sweep of abandoned claims (which also sets next_retry_at).
    const retry = statements.find((s) => s.sql.includes('::outbox_status, next_retry_at'));
    expect(retry?.values).toEqual([
      'PENDING',
      new Date('2026-11-05T10:00:02.000Z'),
      'Redis did not answer within 5000ms',
      EVENT_ID,
    ]);
  });

  it('gives up on an event that has used up its attempts', async () => {
    const { relay, producer } = harness([claimedRow(OUTBOX_MAX_ATTEMPTS)]);
    jest.spyOn(producer, 'enqueue').mockRejectedValue(new Error('Redis down'));
    const logged = jest.spyOn(relay['logger'], 'error').mockImplementation(() => undefined);

    const report = await relay.pollOnce();

    expect(report).toMatchObject({ retried: 0, failed: 1, published: 0 });
    expect(logged.mock.calls[0]?.[0]).toContain('given up on');
  });

  it('names the process in locked_by', async () => {
    const { relay, statements } = harness();

    await relay.pollOnce();

    expect(statements[1]?.values).toContain(relay.lockedBy);
    expect(relay.lockedBy).toContain(String(process.pid));
  });
});
