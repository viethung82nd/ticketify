import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedMomoPayment,
  createdMomoPaymentSchema,
  type CreatedShowtime,
  DayType,
  momoReturnResultSchema,
  Role,
  SeatType,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { OutboxEventType } from '../../../src/infra/outbox/outbox-events';
import {
  OUTBOX_POLL_INTERVAL_MS,
  OutboxRelay,
} from '../../../src/infra/outbox/outbox-relay.service';
import { actionsOf, deliveryJobId } from '../../../src/infra/queue/delivery-queue';
import { DeliveryQueueProducer } from '../../../src/infra/queue/delivery-queue.producer';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../../src/modules/bookings/booking-expiry.service';
import { MOMO_PATHS } from '../../../src/modules/payment/momo/momo.client';
import {
  generateMomoSignature,
  type MomoSignable,
} from '../../../src/modules/payment/momo/momo-signature';
import { VnpayService } from '../../../src/modules/payment/vnpay/vnpay.service';
import { REALTIME_CHANNEL_KEY } from '../../../src/modules/realtime/realtime-redis';
import { appTestEnv } from '../../support/app-env';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { FakeMomo } from '../../support/fake-momo';
import { bodyOf, errorOf } from '../../support/http';
import { NO_PAYMENT_VIOLATIONS, paymentViolations } from '../../support/payment-invariants';
import { createTestRedis, type TestRedis } from '../../support/redis';
import { captureServerErrors, formatServerErrors } from '../../support/server-errors';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
/** Past holdUntil: the hold TTL plus the payment grace. */
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
const SEAT_PRICE = 90_000;
/** Test-only merchant settings; never real ones. */
const MOMO = {
  partnerCode: 'MOMOTKFTEST',
  accessKey: 'integrationTestAccessKey',
  secretKey: 'integration-test-momo-secret-key-0123456789',
} as const;
const MOMO_TIMEOUT_MS = 1_000;
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;
const DUPLICATES = 10;

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();

interface TestUser {
  id: string;
}

describe('MoMo payments — create, IPN, return, expiry query (real Postgres + Redis, fake MoMo over HTTP)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let relay: OutboxRelay;
  let producer: DeliveryQueueProducer;
  let adminId: string;
  const clock = new FakeClock(NOW);
  const momo = new FakeMomo(MOMO);
  const vnpay = new VnpayService();
  const channelKey = `ticketify-test:${randomUUID()}`;

  beforeAll(async () => {
    // First: the env is read once, when the module graph is imported.
    await momo.start();
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
          PAYMENT_RATE_LIMIT_MAX: '1000',
          MOMO_PARTNER_CODE: MOMO.partnerCode,
          MOMO_ACCESS_KEY: MOMO.accessKey,
          MOMO_SECRET_KEY: MOMO.secretKey,
          MOMO_ENDPOINT: momo.url,
          MOMO_REDIRECT_URL: 'http://localhost:5173/payment/result/momo',
          MOMO_IPN_URL: 'https://api.example.test/payments/momo/ipn',
          MOMO_REQUEST_TIMEOUT_MS: String(MOMO_TIMEOUT_MS),
          MOMO_QUERY_TIMEOUT_MS: String(MOMO_TIMEOUT_MS),
          ...VNPAY_ENV,
        },
      ),
    );
    const { AppModule } = await import('../../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();
    adminId = (
      await db.prisma.user.create({
        data: {
          email: `admin-${randomUUID()}@test.local`,
          passwordHash: 'not-a-real-hash',
          fullName: 'MoMo Admin',
          role: Role.ADMIN,
        },
      })
    ).id;
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: SEAT_PRICE })),
      ),
    });

    // Worker side, compiled but not started: the test drives the expiry and the relay itself.
    const { WorkerModule } = await import('../../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(OUTBOX_POLL_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    expiry = workerRef.get(BookingExpiryService);
    relay = workerRef.get(OutboxRelay);
    producer = workerRef.get(DeliveryQueueProducer);
  });

  afterAll(async () => {
    await workerRef?.close();
    await app?.close();
    await momo.stop();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => {
    clock.set(NOW);
    momo.reset();
  });
  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const tokenOf = (user: TestUser) =>
    app.get(AccessTokenIssuer).issue({ id: user.id, role: Role.USER }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `momo-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `MoMo User ${userCounter}`,
      },
    });
    return { id: user.id };
  }

  const admin = (path: string, body: object = {}) =>
    http()
      .post(path)
      .set(
        'Authorization',
        `Bearer ${app.get(AccessTokenIssuer).issue({ id: adminId, role: Role.ADMIN }).token}`,
      )
      .send(body);

  let movieId: string | undefined;
  let counter = 0;
  async function scene() {
    counter += 1;
    const roomRes = await admin('/admin/rooms', {
      name: `Phòng MoMo ${counter}`,
      rows: 2,
      cols: 12,
    });
    expect(roomRes.status).toBe(201);
    const room = bodyOf<AdminRoom>(roomRes);
    const ids = new Map(room.seats.map((s) => [`${s.row}${s.number}`, s.id]));
    const seat = (label: string) => {
      const id = ids.get(label);
      if (!id) throw new Error(`No seat ${label}`);
      return id;
    };
    movieId ??= (
      await db.prisma.movie.create({
        data: {
          title: 'MoMo Movie',
          slug: `momo-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: instant('2026-10-01'),
        },
      })
    ).id;
    const showtimeRes = await admin('/admin/showtimes', {
      movieId,
      roomId: room.id,
      startsAt: vn('2026-11-02', '19:00'),
    });
    expect(showtimeRes.status).toBe(201);
    return { showtime: bodyOf<CreatedShowtime>(showtimeRes), seat };
  }

  /** A user with a fresh PENDING booking of two seats (2 × 90 000 ₫). */
  async function pendingBooking() {
    const { showtime, seat } = await scene();
    const user = await newUser();
    const res = await http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId: showtime.id, seatIds: [seat('A1'), seat('A2')] });
    expect(res.status).toBe(201);
    return { user, booking: bodyOf<Booking>(res) };
  }

  const payMomo = (user: TestUser, body: object) =>
    http()
      .post('/payments/momo')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .send(body);

  async function momoPayment(user: TestUser, bookingId: string): Promise<CreatedMomoPayment> {
    const res = await payMomo(user, { bookingId });
    expect(res.status).toBe(201);
    return createdMomoPaymentSchema.parse(res.body);
  }

  const paymentOf = (id: string) =>
    db.prisma.payment.findUniqueOrThrow({
      where: { id },
      select: {
        provider: true,
        txnRef: true,
        amount: true,
        status: true,
        providerRequestId: true,
        providerTransactionId: true,
        vnpTransactionNo: true,
        payUrl: true,
        responseCode: true,
      },
    });

  const bookingStatus = async (id: string) =>
    (await db.prisma.booking.findUniqueOrThrow({ where: { id } })).status;

  const outboxOf = (bookingId: string) =>
    db.prisma.outboxEvent.findMany({
      where: { aggregateId: bookingId },
      orderBy: { createdAt: 'asc' },
    });

  const ticketsOf = (bookingId: string) => db.prisma.ticket.count({ where: { bookingId } });

  /**
   * MoMo's transId of an attempt: one per payment, the same on every IPN of it (a repeat is the
   * same notification), never shared by two payments (payments_provider_provider_transaction_id_key).
   */
  const transIds = new Map<string, number>();
  const transIdOf = (paymentId: string): number => {
    if (!transIds.has(paymentId)) transIds.set(paymentId, 4_088_878_000 + transIds.size + 1);
    return transIds.get(paymentId)!;
  };

  /** The IPN MoMo would POST for this attempt, signed with the merchant secret. */
  async function ipnBody(
    payment: CreatedMomoPayment,
    overrides: Record<string, string | number> = {},
    secretKey: string = MOMO.secretKey,
  ): Promise<Record<string, unknown>> {
    const row = await paymentOf(payment.paymentId);
    const fields = {
      partnerCode: MOMO.partnerCode,
      orderId: payment.orderId,
      requestId: row.providerRequestId!,
      amount: row.amount,
      orderInfo: 'Thanh toan ve',
      orderType: 'momo_wallet',
      transId: transIdOf(payment.paymentId),
      resultCode: 0,
      message: 'Thành công.',
      payType: 'qr',
      responseTime: 1_793_534_700_000,
      extraData: '',
      ...overrides,
    };
    const signature = generateMomoSignature('result', fields as MomoSignable<'result'>, {
      accessKey: MOMO.accessKey,
      secretKey,
    });
    return { ...fields, signature };
  }

  const postIpn = (body: unknown) =>
    http()
      .post('/payments/momo/ipn')
      .send(body as object);

  async function expectNoViolations() {
    expect(await paymentViolations(db.prisma)).toEqual(NO_PAYMENT_VIOLATIONS);
  }

  // ─── Creation ───

  describe('POST /payments/momo', () => {
    it('201: a Payment PENDING (MOMO) for the booking total, a signed create call, the payUrl stored', async () => {
      const { user, booking } = await pendingBooking();

      const created = await momoPayment(user, booking.id);

      expect(created).toMatchObject({ reused: false, expiresAt: booking.expiresAt });
      expect(created.orderId).toMatch(/^[A-Za-z0-9]{20}$/);
      const row = await paymentOf(created.paymentId);
      expect(row).toEqual({
        provider: 'MOMO',
        txnRef: created.orderId,
        amount: booking.total,
        status: 'PENDING',
        providerRequestId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
        providerTransactionId: null,
        vnpTransactionNo: null,
        payUrl: created.payUrl,
        responseCode: null,
      });
      const [call] = momo.calls(MOMO_PATHS.create);
      expect(call?.signatureValid).toBe(true);
      expect(call?.body).toMatchObject({
        partnerCode: MOMO.partnerCode,
        orderId: created.orderId,
        requestId: row.providerRequestId,
        amount: booking.total,
        requestType: 'captureWallet',
        redirectUrl: 'http://localhost:5173/payment/result/momo',
        ipnUrl: 'https://api.example.test/payments/momo/ipn',
        extraData: '',
        lang: 'vi',
      });
      // Nothing else moves: the booking waits for the IPN.
      expect(await bookingStatus(booking.id)).toBe('PENDING');
    });

    it('called again while PENDING: the same attempt, MoMo is not called a second time', async () => {
      const { user, booking } = await pendingBooking();
      const first = await momoPayment(user, booking.id);

      const again = await momoPayment(user, booking.id);

      expect(again).toEqual({ ...first, reused: true });
      expect(momo.calls(MOMO_PATHS.create)).toHaveLength(1);
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('five clicks at once: one MoMo order, one payment row, no 5xx', async () => {
      const { user, booking } = await pendingBooking();
      const errors = captureServerErrors();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => payMomo(user, { bookingId: booking.id })),
      );

      expect(formatServerErrors(errors.errors)).toBe('');
      errors.restore();
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => (r.body as CreatedMomoPayment).orderId)).size).toBe(1);
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('400: an amount (or anything else) in the body is refused; the amount is never taken from the client', async () => {
      const { user, booking } = await pendingBooking();

      const res = await payMomo(user, { bookingId: booking.id, amount: 1_000 });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
      expect(momo.requests).toEqual([]);
    });

    it("404: another user's booking; nothing written, MoMo not called", async () => {
      const { booking } = await pendingBooking();
      const stranger = await newUser();

      const res = await payMomo(stranger, { bookingId: booking.id });

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
      expect(momo.requests).toEqual([]);
    });

    it('422: the booking expired; nothing written', async () => {
      const { user, booking } = await pendingBooking();
      clock.set(booking.expiresAt);

      const res = await payMomo(user, { bookingId: booking.id });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('BOOKING_EXPIRED');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('503 on a MoMo timeout: the attempt stays PENDING; the retry re-sends the SAME orderId and requestId', async () => {
      const { user, booking } = await pendingBooking();
      momo.handler = (r) => ({ ...momo.created(r), delayMs: MOMO_TIMEOUT_MS + 500 });

      const timedOut = await payMomo(user, { bookingId: booking.id });

      expect(timedOut.status).toBe(503);
      expect(errorOf(timedOut).code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      const [row] = await db.prisma.payment.findMany({ where: { bookingId: booking.id } });
      expect(row).toMatchObject({ status: 'PENDING', payUrl: null, provider: 'MOMO' });

      momo.handler = null;
      const retried = await momoPayment(user, booking.id);

      expect(retried).toMatchObject({ paymentId: row!.id, orderId: row!.txnRef, reused: true });
      const calls = momo.calls(MOMO_PATHS.create);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.body).toEqual(calls[0]?.body);
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('502 when MoMo refuses: the attempt FAILED, the next call opens a new one', async () => {
      const { user, booking } = await pendingBooking();
      momo.handler = (r) => ({
        status: 400,
        body: { ...r.body, resultCode: 21, message: 'Số tiền không hợp lệ' },
      });

      const refused = await payMomo(user, { bookingId: booking.id });

      expect(refused.status).toBe(502);
      expect(errorOf(refused)).toMatchObject({
        code: 'PAYMENT_PROVIDER_ERROR',
        details: { resultCode: 21 },
      });
      const [failed] = await db.prisma.payment.findMany({ where: { bookingId: booking.id } });
      expect(failed).toMatchObject({ status: 'FAILED', responseCode: '21' });

      momo.handler = null;
      const next = await momoPayment(user, booking.id);
      expect(next.reused).toBe(false);
      expect(next.orderId).not.toBe(failed!.txnRef);
    });

    it('503 PAYMENT_NOT_CONFIGURED is not reachable here; VNPay and MoMo attempts coexist for one booking', async () => {
      const { user, booking } = await pendingBooking();
      const vnpayRes = await http()
        .post('/payments/vnpay')
        .set('Authorization', `Bearer ${tokenOf(user)}`)
        .send({ bookingId: booking.id });
      expect(vnpayRes.status).toBe(201);

      await momoPayment(user, booking.id);

      const providers = await db.prisma.payment.findMany({
        where: { bookingId: booking.id },
        select: { provider: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(providers).toEqual([
        { provider: 'VNPAY', status: 'PENDING' },
        { provider: 'MOMO', status: 'PENDING' },
      ]);
    });
  });

  // ─── IPN ───

  describe('POST /payments/momo/ipn', () => {
    it('a valid success: 204, Payment SUCCESS (transId stored), booking CONFIRMED, tickets, one booking.confirmed', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);

      const res = await postIpn(await ipnBody(payment));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(await paymentOf(payment.paymentId)).toMatchObject({
        status: 'SUCCESS',
        providerTransactionId: String(transIdOf(payment.paymentId)),
        vnpTransactionNo: null,
        responseCode: '0',
      });
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      expect(await ticketsOf(booking.id)).toBe(2);
      const events = await outboxOf(booking.id);
      expect(events.map((e) => e.type)).toEqual([OutboxEventType.BOOKING_CONFIRMED]);
      await expectNoViolations();
    });

    it(`${DUPLICATES} identical IPNs at once: all 204, one transition, one event, the delivery jobs once`, async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      const body = await ipnBody(payment);
      const errors = captureServerErrors();

      const results = await Promise.all(Array.from({ length: DUPLICATES }, () => postIpn(body)));

      expect(formatServerErrors(errors.errors)).toBe('');
      errors.restore();
      expect(results.map((r) => r.status)).toEqual(Array(DUPLICATES).fill(204));
      expect(await ticketsOf(booking.id)).toBe(2);
      const [event, ...others] = await outboxOf(booking.id);
      expect(others).toEqual([]);
      expect(event?.type).toBe(OutboxEventType.BOOKING_CONFIRMED);

      // Relayed twice, and the IPN repeated in between: still one job per action.
      await relay.pollOnce();
      await postIpn(body);
      await relay.pollOnce();
      const actions = actionsOf(OutboxEventType.BOOKING_CONFIRMED);
      for (const action of actions) {
        expect(await producer.queue.getJob(deliveryJobId(event!.id, action))).toBeDefined();
      }
      const jobs = await producer.queue.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
        'failed',
      ]);
      expect(jobs.filter((job) => job.data.aggregateId === booking.id)).toHaveLength(
        actions.length,
      );
      expect(await outboxOf(booking.id)).toHaveLength(1);
      await expectNoViolations();
    });

    it.each([
      ['signed with another secret', (b: Record<string, unknown>) => b, 'another-secret'],
      [
        'amount changed after signing',
        (b: Record<string, unknown>) => ({ ...b, amount: 1_000 }),
        undefined,
      ],
      [
        'orderId changed after signing',
        (b: Record<string, unknown>) => ({ ...b, orderId: 'ZZZZZZZZZZZZZZZZZZZZ' }),
        undefined,
      ],
      ['no signature', (b: Record<string, unknown>) => ({ ...b, signature: undefined }), undefined],
      [
        'a required field missing',
        (b: Record<string, unknown>) => ({ ...b, resultCode: undefined }),
        undefined,
      ],
    ])(
      '400 when %s: nothing changes (payment and booking PENDING, no event)',
      async (_label, tamper, secret) => {
        const { user, booking } = await pendingBooking();
        const payment = await momoPayment(user, booking.id);

        const res = await postIpn(tamper(await ipnBody(payment, {}, secret)));

        expect(res.status).toBe(400);
        expect((await paymentOf(payment.paymentId)).status).toBe('PENDING');
        expect(await bookingStatus(booking.id)).toBe('PENDING');
        expect(await outboxOf(booking.id)).toEqual([]);
      },
    );

    it('a failure (1006, user declined): 204, Payment FAILED, booking PENDING; the user can pay again', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);

      const res = await postIpn(
        await ipnBody(payment, { resultCode: 1006, message: 'Người dùng từ chối' }),
      );

      expect(res.status).toBe(204);
      expect(await paymentOf(payment.paymentId)).toMatchObject({
        status: 'FAILED',
        providerTransactionId: null,
        responseCode: '1006',
      });
      expect(await bookingStatus(booking.id)).toBe('PENDING');
      const again = await momoPayment(user, booking.id);
      expect(again).toMatchObject({ reused: false });
      expect(again.orderId).not.toBe(payment.orderId);
    });

    it('a success after a recorded failure: 204, the payment stays FAILED (a repeat changes nothing)', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      await postIpn(await ipnBody(payment, { resultCode: 1006 }));

      const res = await postIpn(await ipnBody(payment));

      expect(res.status).toBe(204);
      expect((await paymentOf(payment.paymentId)).status).toBe('FAILED');
      expect(await bookingStatus(booking.id)).toBe('PENDING');
    });

    it('not final yet (1000): 204, nothing changes', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);

      expect((await postIpn(await ipnBody(payment, { resultCode: 1000 }))).status).toBe(204);
      expect((await paymentOf(payment.paymentId)).status).toBe('PENDING');
    });

    it('a signed amount that is not the payment’s: 204, nothing changes', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);

      expect((await postIpn(await ipnBody(payment, { amount: 1_000 }))).status).toBe(204);
      expect((await paymentOf(payment.paymentId)).status).toBe('PENDING');
      expect(await bookingStatus(booking.id)).toBe('PENDING');
    });

    it('an unknown orderId, correctly signed: 204, nothing anywhere changes', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);

      const res = await postIpn(await ipnBody({ ...payment, orderId: 'UnknownOrder00000000' }));

      expect(res.status).toBe(204);
      expect((await paymentOf(payment.paymentId)).status).toBe('PENDING');
    });

    it('a VNPay-signed IPN naming a MoMo orderId: 01, the MoMo payment is untouched', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      const query = vnpay.buildSignedQuery(
        {
          vnp_Amount: String(booking.total * 100),
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: '00',
          vnp_TransactionNo: '14226112',
          vnp_TxnRef: payment.orderId,
        },
        VNPAY_ENV.VNPAY_HASH_SECRET,
      );

      const res = await http().get(`/payments/vnpay/ipn?${query}`);

      expect(res.body).toEqual({ RspCode: '01', Message: 'Order not found' });
      expect((await paymentOf(payment.paymentId)).status).toBe('PENDING');
    });

    it('paid with VNPay and then with MoMo: the MoMo payment is REFUND_REQUIRED, named as MoMo in the event', async () => {
      const { user, booking } = await pendingBooking();
      const vnpayRes = await http()
        .post('/payments/vnpay')
        .set('Authorization', `Bearer ${tokenOf(user)}`)
        .send({ bookingId: booking.id });
      const txnRef = (vnpayRes.body as { txnRef: string }).txnRef;
      const momoPaid = await momoPayment(user, booking.id);
      const vnpayIpn = vnpay.buildSignedQuery(
        {
          vnp_Amount: String(booking.total * 100),
          vnp_BankCode: 'NCB',
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: '00',
          vnp_TransactionNo: '14226112',
          vnp_TxnRef: txnRef,
        },
        VNPAY_ENV.VNPAY_HASH_SECRET,
      );
      expect((await http().get(`/payments/vnpay/ipn?${vnpayIpn}`)).body).toMatchObject({
        RspCode: '00',
      });

      expect((await postIpn(await ipnBody(momoPaid))).status).toBe(204);

      expect(await paymentOf(momoPaid.paymentId)).toMatchObject({
        status: 'REFUND_REQUIRED',
        providerTransactionId: String(transIdOf(momoPaid.paymentId)),
        vnpTransactionNo: null,
      });
      const refund = await db.prisma.outboxEvent.findFirstOrThrow({
        where: { type: OutboxEventType.PAYMENT_REFUND_REQUIRED, aggregateId: momoPaid.paymentId },
      });
      expect(refund.payload).toMatchObject({
        provider: 'MOMO',
        vnpTransactionNo: null,
        providerTransactionId: String(transIdOf(momoPaid.paymentId)),
      });
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      await expectNoViolations();
    });
  });

  // ─── Return page ───

  describe('GET /payments/momo/return', () => {
    const asQuery = (body: Record<string, unknown>) =>
      new URLSearchParams(
        Object.entries(body).map(([key, value]): [string, string] => [key, String(value)]),
      ).toString();

    it('display only: verified, PENDING before the IPN, SUCCESS after it; the redirect itself changes nothing', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      const body = await ipnBody(payment);

      const before = momoReturnResultSchema.parse(
        (await http().get(`/payments/momo/return?${asQuery(body)}`)).body,
      );
      expect(before).toEqual({
        verified: true,
        bookingId: booking.id,
        paymentStatus: 'PENDING',
        resultCode: 0,
        amountMismatch: false,
      });
      expect(await bookingStatus(booking.id)).toBe('PENDING');

      await postIpn(body);
      const after = momoReturnResultSchema.parse(
        (await http().get(`/payments/momo/return?${asQuery(body)}`)).body,
      );
      expect(after).toMatchObject({ verified: true, paymentStatus: 'SUCCESS' });
    });

    it('a tampered redirect (resultCode 0 on a failure): { verified: false }', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      const failed = await ipnBody(payment, { resultCode: 1006 });

      const res = await http().get(
        `/payments/momo/return?${asQuery({ ...failed, resultCode: 0 })}`,
      );

      expect(res.body).toEqual({ verified: false });
    });
  });

  // ─── Expiry: MoMo's query when the IPN never came ───

  describe('booking expiry asks MoMo about a PENDING MoMo attempt', () => {
    it('MoMo reports it paid (resultCode 0): recorded instead of expiring, CONFIRMED', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      momo.queryResults.set(payment.orderId, {
        resultCode: 0,
        amount: booking.total,
        transId: 4_088_878_999,
        payType: 'qr',
        message: 'Thành công.',
      });
      clock.advance({ minutes: HOLD_MINUTES });

      const result = await expiry.expire(booking.id);

      expect(result.outcome).toBe('paid');
      const [query] = momo.calls(MOMO_PATHS.query);
      expect(query?.signatureValid).toBe(true);
      expect(query?.body).toMatchObject({
        orderId: payment.orderId,
        partnerCode: MOMO.partnerCode,
      });
      expect(await paymentOf(payment.paymentId)).toMatchObject({
        status: 'SUCCESS',
        providerTransactionId: '4088878999',
      });
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      await expectNoViolations();
    });

    it('MoMo reports a failure: the booking expires as usual and the attempt is EXPIRED', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      momo.queryResults.set(payment.orderId, { resultCode: 1006 });
      clock.advance({ minutes: HOLD_MINUTES });

      const result = await expiry.expire(booking.id);

      expect(result.outcome).toBe('expired');
      expect((await paymentOf(payment.paymentId)).status).toBe('EXPIRED');
      expect(await bookingStatus(booking.id)).toBe('EXPIRED');
    });

    it('a late success IPN after the expiry is still recorded (branch B: seats taken back)', async () => {
      const { user, booking } = await pendingBooking();
      const payment = await momoPayment(user, booking.id);
      clock.advance({ minutes: HOLD_MINUTES });
      expect((await expiry.expire(booking.id)).outcome).toBe('expired');

      expect((await postIpn(await ipnBody(payment))).status).toBe(204);

      expect((await paymentOf(payment.paymentId)).status).toBe('SUCCESS');
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      await expectNoViolations();
    });
  });
});
