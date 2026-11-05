import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { OutboxEventType, SeatsReleasedCause } from '../../src/infra/outbox/outbox-events';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALE_CLAIM_MS,
} from '../../src/infra/outbox/outbox-relay';
import { OUTBOX_POLL_INTERVAL_MS, OutboxRelay } from '../../src/infra/outbox/outbox-relay.service';
import {
  DeliveryAction,
  type DeliveryJobData,
  deliveryJobId,
} from '../../src/infra/queue/delivery-queue';
import { DeliveryQueueProducer } from '../../src/infra/queue/delivery-queue.producer';
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../src/modules/bookings/booking-expiry.service';
import { DeliveryProcessor } from '../../src/modules/delivery/delivery.processor';
import {
  SeatEvents,
  type SeatEventName,
  type SeatEventPayload,
} from '../../src/modules/realtime/seat-events';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { createTestRedis, type TestRedis } from '../support/redis';

const NOW = '2026-11-05T10:00:00.000Z';
const A_BOOKING = '01a3a1aa-7100-7679-b8b1-000000000001';
const A_SHOWTIME = '01a3a1aa-7100-7679-b8b1-0000000000a1';
const A_SEAT = '01a3a1aa-7100-7679-b8b1-0000000000c1';

/** Records what the worker would have published to the showtime rooms. */
class RecordingSeatEvents extends SeatEvents {
  readonly sent: { room: string; event: SeatEventName; payload: SeatEventPayload }[] = [];

  protected emit(room: string, event: SeatEventName, payload: SeatEventPayload): void {
    this.sent.push({ room, event, payload });
  }
}

interface OutboxRow {
  status: string;
  attempts: number;
  next_retry_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
}

describe('Outbox relay — claim, backoff, abandoned claims, delivery (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let workerRef: TestingModule;
  let relay: OutboxRelay;
  let producer: DeliveryQueueProducer;
  let processor: DeliveryProcessor;
  let seatEvents: RecordingSeatEvents;
  let fixtures: Fixtures;
  let expiry: BookingExpiryService;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    fixtures = createFixtures(db.prisma);
    seatEvents = new RecordingSeatEvents();

    // A worker context like `main.worker.ts` boots, with both loops off: the test drives them.
    const { WorkerModule } = await import('../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(OUTBOX_POLL_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(SeatEvents)
      .useValue(seatEvents)
      .compile();
    relay = workerRef.get(OutboxRelay);
    producer = workerRef.get(DeliveryQueueProducer);
    processor = workerRef.get(DeliveryProcessor);
    expiry = workerRef.get(BookingExpiryService);
  });

  afterAll(async () => {
    await workerRef?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(async () => {
    clock.set(NOW);
    seatEvents.sent.length = 0;
    await db.prisma.outboxEvent.deleteMany();
    await producer.queue.obliterate({ force: true });
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const seatsReleased = (seatIds: string[], showtimeId = A_SHOWTIME, bookingId = A_BOOKING) => ({
    bookingId,
    showtimeId,
    seatIds,
    cause: SeatsReleasedCause.BOOKING_EXPIRED,
  });

  interface EventOverrides {
    type?: OutboxEventType;
    nextRetryAt?: Date;
    status?: 'PENDING' | 'PROCESSING';
    lockedAt?: Date;
    attempts?: number;
  }

  /** One `seats.released` event, due now unless told otherwise, written straight to the table. */
  async function event(overrides: EventOverrides = {}): Promise<string> {
    const row = await db.prisma.outboxEvent.create({
      data: {
        type: overrides.type ?? OutboxEventType.SEATS_RELEASED,
        aggregateId: A_BOOKING,
        payload: seatsReleased([A_SEAT]),
        status: overrides.status ?? 'PENDING',
        attempts: overrides.attempts ?? 0,
        nextRetryAt: overrides.nextRetryAt ?? clock.now(),
        lockedAt: overrides.lockedAt,
        lockedBy: overrides.lockedAt ? 'dead-worker-1' : undefined,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function rowOf(id: string): Promise<OutboxRow> {
    const [row] = await db.prisma.$queryRaw<OutboxRow[]>`
      SELECT status::text AS status, attempts, next_retry_at, locked_at, locked_by, last_error
      FROM outbox_events WHERE id = ${id}::uuid`;
    if (!row) throw new Error(`No outbox event ${id}`);
    return row;
  }

  const jobOf = (id: string, action: DeliveryAction): Promise<Job<DeliveryJobData> | undefined> =>
    producer.queue.getJob(deliveryJobId(id, action));

  const quiet = (level: 'warn' | 'error' | 'debug') =>
    jest.spyOn(relay['logger'], level).mockImplementation(() => undefined);

  // ─── Tests ───

  it('claims a due event, enqueues its job and marks the row PUBLISHED', async () => {
    const id = await event();

    const report = await relay.pollOnce();

    expect(report).toMatchObject({ claimed: 1, published: 1, retried: 0, failed: 0 });
    expect(await rowOf(id)).toMatchObject({
      status: 'PUBLISHED',
      attempts: 1,
      locked_at: null,
      locked_by: null,
      last_error: null,
    });
    const job = await jobOf(id, DeliveryAction.BROADCAST_SEATS);
    expect(job?.name).toBe(DeliveryAction.BROADCAST_SEATS);
    expect(job?.data).toEqual({
      eventId: id,
      type: OutboxEventType.SEATS_RELEASED,
      aggregateId: A_BOOKING,
      payload: seatsReleased([A_SEAT]),
    });
  });

  it('never claims a published event again', async () => {
    await event();
    await relay.pollOnce();

    expect((await relay.pollOnce()).claimed).toBe(0);
  });

  it('leaves an event that is not due yet alone', async () => {
    const id = await event({ nextRetryAt: new Date(clock.now().getTime() + 60_000) });

    expect((await relay.pollOnce()).claimed).toBe(0);

    expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('leaves an event type this build cannot deliver PENDING instead of dropping it', async () => {
    const id = await event({ type: OutboxEventType.BOOKING_CONFIRMED });

    expect((await relay.pollOnce()).claimed).toBe(0);

    expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('two rounds running at once never claim the same event (SKIP LOCKED)', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => event()));

    const [first, second] = await Promise.all([relay.pollOnce(), relay.pollOnce()]);

    expect(first.claimed + second.claimed).toBe(ids.length);
    for (const id of ids) {
      expect(await rowOf(id)).toMatchObject({ status: 'PUBLISHED', attempts: 1 });
    }
  });

  it('claims at most one batch per round', async () => {
    await db.prisma.outboxEvent.createMany({
      data: Array.from({ length: OUTBOX_BATCH_SIZE + 3 }, () => ({
        type: OutboxEventType.SEATS_RELEASED,
        aggregateId: A_BOOKING,
        payload: seatsReleased([A_SEAT]),
        nextRetryAt: clock.now(),
      })),
    });

    expect((await relay.pollOnce()).claimed).toBe(OUTBOX_BATCH_SIZE);
    expect((await relay.pollOnce()).claimed).toBe(3);
  });

  it('records the failure and tries again later when the queue refuses the event', async () => {
    const id = await event();
    jest.spyOn(producer, 'enqueue').mockRejectedValue(new Error('Redis did not answer'));
    quiet('warn');

    const report = await relay.pollOnce();

    expect(report).toMatchObject({ claimed: 1, published: 0, retried: 1 });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, locked_at: null, locked_by: null });
    expect(row.last_error).toBe('Redis did not answer');
    // 2 s of backoff after the first attempt, so the next round leaves it alone.
    expect(row.next_retry_at.getTime()).toBe(clock.now().getTime() + 2_000);
    expect((await relay.pollOnce()).claimed).toBe(0);
  });

  it('gives up on an event that has used up its attempts', async () => {
    const id = await event({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    jest.spyOn(producer, 'enqueue').mockRejectedValue(new Error('Redis down for good'));
    quiet('error');

    expect((await relay.pollOnce()).failed).toBe(1);

    expect(await rowOf(id)).toMatchObject({
      status: 'FAILED',
      attempts: OUTBOX_MAX_ATTEMPTS,
      last_error: 'Redis down for good',
    });
  });

  it('puts a claim back when the worker that took it never returned (scenario D)', async () => {
    const stale = new Date(clock.now().getTime() - OUTBOX_STALE_CLAIM_MS - 1_000);
    const id = await event({ status: 'PROCESSING', lockedAt: stale, attempts: 1 });
    quiet('warn');

    const report = await relay.pollOnce();

    expect(report).toMatchObject({ reclaimed: 1, claimed: 1, published: 1 });
    expect(await rowOf(id)).toMatchObject({ status: 'PUBLISHED', attempts: 2 });
    expect(await jobOf(id, DeliveryAction.BROADCAST_SEATS)).toBeDefined();
  });

  it('leaves a fresh claim to the worker holding it', async () => {
    const id = await event({ status: 'PROCESSING', lockedAt: clock.now(), attempts: 1 });

    const report = await relay.pollOnce();

    expect(report).toMatchObject({ reclaimed: 0, claimed: 0 });
    expect(await rowOf(id)).toMatchObject({ status: 'PROCESSING', locked_by: 'dead-worker-1' });
  });

  it('handing the same event over twice adds one job, not two', async () => {
    const id = await event();
    await relay.pollOnce();
    await db.prisma.$executeRaw`
      UPDATE outbox_events SET status = 'PENDING', next_retry_at = ${clock.now()}
      WHERE id = ${id}::uuid`;

    expect((await relay.pollOnce()).published).toBe(1);

    const counts = await producer.queue.getJobCounts('waiting', 'active', 'completed', 'failed');
    expect(counts.waiting).toBe(1);
  });

  it('an expired booking goes all the way: outbox row, job, seat:released', async () => {
    const [user, movie, room] = await Promise.all([
      fixtures.user(),
      fixtures.movie(),
      fixtures.room(),
    ]);
    const seat = await fixtures.seat(room.id, 1);
    const showtime = await fixtures.showtime({
      movieId: movie.id,
      roomId: room.id,
      startsAt: '2026-11-05T13:00:00.000Z',
      endsAt: '2026-11-05T15:00:00.000Z',
    });
    const booking = await db.prisma.booking.create({
      data: {
        code: `BK${randomUUID().slice(0, 8)}`,
        userId: user.id,
        showtimeId: showtime.id,
        subtotal: 90_000,
        total: 90_000,
        expiresAt: new Date('2026-11-05T09:50:00.000Z'),
        holdUntil: new Date('2026-11-05T09:55:00.000Z'),
        idempotencyKey: randomUUID(),
        requestHash: 'hash',
      },
    });
    await db.prisma.showtimeSeat.create({
      data: {
        showtimeId: showtime.id,
        seatId: seat.id,
        status: 'HELD',
        bookingId: booking.id,
        heldUntil: booking.holdUntil,
        price: 90_000,
      },
    });
    await db.prisma.bookingSeat.create({
      data: { bookingId: booking.id, showtimeId: showtime.id, seatId: seat.id, price: 90_000 },
    });

    // The expiry commits the release and the event together, and sends the fast copy itself.
    const outcome = await expiry.expire(booking.id);
    expect(outcome).toMatchObject({ outcome: 'expired', releasedSeatIds: [seat.id] });
    const [written] = await db.prisma.outboxEvent.findMany({ where: { aggregateId: booking.id } });
    expect(written).toMatchObject({ type: OutboxEventType.SEATS_RELEASED, status: 'PENDING' });
    expect(written?.payload).toEqual({
      bookingId: booking.id,
      showtimeId: showtime.id,
      seatIds: [seat.id],
      cause: SeatsReleasedCause.BOOKING_EXPIRED,
    });

    await relay.pollOnce();
    const job = await jobOf(written?.id ?? '', DeliveryAction.BROADCAST_SEATS);
    expect(job).toBeDefined();

    // The durable copy: the same event, rebuilt from the row by the delivery worker.
    seatEvents.sent.length = 0;
    await processor.process(job as Job<DeliveryJobData>);

    expect(seatEvents.sent).toEqual([
      {
        room: `showtime:${showtime.id}`,
        event: 'seat:released',
        payload: { showtimeId: showtime.id, seatIds: [seat.id] },
      },
    ]);
  });
});
