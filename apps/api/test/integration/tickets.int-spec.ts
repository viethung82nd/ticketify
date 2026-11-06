import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role, TICKET_LIMITS, type TicketPdfLink, ticketPdfKey } from '@ticketify/shared';
import type { Job } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { OutboxEventType } from '../../src/infra/outbox/outbox-events';
import { OUTBOX_POLL_INTERVAL_MS, OutboxRelay } from '../../src/infra/outbox/outbox-relay.service';
import {
  DeliveryAction,
  type DeliveryJobData,
  deliveryJobId,
} from '../../src/infra/queue/delivery-queue';
import { DeliveryQueueProducer } from '../../src/infra/queue/delivery-queue.producer';
import { ObjectStorage } from '../../src/infra/storage/object-storage';
import { FakeObjectStorage } from '../../src/infra/storage/testing/fake-object-storage';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { DeliveryProcessor } from '../../src/modules/delivery/delivery.processor';
import { RealtimeTransport } from '../../src/modules/realtime/realtime-transport';
import { RecordingTransport } from '../../src/modules/realtime/testing/recording-transport';
import { readTicketToken } from '../../src/modules/tickets/ticket-token';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

const NOW = '2026-11-05T10:00:00.000Z';
const QR_SECRET = 'integration-test-ticket-qr-secret-0123456789';
const UNKNOWN_ID = '01a3a1aa-0000-7000-8000-000000000000';

describe('Ticket PDF — generate-pdf and GET /bookings/:id/ticket-pdf (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let workerRef: TestingModule;
  let relay: OutboxRelay;
  let producer: DeliveryQueueProducer;
  let processor: DeliveryProcessor;
  let storage: FakeObjectStorage;
  let fixtures: Fixtures;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    fixtures = createFixtures(db.prisma);
    // One in-memory store shared by the API and the worker, as RustFS is in production.
    storage = new FakeObjectStorage();

    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();

    const { WorkerModule } = await import('../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(OUTBOX_POLL_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(RealtimeTransport)
      .useValue(new RecordingTransport())
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .compile();
    relay = workerRef.get(OutboxRelay);
    producer = workerRef.get(DeliveryQueueProducer);
    processor = workerRef.get(DeliveryProcessor);
  });

  afterAll(async () => {
    await workerRef?.close();
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(async () => {
    clock.set(NOW);
    storage.objects.clear();
    storage.bodies.clear();
    storage.puts.length = 0;
    storage.down = false;
    await db.prisma.outboxEvent.deleteMany();
    await producer.queue.obliterate({ force: true });
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const tokenOf = (id: string) => app.get(AccessTokenIssuer).issue({ id, role: Role.USER }).token;

  async function newUser(): Promise<{ id: string; token: string }> {
    const user = await fixtures.user();
    return { id: user.id, token: tokenOf(user.id) };
  }

  /** A booking of `status`, with `seats` seats and a ticket per seat when CONFIRMED. */
  async function scene(
    userId: string,
    status: 'CONFIRMED' | 'PENDING' | 'NEEDS_REVIEW' = 'CONFIRMED',
    seatCount = 2,
  ) {
    const [movie, room] = await Promise.all([fixtures.movie(), fixtures.room()]);
    const seats = await Promise.all(
      Array.from({ length: seatCount }, (_, index) => fixtures.seat(room.id, index + 1)),
    );
    const showtime = await fixtures.showtime({
      movieId: movie.id,
      roomId: room.id,
      startsAt: '2026-11-05T12:30:00.000Z',
      endsAt: '2026-11-05T14:30:00.000Z',
    });
    const booking = await db.prisma.booking.create({
      data: {
        code: `BK${randomUUID().slice(0, 8).toUpperCase()}`,
        userId,
        showtimeId: showtime.id,
        status,
        subtotal: 90_000 * seatCount,
        total: 90_000 * seatCount,
        expiresAt: new Date('2026-11-05T09:50:00.000Z'),
        holdUntil: new Date('2026-11-05T09:55:00.000Z'),
        confirmedAt: status === 'CONFIRMED' ? clock.now() : null,
        idempotencyKey: randomUUID(),
        requestHash: 'hash',
      },
    });
    for (const seat of seats) {
      await db.prisma.showtimeSeat.create({
        data: {
          showtimeId: showtime.id,
          seatId: seat.id,
          status: status === 'CONFIRMED' ? 'SOLD' : 'HELD',
          bookingId: booking.id,
          // A HELD seat must say until when (CHECK showtime_seats_held_check).
          heldUntil: status === 'CONFIRMED' ? null : booking.holdUntil,
          price: 90_000,
        },
      });
      await db.prisma.bookingSeat.create({
        data: { bookingId: booking.id, showtimeId: showtime.id, seatId: seat.id, price: 90_000 },
      });
    }
    const payment = await db.prisma.payment.create({
      data: {
        bookingId: booking.id,
        txnRef: randomUUID().replaceAll('-', '').slice(0, 20),
        amount: booking.total,
        status: status === 'PENDING' ? 'PENDING' : 'SUCCESS',
      },
    });
    const tickets =
      status === 'CONFIRMED'
        ? await Promise.all(
            seats.map((seat) =>
              db.prisma.ticket.create({
                data: {
                  bookingId: booking.id,
                  showtimeId: showtime.id,
                  seatId: seat.id,
                  code: randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
                },
              }),
            ),
          )
        : [];
    return { booking, showtime, seats, payment, tickets };
  }

  /** Writes `booking.confirmed`, relays it, and runs the `generate-pdf` job it produced. */
  async function generatePdf(current: Awaited<ReturnType<typeof scene>>, userId: string) {
    const event = await db.prisma.outboxEvent.create({
      data: {
        type: OutboxEventType.BOOKING_CONFIRMED,
        aggregateId: current.booking.id,
        payload: {
          bookingId: current.booking.id,
          bookingCode: current.booking.code,
          userId,
          showtimeId: current.showtime.id,
          paymentId: current.payment.id,
          seatIds: current.seats.map((seat) => seat.id),
          ticketIds: current.tickets.map((ticket) => ticket.id),
          reclaimed: false,
        },
        nextRetryAt: clock.now(),
      },
      select: { id: true },
    });
    await relay.pollOnce();
    const job = await producer.queue.getJob(deliveryJobId(event.id, DeliveryAction.GENERATE_PDF));
    expect(job).toBeDefined();
    await processor.process(job as Job<DeliveryJobData>);
    return event.id;
  }

  const download = (token: string, bookingId: string) =>
    http().get(`/bookings/${bookingId}/ticket-pdf`).set('Authorization', `Bearer ${token}`);

  // ─── generate-pdf ───

  describe('generate-pdf', () => {
    it('writes one PDF at tickets/{bookingId}.pdf with a QR per ticket', async () => {
      const user = await newUser();
      const current = await scene(user.id);

      await generatePdf(current, user.id);

      const key = ticketPdfKey(current.booking.id);
      expect(storage.puts.map((put) => put.key)).toEqual([key]);
      expect(storage.puts[0]?.contentType).toBe('application/pdf');
      const pdf = storage.bodies.get(key);
      expect(pdf?.subarray(0, 5).toString()).toBe('%PDF-');
      // One page per ticket.
      expect((pdf?.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(2);
    });

    it('signs each QR token with TICKET_QR_SECRET, so check-in can verify it', async () => {
      const user = await newUser();
      const current = await scene(user.id, 'CONFIRMED', 1);
      const code = current.tickets[0]!.code;

      await generatePdf(current, user.id);

      // The same token the PDF drew; what matters is that this secret validates it.
      const { ticketToken } = await import('../../src/modules/tickets/ticket-token.js');
      expect(readTicketToken(ticketToken(code, QR_SECRET), QR_SECRET)).toBe(code);
      expect(
        readTicketToken(ticketToken(code, 'another-secret-0123456789abcdefgh'), QR_SECRET),
      ).toBeNull();
    });

    it('running the job twice leaves one object with the same bytes', async () => {
      const user = await newUser();
      const current = await scene(user.id);
      const eventId = await generatePdf(current, user.id);
      const key = ticketPdfKey(current.booking.id);
      const first = storage.bodies.get(key);

      const job = await producer.queue.getJob(deliveryJobId(eventId, DeliveryAction.GENERATE_PDF));
      await processor.process(job as Job<DeliveryJobData>);

      expect(storage.puts).toHaveLength(2);
      expect([...storage.bodies.keys()]).toEqual([key]);
      expect(storage.bodies.get(key)?.equals(first!)).toBe(true);
    });

    it('fails the job when the store is unreachable, leaving nothing behind', async () => {
      const user = await newUser();
      const current = await scene(user.id);
      storage.down = true;

      const event = await db.prisma.outboxEvent.create({
        data: {
          type: OutboxEventType.BOOKING_CONFIRMED,
          aggregateId: current.booking.id,
          payload: {
            bookingId: current.booking.id,
            bookingCode: current.booking.code,
            userId: user.id,
            showtimeId: current.showtime.id,
            paymentId: current.payment.id,
            seatIds: current.seats.map((seat) => seat.id),
            ticketIds: current.tickets.map((ticket) => ticket.id),
            reclaimed: false,
          },
          nextRetryAt: clock.now(),
        },
        select: { id: true },
      });
      await relay.pollOnce();
      const job = await producer.queue.getJob(deliveryJobId(event.id, DeliveryAction.GENERATE_PDF));

      await expect(processor.process(job as Job<DeliveryJobData>)).rejects.toThrow(
        /storage PUT failed/i,
      );
      expect(storage.bodies.size).toBe(0);
    });
  });

  // ─── GET /bookings/:id/ticket-pdf ───

  describe('GET /bookings/:id/ticket-pdf', () => {
    it('answers with a short-lived presigned link once the file is there', async () => {
      const user = await newUser();
      const current = await scene(user.id);
      await generatePdf(current, user.id);

      const res = await download(user.token, current.booking.id);

      expect(res.status).toBe(200);
      const link = bodyOf<TicketPdfLink>(res);
      expect(link.expiresIn).toBe(TICKET_LIMITS.pdfUrlTtlSeconds);
      expect(link.url).toContain(ticketPdfKey(current.booking.id));
    });

    it('409 TICKET_PDF_NOT_READY while the worker has not uploaded it', async () => {
      const user = await newUser();
      const current = await scene(user.id);

      const res = await download(user.token, current.booking.id);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('TICKET_PDF_NOT_READY');
    });

    it.each([['PENDING'], ['NEEDS_REVIEW']] as const)(
      '409 BOOKING_NOT_CONFIRMED for a %s booking',
      async (status) => {
        const user = await newUser();
        const current = await scene(user.id, status);

        const res = await download(user.token, current.booking.id);

        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('BOOKING_NOT_CONFIRMED');
      },
    );

    it("404 BOOKING_NOT_FOUND for another user's booking, never 403", async () => {
      const [owner, stranger] = await Promise.all([newUser(), newUser()]);
      const current = await scene(owner.id);
      await generatePdf(current, owner.id);

      const res = await download(stranger.token, current.booking.id);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
    });

    it('404 for an unknown booking, 400 for an id that is not a UUID, 401 without a token', async () => {
      const user = await newUser();

      expect((await download(user.token, UNKNOWN_ID)).status).toBe(404);
      expect((await download(user.token, 'not-a-uuid')).status).toBe(400);
      expect((await http().get(`/bookings/${UNKNOWN_ID}/ticket-pdf`)).status).toBe(401);
    });

    it('503 STORAGE_UNAVAILABLE when the store cannot be reached, with no SDK details', async () => {
      const user = await newUser();
      const current = await scene(user.id);
      await generatePdf(current, user.id);
      storage.down = true;

      const res = await download(user.token, current.booking.id);

      expect(res.status).toBe(503);
      const error = errorOf(res);
      expect(error.code).toBe('STORAGE_UNAVAILABLE');
      expect(JSON.stringify(error)).not.toMatch(/S3|aws|bucket/i);
    });
  });
});
