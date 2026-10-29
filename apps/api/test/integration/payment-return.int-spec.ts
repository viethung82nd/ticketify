import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  type CreatedVnpayPayment,
  DayType,
  Role,
  SeatType,
  type VnpayReturnResult,
  vnpayReturnResultSchema,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppConfig } from '../../src/config/app-config.service';
import type { Env } from '../../src/config/env.schema';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { type VnpayParams, VnpayService } from '../../src/modules/payment/vnpay/vnpay.service';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const SEAT_PRICE = 90_000;
const PAYMENT_RETURN_RATE_LIMIT_MAX = 30;
/** Test-only merchant settings; never a real secret. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();

describe('Payment return — GET /payments/vnpay/return (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let adminToken: string;
  let ipCounter = 0;
  const clock = new FakeClock(NOW);
  const vnpay = new VnpayService();

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          // The per-IP limit is checked with X-Forwarded-For, one address per test.
          TRUST_PROXY: 'loopback',
          PAYMENT_RETURN_RATE_LIMIT_MAX: String(PAYMENT_RETURN_RATE_LIMIT_MAX),
          PAYMENT_RATE_LIMIT_WINDOW_SECONDS: '60',
          ...VNPAY_ENV,
        },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();
    adminToken = await accessTokenFor(app, db.prisma, Role.ADMIN);
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: SEAT_PRICE })),
      ),
    });
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => {
    clock.set(NOW);
    ipCounter += 1;
  });
  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  /** A client address of its own per test, so the per-IP budget never leaks between tests. */
  const clientIp = () => `203.0.113.${ipCounter}`;

  const admin = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', `Bearer ${adminToken}`).send(body);

  let counter = 0;
  /** A PENDING booking of one seat and one VNPay payment attempt for it. */
  async function paymentAttempt() {
    counter += 1;
    const room = bodyOf<AdminRoom>(
      await admin('/admin/rooms', { name: `Phòng Return ${counter}`, rows: 1, cols: 4 }),
    );
    const movie = await db.prisma.movie.create({
      data: {
        title: 'Return Movie',
        slug: `return-movie-${randomUUID()}`,
        duration: 100,
        ageRating: 'P',
        releaseDate: instant('2026-10-01'),
      },
    });
    const showtime = bodyOf<CreatedShowtime>(
      await admin('/admin/showtimes', {
        movieId: movie.id,
        roomId: room.id,
        startsAt: vn('2026-11-02', '19:00'),
      }),
    );
    const user = await db.prisma.user.create({
      data: {
        email: `return-${counter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Return User ${counter}`,
      },
    });
    const token = app.get(AccessTokenIssuer).issue({ id: user.id, role: Role.USER }).token;
    const holdRes = await http()
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId: showtime.id, seatIds: [room.seats[0]!.id] });
    expect(holdRes.status).toBe(201);
    const booking = bodyOf<Booking>(holdRes);
    const payRes = await http()
      .post('/payments/vnpay')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookingId: booking.id });
    expect(payRes.status).toBe(201);
    return { booking, payment: bodyOf<CreatedVnpayPayment>(payRes) };
  }

  /** What VNPay appends to vnp_ReturnUrl after a payment, signed with the test secret. */
  function vnpayReturnQuery(
    payment: CreatedVnpayPayment,
    booking: Booking,
    overrides: VnpayParams = {},
  ): string {
    return vnpay.buildSignedQuery(
      {
        vnp_Amount: booking.total * 100,
        vnp_BankCode: 'NCB',
        vnp_BankTranNo: 'VNP14226112',
        vnp_CardType: 'ATM',
        vnp_OrderInfo: `Thanh toan ve ${booking.code}`,
        vnp_PayDate: '20261101170300',
        vnp_ResponseCode: '00',
        vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
        vnp_TransactionNo: '14226112',
        vnp_TransactionStatus: '00',
        vnp_TxnRef: payment.txnRef,
        ...overrides,
      },
      VNPAY_ENV.VNPAY_HASH_SECRET,
    );
  }

  const returned = (query: string) =>
    http().get(`/payments/vnpay/return?${query}`).set('X-Forwarded-For', clientIp());

  async function resultOf(query: string): Promise<VnpayReturnResult> {
    const res = await returned(query);
    expect(res.status).toBe(200);
    return vnpayReturnResultSchema.parse(res.body);
  }

  /** Payment and booking rows as stored, to prove the endpoint wrote nothing. */
  const stateOf = async (paymentId: string, bookingId: string) => ({
    payment: await db.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    booking: await db.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
  });

  // ─── Verified ───

  it('vnp_ResponseCode 00: verified, payment still PENDING; nothing is written', async () => {
    const { booking, payment } = await paymentAttempt();
    const before = await stateOf(payment.paymentId, booking.id);

    // Public: no Authorization header (the browser comes back from VNPay).
    const result = await resultOf(vnpayReturnQuery(payment, booking));

    expect(result).toEqual({
      verified: true,
      bookingId: booking.id,
      paymentStatus: 'PENDING',
      vnpResponseCode: '00',
      amountMismatch: false,
    });
    expect(await stateOf(payment.paymentId, booking.id)).toEqual(before);
    expect(before.payment).toMatchObject({
      status: 'PENDING',
      responseCode: null,
      processedAt: null,
    });
  });

  it('another vnp_ResponseCode (24, customer cancelled at VNPay): reported as sent, nothing written', async () => {
    const { booking, payment } = await paymentAttempt();
    const before = await stateOf(payment.paymentId, booking.id);

    const result = await resultOf(
      vnpayReturnQuery(payment, booking, { vnp_ResponseCode: '24', vnp_TransactionNo: '0' }),
    );

    expect(result).toEqual({
      verified: true,
      bookingId: booking.id,
      paymentStatus: 'PENDING',
      vnpResponseCode: '24',
      amountMismatch: false,
    });
    expect(await stateOf(payment.paymentId, booking.id)).toEqual(before);
  });

  it('the status reported is the one stored (as the IPN of week 12 will leave it)', async () => {
    const { booking, payment } = await paymentAttempt();
    await db.prisma.payment.update({
      where: { id: payment.paymentId },
      data: { status: 'FAILED' },
    });

    expect(await resultOf(vnpayReturnQuery(payment, booking))).toMatchObject({
      verified: true,
      paymentStatus: 'FAILED',
    });
  });

  it('vnp_Amount ≠ amount × 100: verified but amountMismatch', async () => {
    const { booking, payment } = await paymentAttempt();

    for (const amount of [booking.total, booking.total * 100 + 1, `0${booking.total * 100}`]) {
      expect(
        await resultOf(vnpayReturnQuery(payment, booking, { vnp_Amount: amount })),
      ).toMatchObject({ verified: true, amountMismatch: true });
    }
  });

  // ─── Not verified ───

  it('a changed parameter or a bad hash: { verified: false } and nothing else', async () => {
    const { booking, payment } = await paymentAttempt();
    const query = vnpayReturnQuery(payment, booking, { vnp_ResponseCode: '24' });

    const tampered = query.replace('vnp_ResponseCode=24', 'vnp_ResponseCode=00');
    expect(tampered).not.toBe(query);
    const badHash = query.replace(/vnp_SecureHash=[0-9a-f]/, (m) =>
      m.endsWith('0') ? `${m.slice(0, -1)}1` : `${m.slice(0, -1)}0`,
    );
    const otherSecret = vnpay.buildSignedQuery(
      { vnp_TxnRef: payment.txnRef, vnp_Amount: booking.total * 100, vnp_ResponseCode: '00' },
      'not-the-merchant-secret',
    );
    for (const candidate of [tampered, badHash, otherSecret]) {
      const res = await returned(candidate);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ verified: false });
    }
  });

  it('missing hash, no query at all, or a repeated parameter: { verified: false }', async () => {
    const { booking, payment } = await paymentAttempt();
    const query = vnpayReturnQuery(payment, booking);

    const withoutHash = query.replace(/&vnp_SecureHash=[0-9a-f]+$/, '');
    for (const candidate of [withoutHash, '', `${query}&vnp_TxnRef=${payment.txnRef}`]) {
      expect(bodyOf<unknown>(await returned(candidate))).toEqual({ verified: false });
    }
  });

  it('a valid signature for an unknown vnp_TxnRef: { verified: false }', async () => {
    const { booking, payment } = await paymentAttempt();

    const res = await returned(
      vnpayReturnQuery(payment, booking, { vnp_TxnRef: 'UnknownTxnRef0000000' }),
    );

    expect(res.body).toEqual({ verified: false });
  });

  // ─── Limits and configuration ───

  it(`429 TOO_MANY_ATTEMPTS after ${PAYMENT_RETURN_RATE_LIMIT_MAX} requests a minute from one IP; other IPs unaffected`, async () => {
    const { booking, payment } = await paymentAttempt();
    const query = vnpayReturnQuery(payment, booking);
    for (let i = 0; i < PAYMENT_RETURN_RATE_LIMIT_MAX; i++) {
      expect((await returned(query)).status).toBe(200);
    }

    const refused = await returned(query);
    expect(refused.status).toBe(429);
    expect(errorOf(refused).code).toBe('TOO_MANY_ATTEMPTS');
    expect(errorOf(refused).details).toEqual({ retryAfterSeconds: expect.any(Number) as unknown });

    ipCounter += 1;
    expect((await returned(query)).status).toBe(200);
  });

  it('503 PAYMENT_NOT_CONFIGURED without VNPAY_HASH_SECRET (nothing to check the signature with)', async () => {
    const { booking, payment } = await paymentAttempt();
    const config = app.get(AppConfig);
    const original = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(<K extends keyof Env>(key: K): Env[K] =>
        key === 'VNPAY_HASH_SECRET' ? (undefined as Env[K]) : original(key),
      );

    const res = await returned(vnpayReturnQuery(payment, booking));

    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('PAYMENT_NOT_CONFIGURED');
  });
});
