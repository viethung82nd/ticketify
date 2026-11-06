import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
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
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { DeliveryProcessor } from '../../src/modules/delivery/delivery.processor';
import { RealtimeTransport } from '../../src/modules/realtime/realtime-transport';
import { RecordingTransport } from '../../src/modules/realtime/testing/recording-transport';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createFixtures, type Fixtures } from '../support/fixtures';
import { createTestRedis, type TestRedis } from '../support/redis';
import { EXTERNAL_SMTP_ENV, MAILPIT_IMAGE } from '../support/test-env';

const NOW = '2026-11-05T10:00:00.000Z';
const WEB_ORIGIN = 'http://localhost:5173';

/** What Mailpit's API tells us about one stored message. */
interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Attachments: number;
}

interface MailpitPart {
  PartID: string;
  FileName: string;
  ContentType: string;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
  Attachments: MailpitPart[];
}

/**
 * The confirmation and apology emails, sent through a real SMTP server (Mailpit, the same image
 * as docker-compose) and read back out of it — including the PDF attachment, byte for byte.
 *
 * Uses a Mailpit container, or an already running one when TEST_SMTP_HOST / TEST_MAILPIT_API_URL
 * are set.
 */
describe('Ticket emails (real SMTP: Mailpit)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let mailpit: StartedTestContainer | undefined;
  let workerRef: TestingModule;
  let relay: OutboxRelay;
  let producer: DeliveryQueueProducer;
  let processor: DeliveryProcessor;
  let storage: FakeObjectStorage;
  let fixtures: Fixtures;
  let apiUrl: string;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    const externalHost = process.env[EXTERNAL_SMTP_ENV.host];
    const [database, testRedis, container] = await Promise.all([
      createTestDatabase(),
      createTestRedis(),
      externalHost
        ? Promise.resolve(undefined)
        : new GenericContainer(MAILPIT_IMAGE)
            .withExposedPorts(1025, 8025)
            .withWaitStrategy(Wait.forHttp('/readyz', 8025).forStatusCode(200))
            .start(),
    ]);
    [db, redis, mailpit] = [database, testRedis, container];
    const host = externalHost ?? container!.getHost();
    const smtpPort = externalHost
      ? Number(process.env[EXTERNAL_SMTP_ENV.port] ?? '1025')
      : container!.getMappedPort(1025);
    apiUrl =
      process.env[EXTERNAL_SMTP_ENV.apiUrl] ??
      `http://${container!.getHost()}:${container!.getMappedPort(8025)}`;

    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          SMTP_HOST: host,
          SMTP_PORT: String(smtpPort),
          SMTP_FROM: 'Ticketify <no-reply@ticketify.test>',
          CORS_ORIGINS: WEB_ORIGIN,
        },
      ),
    );
    fixtures = createFixtures(db.prisma);
    storage = new FakeObjectStorage();

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
  }, 180_000);

  afterAll(async () => {
    await workerRef?.close();
    await mailpit?.stop();
    await Promise.all([db?.drop(), redis?.close()]);
  }, 60_000);

  beforeEach(async () => {
    clock.set(NOW);
    storage.bodies.clear();
    storage.objects.clear();
    storage.puts.length = 0;
    storage.down = false;
    await db.prisma.outboxEvent.deleteMany();
    await producer.queue.obliterate({ force: true });
    await fetch(`${apiUrl}/api/v1/messages`, { method: 'DELETE' });
  });

  // ─── Mailpit helpers ───

  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function messages(): Promise<MailpitSummary[]> {
    const res = await fetch(`${apiUrl}/api/v1/messages?limit=50`);
    const body = (await res.json()) as { messages: MailpitSummary[] };
    return body.messages;
  }

  /** Mailpit stores a message a moment after SMTP accepted it. */
  async function waitForMessages(count: number): Promise<MailpitSummary[]> {
    for (let waited = 0; waited < 10_000; waited += 100) {
      const found = await messages();
      if (found.length >= count) return found;
      await pause(100);
    }
    throw new Error(`Expected ${count} message(s) in Mailpit, found ${(await messages()).length}`);
  }

  async function message(id: string): Promise<MailpitMessage> {
    const res = await fetch(`${apiUrl}/api/v1/message/${id}`);
    return (await res.json()) as MailpitMessage;
  }

  async function attachment(id: string, partId: string): Promise<Buffer> {
    const res = await fetch(`${apiUrl}/api/v1/message/${id}/part/${partId}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ─── Scene ───

  async function confirmedBooking(status: 'CONFIRMED' | 'NEEDS_REVIEW' = 'CONFIRMED') {
    const [user, movie, room] = await Promise.all([
      db.prisma.user.create({
        data: {
          email: `khach-${randomUUID().slice(0, 8)}@test.local`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Nguyễn Thị Hồng Nhung',
        },
      }),
      db.prisma.movie.create({
        data: {
          title: 'Mắt Biếc — Người Đẹp Và Thủy Quái',
          slug: `mat-biec-${randomUUID().slice(0, 8)}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: new Date('2026-10-01'),
        },
      }),
      fixtures.room(),
    ]);
    const seats = await Promise.all([fixtures.seat(room.id, 1), fixtures.seat(room.id, 2)]);
    const showtime = await fixtures.showtime({
      movieId: movie.id,
      roomId: room.id,
      // 19:30 in Vietnam.
      startsAt: '2026-11-05T12:30:00.000Z',
      endsAt: '2026-11-05T14:30:00.000Z',
    });
    const booking = await db.prisma.booking.create({
      data: {
        code: `BK${randomUUID().slice(0, 8).toUpperCase()}`,
        userId: user.id,
        showtimeId: showtime.id,
        status,
        subtotal: 180_000,
        total: 180_000,
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
          status: status === 'CONFIRMED' ? 'SOLD' : 'AVAILABLE',
          bookingId: status === 'CONFIRMED' ? booking.id : null,
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
        status: 'SUCCESS',
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
    return { user, booking, showtime, seats, payment, tickets };
  }

  type Scene = Awaited<ReturnType<typeof confirmedBooking>>;

  const confirmedPayload = (scene: Scene) => ({
    bookingId: scene.booking.id,
    bookingCode: scene.booking.code,
    userId: scene.user.id,
    showtimeId: scene.showtime.id,
    paymentId: scene.payment.id,
    seatIds: scene.seats.map((seat) => seat.id),
    ticketIds: scene.tickets.map((ticket) => ticket.id),
    reclaimed: false,
  });

  const reviewPayload = (scene: Scene) => ({
    bookingId: scene.booking.id,
    bookingCode: scene.booking.code,
    userId: scene.user.id,
    showtimeId: scene.showtime.id,
    paymentId: scene.payment.id,
    amount: scene.booking.total,
    vnpTransactionNo: '14226112',
    reason: 'SEAT_SOLD',
    seatIds: scene.seats.map((seat) => seat.id),
    releasedSeatIds: [],
  });

  /** Writes the event, relays it, and runs one of the jobs it produced. */
  async function run(type: OutboxEventType, aggregateId: string, payload: object) {
    const event = await db.prisma.outboxEvent.create({
      data: { type, aggregateId, payload: payload as never, nextRetryAt: clock.now() },
      select: { id: true },
    });
    await relay.pollOnce();
    return {
      eventId: event.id,
      async job(action: DeliveryAction): Promise<void> {
        const found = await producer.queue.getJob(deliveryJobId(event.id, action));
        expect(found).toBeDefined();
        await processor.process(found as Job<DeliveryJobData>);
      },
    };
  }

  const emailSentAt = async (bookingId: string): Promise<Date | null> =>
    (
      await db.prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { emailSentAt: true },
      })
    ).emailSentAt;

  // ─── Tests ───

  it('booking.confirmed: the PDF is uploaded, then emailed, and the booking is marked', async () => {
    const scene = await confirmedBooking();
    const delivery = await run(
      OutboxEventType.BOOKING_CONFIRMED,
      scene.booking.id,
      confirmedPayload(scene),
    );

    // generate-pdf uploads and enqueues send-email itself.
    await delivery.job(DeliveryAction.GENERATE_PDF);
    await delivery.job(DeliveryAction.SEND_EMAIL);

    const [summary] = await waitForMessages(1);
    expect(summary?.To.map((to) => to.Address)).toEqual([scene.user.email]);
    expect(summary?.Subject).toBe(
      `Vé của bạn — Mắt Biếc — Người Đẹp Và Thủy Quái (đơn ${scene.booking.code})`,
    );
    expect(summary?.Attachments).toBe(1);

    const full = await message(summary!.ID);
    expect(full.HTML).toContain('19:30 ngày 05/11/2026');
    expect(full.HTML).toContain(`${WEB_ORIGIN}/bookings/${scene.booking.id}`);
    expect(full.Text).toContain('Ghế: A1, A2');
    expect(full.Text).toContain('180.000 đ');

    const part = full.Attachments[0]!;
    expect(part.FileName).toBe(`ticketify-${scene.booking.code}.pdf`);
    expect(part.ContentType).toBe('application/pdf');
    const attached = await attachment(full.ID, part.PartID);
    expect(attached.equals(storage.bodies.get(`tickets/${scene.booking.id}.pdf`)!)).toBe(true);

    expect(await emailSentAt(scene.booking.id)).toEqual(new Date(NOW));
  });

  it('running send-email again sends nothing: emailSentAt is the guard', async () => {
    const scene = await confirmedBooking();
    const delivery = await run(
      OutboxEventType.BOOKING_CONFIRMED,
      scene.booking.id,
      confirmedPayload(scene),
    );
    await delivery.job(DeliveryAction.GENERATE_PDF);
    await delivery.job(DeliveryAction.SEND_EMAIL);
    await waitForMessages(1);

    clock.advance({ minutes: 5 });
    await delivery.job(DeliveryAction.SEND_EMAIL);

    await pause(500);
    expect(await messages()).toHaveLength(1);
    // Unchanged: the first send is the one on record.
    expect(await emailSentAt(scene.booking.id)).toEqual(new Date(NOW));
  });

  it('booking.needs_review: an apology with no attachment', async () => {
    const scene = await confirmedBooking('NEEDS_REVIEW');
    const delivery = await run(
      OutboxEventType.BOOKING_NEEDS_REVIEW,
      scene.booking.id,
      reviewPayload(scene),
    );

    await delivery.job(DeliveryAction.SEND_EMAIL);

    const [summary] = await waitForMessages(1);
    expect(summary?.Subject).toBe(
      `Đơn ${scene.booking.code} cần được xem lại — chúng tôi sẽ hoàn tiền`,
    );
    expect(summary?.Attachments).toBe(0);
    const full = await message(summary!.ID);
    expect(full.HTML).toContain('có ghế đã được bán cho đơn khác');
    expect(full.Text).toContain('180.000 đ');
    expect(await emailSentAt(scene.booking.id)).toEqual(new Date(NOW));
  });

  it('an SMTP failure leaves emailSentAt null, so the retry still sends it', async () => {
    const scene = await confirmedBooking();
    const delivery = await run(
      OutboxEventType.BOOKING_CONFIRMED,
      scene.booking.id,
      confirmedPayload(scene),
    );
    await delivery.job(DeliveryAction.GENERATE_PDF);
    const mailer = workerRef.get<{ send: (message: unknown) => Promise<void> }>(
      (await import('../../src/infra/mailer/mailer.js')).Mailer,
    );
    const failing = jest
      .spyOn(mailer, 'send')
      .mockRejectedValueOnce(new Error('SMTP went away mid-send'));

    await expect(delivery.job(DeliveryAction.SEND_EMAIL)).rejects.toThrow(/SMTP went away/);
    expect(await emailSentAt(scene.booking.id)).toBeNull();
    expect(await messages()).toHaveLength(0);

    failing.mockRestore();
    await delivery.job(DeliveryAction.SEND_EMAIL);

    expect(await waitForMessages(1)).toHaveLength(1);
    expect(await emailSentAt(scene.booking.id)).toEqual(new Date(NOW));
  });
});
