import { FakeClock } from '../clock/testing/fake-clock';
import type { PrismaService } from '../prisma/prisma.service';
import { DeliveryAction, type DeliveryJobData } from '../queue/delivery-queue';
import type { DeliveryQueueProducer } from '../queue/delivery-queue.producer';
import { OutboxEventType } from './outbox-events';
import { OUTBOX_BATCH_SIZE, OUTBOX_MAX_ATTEMPTS } from './outbox-relay';
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

describe('OutboxRelay loop', () => {
  const INTERVAL = 1000;
  const round = (claimed: number) => ({
    reclaimed: 0,
    claimed,
    published: claimed,
    retried: 0,
    failed: 0,
  });

  function loop(intervalMs: number) {
    const { relay } = harness([]);
    const looping = new OutboxRelay(
      relay['prisma'],
      new FakeClock(NOW),
      relay['producer'],
      intervalMs,
    );
    const warn = jest.spyOn(looping['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(looping['logger'], 'log').mockImplementation(() => undefined);
    const poll = jest.spyOn(looping, 'pollOnce');
    return { looping, warn, poll };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a poll interval of 0 switches the loop off: no round ever runs', async () => {
    const { looping, poll } = loop(0);

    looping.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10 * INTERVAL);

    expect(poll).not.toHaveBeenCalled();
  });

  it('a round that throws (database down) is logged and tried again one interval later', async () => {
    const { looping, warn, poll } = loop(INTERVAL);
    poll.mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue(round(0));

    looping.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Outbox round failed, retrying: connection refused');

    await jest.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);

    await looping.onApplicationShutdown();
  });

  it('a full batch is followed at once by another round; a short one waits an interval', async () => {
    const { looping, poll } = loop(INTERVAL);
    poll
      .mockResolvedValueOnce(round(OUTBOX_BATCH_SIZE))
      .mockResolvedValueOnce(round(OUTBOX_BATCH_SIZE))
      .mockResolvedValue(round(3));

    looping.onApplicationBootstrap();
    // The two full rounds each schedule the next one with no delay.
    for (let i = 0; i < 3; i++) await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(INTERVAL - 10);
    expect(poll).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(10);
    expect(poll).toHaveBeenCalledTimes(4);

    await looping.onApplicationShutdown();
  });

  it('shutdown waits for the round in flight and schedules no other', async () => {
    const { looping, poll } = loop(INTERVAL);
    let finish: (report: ReturnType<typeof round>) => void = () => undefined;
    poll.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    looping.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    const stopped = looping.onApplicationShutdown();
    let done = false;
    void stopped.then(() => (done = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);

    finish(round(0));
    await stopped;
    await jest.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
