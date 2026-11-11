import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type Notification,
  type NotificationPage,
  NotificationType,
  Role,
  userRoom,
} from '@ticketify/shared';
import type { Job } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { OutboxEventType } from '../../../src/infra/outbox/outbox-events';
import {
  OUTBOX_POLL_INTERVAL_MS,
  OutboxRelay,
} from '../../../src/infra/outbox/outbox-relay.service';
import {
  DeliveryAction,
  type DeliveryJobData,
  deliveryJobId,
} from '../../../src/infra/queue/delivery-queue';
import { DeliveryQueueProducer } from '../../../src/infra/queue/delivery-queue.producer';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../../src/modules/bookings/booking-expiry.processor';
import { DeliveryProcessor } from '../../../src/modules/delivery/delivery.processor';
import { RealtimeTransport } from '../../../src/modules/realtime/realtime-transport';
import { RecordingTransport } from '../../../src/modules/realtime/testing/recording-transport';
import { appTestEnv } from '../../support/app-env';
import { accessTokenFor } from '../../support/auth';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { createFixtures, type Fixtures } from '../../support/fixtures';
import { bodyOf, errorOf } from '../../support/http';
import { createTestRedis, type TestRedis } from '../../support/redis';

const NOW = '2026-11-05T10:00:00.000Z';
const UNKNOWN_ID = '01a3a1aa-0000-7000-8000-000000000000';

describe('Notifications — delivery, list and read (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let workerRef: TestingModule;
  let relay: OutboxRelay;
  let producer: DeliveryQueueProducer;
  let processor: DeliveryProcessor;
  let transport: RecordingTransport;
  let fixtures: Fixtures;
  let adminId: string;
  let adminToken: string;
  const clock = new FakeClock(NOW);

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(process.env, appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }));
    fixtures = createFixtures(db.prisma);

    const { AppModule } = await import('../../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
    const admin = await db.prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN } });
    adminId = admin.id;

    transport = new RecordingTransport();
    const { WorkerModule } = await import('../../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(OUTBOX_POLL_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(RealtimeTransport)
      .useValue(transport)
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
    transport.clear();
    await db.prisma.notification.deleteMany();
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

  /** A CONFIRMED booking with one ticket, the way an IPN leaves it. */
  async function confirmedBooking(userId: string) {
    const [movie, room] = await Promise.all([fixtures.movie(), fixtures.room()]);
    const seat = await fixtures.seat(room.id, 1);
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
        userId,
        showtimeId: showtime.id,
        status: 'CONFIRMED',
        subtotal: 90_000,
        total: 90_000,
        expiresAt: new Date('2026-11-05T09:50:00.000Z'),
        holdUntil: new Date('2026-11-05T09:55:00.000Z'),
        confirmedAt: clock.now(),
        idempotencyKey: randomUUID(),
        requestHash: 'hash',
      },
    });
    await db.prisma.showtimeSeat.create({
      data: {
        showtimeId: showtime.id,
        seatId: seat.id,
        status: 'SOLD',
        bookingId: booking.id,
        price: 90_000,
      },
    });
    await db.prisma.bookingSeat.create({
      data: { bookingId: booking.id, showtimeId: showtime.id, seatId: seat.id, price: 90_000 },
    });
    const payment = await db.prisma.payment.create({
      data: {
        bookingId: booking.id,
        txnRef: randomUUID().replaceAll('-', '').slice(0, 20),
        amount: 90_000,
        status: 'SUCCESS',
      },
    });
    const ticket = await db.prisma.ticket.create({
      data: {
        bookingId: booking.id,
        showtimeId: showtime.id,
        seatId: seat.id,
        code: randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
      },
    });
    return { booking, showtime, seat, payment, ticket, movieTitle: movie.title, room };
  }

  /** Writes one outbox event, relays it, and runs the jobs it produced. */
  async function deliver(type: OutboxEventType, aggregateId: string, payload: object) {
    const event = await db.prisma.outboxEvent.create({
      data: { type, aggregateId, payload: payload as never, nextRetryAt: clock.now() },
      select: { id: true },
    });
    await relay.pollOnce();
    const job = await producer.queue.getJob(deliveryJobId(event.id, DeliveryAction.NOTIFY));
    expect(job).toBeDefined();
    await processor.process(job as Job<DeliveryJobData>);
    return event.id;
  }

  const confirmedPayload = (
    scene: Awaited<ReturnType<typeof confirmedBooking>>,
    userId: string,
  ) => ({
    bookingId: scene.booking.id,
    bookingCode: scene.booking.code,
    userId,
    showtimeId: scene.showtime.id,
    paymentId: scene.payment.id,
    seatIds: [scene.seat.id],
    ticketIds: [scene.ticket.id],
    reclaimed: false,
  });

  const list = (token: string, query = '') =>
    http().get(`/me/notifications${query}`).set('Authorization', `Bearer ${token}`);

  // ─── Delivery ───

  it('booking.confirmed stores one notification for the user and pushes it to user:{id}', async () => {
    const user = await newUser();
    const scene = await confirmedBooking(user.id);

    const eventId = await deliver(
      OutboxEventType.BOOKING_CONFIRMED,
      scene.booking.id,
      confirmedPayload(scene, user.id),
    );

    const stored = await db.prisma.notification.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      userId: user.id,
      type: NotificationType.BOOKING_CONFIRMED,
      eventId,
      readAt: null,
    });
    expect(stored[0]?.title).toBe(`Đơn ${scene.booking.code} đã được xác nhận`);
    expect(stored[0]?.body).toContain('19:30 ngày 05/11/2026');
    expect(transport.sent).toEqual([
      {
        room: userRoom(user.id),
        event: 'notification:new',
        payload: expect.objectContaining({ id: stored[0]?.id, readAt: null }) as unknown,
      },
    ]);
    // No user id leaves the server: the room already says whose it is.
    expect(transport.sent[0]?.payload).not.toHaveProperty('userId');
  });

  it('running the same notify job twice stores one row and pushes once', async () => {
    const user = await newUser();
    const scene = await confirmedBooking(user.id);
    const eventId = await deliver(
      OutboxEventType.BOOKING_CONFIRMED,
      scene.booking.id,
      confirmedPayload(scene, user.id),
    );
    transport.clear();

    const job = await producer.queue.getJob(deliveryJobId(eventId, DeliveryAction.NOTIFY));
    await processor.process(job as Job<DeliveryJobData>);

    expect(await db.prisma.notification.count()).toBe(1);
    expect(transport.sent).toEqual([]);
  });

  it('booking.needs_review tells the user and every admin, in different words', async () => {
    const user = await newUser();
    const scene = await confirmedBooking(user.id);

    await deliver(OutboxEventType.BOOKING_NEEDS_REVIEW, scene.booking.id, {
      bookingId: scene.booking.id,
      bookingCode: scene.booking.code,
      userId: user.id,
      showtimeId: scene.showtime.id,
      paymentId: scene.payment.id,
      amount: 90_000,
      vnpTransactionNo: '14226112',
      reason: 'SEAT_SOLD',
      seatIds: [scene.seat.id],
      releasedSeatIds: [],
    });

    const stored = await db.prisma.notification.findMany({ orderBy: { userId: 'asc' } });
    const byUser = new Map(stored.map((row) => [row.userId, row]));
    expect(byUser.get(user.id)?.title).toBe(`Đơn ${scene.booking.code} cần được xem lại`);
    expect(byUser.get(user.id)?.body).toContain('90.000 đ');
    expect(byUser.get(adminId)?.title).toContain('Cần xử lý tay');
    expect(byUser.get(adminId)?.body).toContain('14226112');
    expect(stored).toHaveLength(2);
    expect(transport.sent.map((event) => event.room).sort()).toEqual(
      [userRoom(user.id), userRoom(adminId)].sort(),
    );
  });

  it('payment.refund_required goes to admins only, never to the user', async () => {
    const user = await newUser();
    const scene = await confirmedBooking(user.id);

    await deliver(OutboxEventType.PAYMENT_REFUND_REQUIRED, scene.payment.id, {
      paymentId: scene.payment.id,
      txnRef: scene.payment.txnRef,
      bookingId: scene.booking.id,
      bookingCode: scene.booking.code,
      userId: user.id,
      amount: 90_000,
      vnpTransactionNo: '14226112',
      paidPaymentId: scene.payment.id,
    });

    const stored = await db.prisma.notification.findMany();
    expect(stored.map((row) => row.userId)).toEqual([adminId]);
    expect(stored[0]?.type).toBe(NotificationType.PAYMENT_REFUND_REQUIRED);
    expect(transport.sent.map((event) => event.room)).toEqual([userRoom(adminId)]);
  });

  // ─── GET /me/notifications ───

  describe('GET /me/notifications', () => {
    /** Three notifications of one user, the middle one already read. */
    async function seed(userId: string) {
      for (const [index, title] of ['one', 'two', 'three'].entries()) {
        await db.prisma.notification.create({
          data: {
            userId,
            type: NotificationType.BOOKING_CONFIRMED,
            title,
            body: `body ${title}`,
            data: { index },
            readAt: title === 'two' ? new Date(NOW) : null,
            createdAt: new Date(Date.parse(NOW) + index * 1_000),
          },
        });
      }
    }

    it('newest first, with the unread count of the whole list', async () => {
      const user = await newUser();
      await seed(user.id);

      const res = await list(user.token);

      expect(res.status).toBe(200);
      const page = bodyOf<NotificationPage>(res);
      expect(page.items.map((item) => item.title)).toEqual(['three', 'two', 'one']);
      expect(page).toMatchObject({ total: 3, page: 1, pageSize: 20, unreadCount: 2 });
      expect(page.items[0]).toEqual({
        id: expect.any(String) as unknown,
        type: NotificationType.BOOKING_CONFIRMED,
        title: 'three',
        body: 'body three',
        data: { index: 2 },
        readAt: null,
        createdAt: '2026-11-05T10:00:02.000Z',
      });
    });

    it('?unread=true leaves the read ones out but still counts them', async () => {
      const user = await newUser();
      await seed(user.id);

      const page = bodyOf<NotificationPage>(await list(user.token, '?unread=true'));

      expect(page.items.map((item) => item.title)).toEqual(['three', 'one']);
      expect(page).toMatchObject({ total: 2, unreadCount: 2 });
    });

    it('pages without losing the unread count', async () => {
      const user = await newUser();
      await seed(user.id);

      const page = bodyOf<NotificationPage>(await list(user.token, '?page=2&pageSize=2'));

      expect(page.items.map((item) => item.title)).toEqual(['one']);
      expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2, unreadCount: 2 });
    });

    it("never shows another user's notifications", async () => {
      const [mine, theirs] = await Promise.all([newUser(), newUser()]);
      await seed(theirs.id);

      const page = bodyOf<NotificationPage>(await list(mine.token));

      expect(page).toMatchObject({ items: [], total: 0, unreadCount: 0 });
    });

    it.each([
      ['pageSize above the maximum', '?pageSize=51'],
      ['page 0', '?page=0'],
      ['unread as a number', '?unread=2'],
    ])('400 VALIDATION_FAILED: %s', async (_label, query) => {
      const user = await newUser();

      const res = await list(user.token, query);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('401 without a token', async () => {
      expect((await http().get('/me/notifications')).status).toBe(401);
    });
  });

  // ─── Marking as read ───

  describe('marking as read', () => {
    const create = (userId: string, readAt: Date | null = null) =>
      db.prisma.notification.create({
        data: {
          userId,
          type: NotificationType.BOOKING_CONFIRMED,
          title: 'Đơn BK1 đã được xác nhận',
          body: 'body',
          readAt,
        },
      });

    const read = (token: string, path: string) =>
      http().post(path).set('Authorization', `Bearer ${token}`);

    it('marks one read and answers with it', async () => {
      const user = await newUser();
      const row = await create(user.id);

      const res = await read(user.token, `/me/notifications/${row.id}/read`);

      expect(res.status).toBe(201);
      expect(bodyOf<Notification>(res)).toMatchObject({ id: row.id, readAt: NOW });
      expect(
        (await db.prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt,
      ).toEqual(new Date(NOW));
    });

    it('marking an already read one again changes nothing and still answers with it', async () => {
      const user = await newUser();
      const row = await create(user.id, new Date('2026-11-05T09:00:00.000Z'));

      const res = await read(user.token, `/me/notifications/${row.id}/read`);

      expect(res.status).toBe(201);
      expect(bodyOf<Notification>(res).readAt).toBe('2026-11-05T09:00:00.000Z');
    });

    it("404 NOTIFICATION_NOT_FOUND for another user's notification, never 403", async () => {
      const [mine, theirs] = await Promise.all([newUser(), newUser()]);
      const row = await create(theirs.id);

      const res = await read(mine.token, `/me/notifications/${row.id}/read`);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('NOTIFICATION_NOT_FOUND');
      expect(
        (await db.prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt,
      ).toBeNull();
    });

    it('404 for an id that does not exist, 400 for an id that is not a UUID', async () => {
      const user = await newUser();

      expect((await read(user.token, `/me/notifications/${UNKNOWN_ID}/read`)).status).toBe(404);
      expect((await read(user.token, '/me/notifications/not-a-uuid/read')).status).toBe(400);
    });

    it('POST /me/notifications/read marks every unread one of the user', async () => {
      const [mine, theirs] = await Promise.all([newUser(), newUser()]);
      await Promise.all([
        create(mine.id),
        create(mine.id),
        create(mine.id, new Date(NOW)),
        create(theirs.id),
      ]);

      const res = await read(mine.token, '/me/notifications/read');

      expect(res.status).toBe(201);
      expect(bodyOf<{ updated: number }>(res)).toEqual({ updated: 2 });
      expect(await db.prisma.notification.count({ where: { readAt: null } })).toBe(1);
      // A second call has nothing left to do.
      expect(bodyOf<{ updated: number }>(await read(mine.token, '/me/notifications/read'))).toEqual(
        { updated: 0 },
      );
    });

    it('an admin reading their own notifications does not touch anyone else’s', async () => {
      const user = await newUser();
      await Promise.all([create(user.id), create(adminId)]);

      await read(adminToken, '/me/notifications/read');

      expect(await db.prisma.notification.count({ where: { userId: user.id, readAt: null } })).toBe(
        1,
      );
    });
  });
});
