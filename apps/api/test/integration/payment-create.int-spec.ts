import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  type CreatedVnpayPayment,
  createdVnpayPaymentSchema,
  DayType,
  Role,
  SeatType,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppConfig } from '../../src/config/app-config.service';
import type { Env } from '../../src/config/env.schema';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { vnpayDate } from '../../src/modules/payment/vnpay/vnpay-format';
import { VnpayService } from '../../src/modules/payment/vnpay/vnpay.service';
import { appTestEnv } from '../support/app-env';
import { accessTokenFor } from '../support/auth';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';
import { captureServerErrors, formatServerErrors } from '../support/server-errors';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
const SEAT_PRICE = 90_000;
const PAYMENT_RATE_LIMIT_MAX = 10;
const UNKNOWN_ID = '01a17e75-0000-7000-8000-000000000000';
/** Test-only merchant settings; never a real secret. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;
const RACE_ROUNDS = 20;
/**
 * Random start offsets (ms). A payment request does more before it reaches the booking row than a
 * cancel (rate limit in Redis, more queries), so the cancel gets the wider range: with equal ranges
 * the cancel won about 9 rounds in 10 and the "payment first" branch was barely exercised.
 */
const RACE_CANCEL_MAX_DELAY_MS = 30;
const RACE_PAY_MAX_DELAY_MS = 5;
/** How long a blocked request must stay blocked before the test calls it "waiting". */
const BLOCKED_MS = 300;

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Deterministic PRNG (mulberry32) so a failing race round can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The query of a payment URL as Express would parse it (`+` is a space). */
const queryOf = (paymentUrl: string): Record<string, string> =>
  Object.fromEntries(new URL(paymentUrl).searchParams);

interface TestUser {
  id: string;
}

describe('Payment creation — POST /payments/vnpay (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let adminToken: string;
  const clock = new FakeClock(NOW);
  const vnpay = new VnpayService();

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
          PAYMENT_RATE_LIMIT_MAX: String(PAYMENT_RATE_LIMIT_MAX),
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

  beforeEach(() => clock.set(NOW));
  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  /** Signed at the clock's current "now": tokens live 15 minutes on that clock. */
  const tokenOf = (user: TestUser) =>
    app.get(AccessTokenIssuer).issue({ id: user.id, role: Role.USER }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `pay-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Pay User ${userCounter}`,
      },
    });
    return { id: user.id };
  }

  const admin = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', `Bearer ${adminToken}`).send(body);

  let movieId: string | undefined;
  let counter = 0;
  /** Fresh `rows × 12` room with one upcoming showtime; `seat('A1')` gives a seat id. */
  async function scene(rows = 2) {
    counter += 1;
    const roomRes = await admin('/admin/rooms', { name: `Phòng Pay ${counter}`, rows, cols: 12 });
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
          title: 'Pay Movie',
          slug: `pay-movie-${randomUUID()}`,
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

  async function held(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
    const res = await http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  /** A user with a fresh PENDING booking of `seats` seats. */
  async function pendingBooking(seats = 2) {
    const { showtime, seat } = await scene();
    const user = await newUser();
    const labels = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].slice(0, seats);
    const booking = await held(user, showtime.id, labels.map(seat));
    return { user, booking, showtime };
  }

  const pay = (user: TestUser, bookingId: string) =>
    http()
      .post('/payments/vnpay')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .send({ bookingId });

  const cancel = (user: TestUser, bookingId: string) =>
    http()
      .delete(`/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenOf(user)}`);

  const paymentsOf = (bookingId: string) =>
    db.prisma.payment.findMany({
      where: { bookingId },
      select: { id: true, txnRef: true, amount: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

  const bookingStatus = async (id: string) =>
    (await db.prisma.booking.findUniqueOrThrow({ where: { id } })).status;

  const setBookingStatus = (id: string, status: string) =>
    db.prisma.$executeRaw`
      UPDATE bookings SET status = ${status}::booking_status WHERE id = ${id}::uuid`;

  /** A payment row written directly (the IPN that would set SUCCESS comes in week 12). */
  const insertPayment = (bookingId: string, status: string) =>
    db.prisma.$executeRaw`
      INSERT INTO payments (id, booking_id, txn_ref, amount, status, updated_at)
      VALUES (gen_random_uuid(), ${bookingId}::uuid, ${randomUUID()}, 1000,
              ${status}::payment_status, ${clock.now()})`;

  const deadlocks = async () => {
    const [row] = await db.prisma.$queryRaw<{ deadlocks: number }[]>`
      SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    return row?.deadlocks ?? 0;
  };

  // ─── Happy path ───

  describe('201', () => {
    it('a Payment PENDING for the booking total and a signed URL VNPay can check', async () => {
      const { user, booking } = await pendingBooking(2);
      expect(booking.total).toBe(2 * SEAT_PRICE);

      const res = await pay(user, booking.id);

      expect(res.status).toBe(201);
      const body = createdVnpayPaymentSchema.parse(res.body);
      expect(body.expiresAt).toBe(booking.expiresAt);
      expect(await paymentsOf(booking.id)).toEqual([
        { id: body.paymentId, txnRef: body.txnRef, amount: booking.total, status: 'PENDING' },
      ]);
      expect(body.txnRef).toMatch(/^[A-Za-z0-9]{20}$/);
      // Nothing else moves: the booking waits for the IPN (week 12).
      expect(await bookingStatus(booking.id)).toBe('PENDING');

      expect(body.paymentUrl.startsWith(`${VNPAY_ENV.VNPAY_PAYMENT_URL}?`)).toBe(true);
      const query = queryOf(body.paymentUrl);
      expect(vnpay.verifySignature(query, VNPAY_ENV.VNPAY_HASH_SECRET)).toBe(true);
      expect(vnpay.verifySignature(query, 'another-secret')).toBe(false);
      expect(query).toEqual({
        vnp_Version: '2.1.0',
        vnp_Command: 'pay',
        vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
        vnp_Amount: String(booking.total * 100),
        vnp_CurrCode: 'VND',
        vnp_TxnRef: body.txnRef,
        vnp_OrderInfo: `Thanh toan ve ${booking.code}`,
        vnp_OrderType: 'other',
        vnp_Locale: 'vn',
        vnp_ReturnUrl: VNPAY_ENV.VNPAY_RETURN_URL,
        vnp_IpAddr: '127.0.0.1',
        // 17:00:00 and 17:10:00 in Vietnam (GMT+7): the clock and the booking expiresAt.
        vnp_CreateDate: '20261101170000',
        vnp_ExpireDate: '20261101171000',
        vnp_SecureHash: expect.stringMatching(/^[0-9a-f]{128}$/) as unknown,
      });
      expect(query.vnp_ExpireDate).toBe(vnpayDate(instant(booking.expiresAt)));
    });

    it('each retry is a new Payment PENDING with its own txnRef; earlier ones stay', async () => {
      const { user, booking } = await pendingBooking(1);

      const bodies: CreatedVnpayPayment[] = [];
      for (let i = 0; i < 3; i++) {
        clock.advance({ seconds: 30 });
        const res = await pay(user, booking.id);
        expect(res.status).toBe(201);
        bodies.push(bodyOf<CreatedVnpayPayment>(res));
      }

      const rows = await paymentsOf(booking.id);
      expect(rows.map((row) => row.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
      expect(rows.map((row) => row.txnRef)).toEqual(bodies.map((body) => body.txnRef));
      expect(new Set(rows.map((row) => row.txnRef)).size).toBe(3);
      expect(new Set(bodies.map((body) => body.paymentUrl)).size).toBe(3);
      // vnp_CreateDate follows the clock; vnp_ExpireDate stays the booking's expiresAt.
      expect(bodies.map((body) => queryOf(body.paymentUrl).vnp_CreateDate)).toEqual([
        '20261101170030',
        '20261101170100',
        '20261101170130',
      ]);
      expect(new Set(bodies.map((body) => queryOf(body.paymentUrl).vnp_ExpireDate))).toEqual(
        new Set(['20261101171000']),
      );
    });

    it('FAILED and EXPIRED payments do not block a new attempt', async () => {
      const { user, booking } = await pendingBooking(1);
      await insertPayment(booking.id, 'FAILED');
      await insertPayment(booking.id, 'EXPIRED');

      expect((await pay(user, booking.id)).status).toBe(201);
      expect((await paymentsOf(booking.id)).map((row) => row.status).sort()).toEqual([
        'EXPIRED',
        'FAILED',
        'PENDING',
      ]);
    });
  });

  // ─── Refusals ───

  describe('refusals (nothing written)', () => {
    it.each(['CONFIRMED', 'NEEDS_REVIEW', 'EXPIRED'] as const)(
      '409 BOOKING_NOT_PAYABLE for a %s booking',
      async (status) => {
        const { user, booking } = await pendingBooking(1);
        await setBookingStatus(booking.id, status);

        const res = await pay(user, booking.id);

        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('BOOKING_NOT_PAYABLE');
        expect(await paymentsOf(booking.id)).toEqual([]);
      },
    );

    it('409 BOOKING_NOT_PAYABLE for a booking the user cancelled (DELETE → EXPIRED)', async () => {
      const { user, booking } = await pendingBooking(1);
      expect((await cancel(user, booking.id)).status).toBe(204);

      const res = await pay(user, booking.id);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('BOOKING_NOT_PAYABLE');
      expect(await paymentsOf(booking.id)).toEqual([]);
    });

    it('409 BOOKING_NOT_PAYABLE for a PENDING booking with total 0 (nothing to pay online)', async () => {
      const { user, booking } = await pendingBooking(1);
      await db.prisma.$executeRaw`UPDATE bookings SET total = 0 WHERE id = ${booking.id}::uuid`;

      const res = await pay(user, booking.id);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('BOOKING_NOT_PAYABLE');
      expect(await paymentsOf(booking.id)).toEqual([]);
    });

    it.each([
      ['at expiresAt exactly', { seconds: HOLD_TTL_SECONDS }],
      ['1 s past expiresAt', { seconds: HOLD_TTL_SECONDS + 1 }],
      ['in the grace period', { seconds: HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS - 1 }],
    ])('422 BOOKING_EXPIRED %s (FakeClock)', async (_, advance) => {
      const { user, booking } = await pendingBooking(1);
      clock.advance(advance);

      const res = await pay(user, booking.id);

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('BOOKING_EXPIRED');
      expect(await paymentsOf(booking.id)).toEqual([]);
    });

    it('422 BOOKING_EXPIRED before expiresAt but in its VNPay second (CreateDate = ExpireDate)', async () => {
      // Held at 17:00:00.700, so expiresAt is 17:10:00.700; at 17:10:00.200 the clock is still
      // before it, but both VNPay dates would read 20261101171000.
      clock.set('2026-11-01T10:00:00.700Z');
      const { user, booking } = await pendingBooking(1);
      expect(booking.expiresAt).toBe('2026-11-01T10:10:00.700Z');
      clock.set('2026-11-01T10:10:00.200Z');

      const res = await pay(user, booking.id);

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('BOOKING_EXPIRED');
      expect(await paymentsOf(booking.id)).toEqual([]);
    });

    it('1 s before expiresAt is still payable', async () => {
      const { user, booking } = await pendingBooking(1);
      clock.advance({ seconds: HOLD_TTL_SECONDS - 1 });

      const res = await pay(user, booking.id);

      expect(res.status).toBe(201);
      const query = queryOf(bodyOf<CreatedVnpayPayment>(res).paymentUrl);
      expect([query.vnp_CreateDate, query.vnp_ExpireDate]).toEqual([
        '20261101170959',
        '20261101171000',
      ]);
    });

    it('409 BOOKING_ALREADY_PAID when a payment is SUCCESS', async () => {
      const { user, booking } = await pendingBooking(1);
      await insertPayment(booking.id, 'SUCCESS');

      const res = await pay(user, booking.id);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('BOOKING_ALREADY_PAID');
      expect((await paymentsOf(booking.id)).map((row) => row.status)).toEqual(['SUCCESS']);
    });

    it('404 BOOKING_NOT_FOUND for another user’s booking and for an unknown id', async () => {
      const { booking } = await pendingBooking(1);
      const intruder = await newUser();

      for (const res of [await pay(intruder, booking.id), await pay(intruder, UNKNOWN_ID)]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
      }
      expect(await paymentsOf(booking.id)).toEqual([]);
    });

    it('400 VALIDATION_FAILED for a malformed or missing bookingId, 401 without a token', async () => {
      const user = await newUser();
      for (const body of [{ bookingId: 'nope' }, {}, { bookingId: UNKNOWN_ID, extra: 1 }]) {
        const res = await http()
          .post('/payments/vnpay')
          .set('Authorization', `Bearer ${tokenOf(user)}`)
          .send(body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect((await http().post('/payments/vnpay').send({ bookingId: UNKNOWN_ID })).status).toBe(
        401,
      );
    });

    it.each(['VNPAY_TMN_CODE', 'VNPAY_HASH_SECRET', 'VNPAY_RETURN_URL'] as const)(
      '503 PAYMENT_NOT_CONFIGURED without %s; no Payment created',
      async (missing) => {
        const { user, booking } = await pendingBooking(1);
        const config = app.get(AppConfig);
        const original = config.get.bind(config);
        jest
          .spyOn(config, 'get')
          .mockImplementation(<K extends keyof Env>(key: K): Env[K] =>
            key === missing ? (undefined as Env[K]) : original(key),
          );

        const res = await pay(user, booking.id);

        expect(res.status).toBe(503);
        expect(errorOf(res).code).toBe('PAYMENT_NOT_CONFIGURED');
        expect(await paymentsOf(booking.id)).toEqual([]);
      },
    );

    it(`429 TOO_MANY_ATTEMPTS after ${PAYMENT_RATE_LIMIT_MAX} requests a minute, before any other check`, async () => {
      const { user, booking } = await pendingBooking(1);
      for (let i = 0; i < PAYMENT_RATE_LIMIT_MAX; i++) {
        expect((await pay(user, booking.id)).status).toBe(201);
      }

      const refused = await pay(user, booking.id);
      expect(refused.status).toBe(429);
      expect(errorOf(refused).code).toBe('TOO_MANY_ATTEMPTS');
      expect(errorOf(refused).details).toEqual({
        retryAfterSeconds: expect.any(Number) as unknown,
      });
      // Counted first: even a request that would be a 404 is refused, and nothing is written.
      expect((await pay(user, UNKNOWN_ID)).status).toBe(429);
      expect(await paymentsOf(booking.id)).toHaveLength(PAYMENT_RATE_LIMIT_MAX);
    });
  });

  // ─── Locks ───

  describe('locks on the booking row', () => {
    it('FOR KEY SHARE held elsewhere does not block: payment attempts run side by side', async () => {
      const { user, booking } = await pendingBooking(1);

      await db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${booking.id}::uuid FOR KEY SHARE`;
        // Answered while the other transaction still holds its key-share lock.
        expect((await pay(user, booking.id)).status).toBe(201);
      });
    });

    it('FOR UPDATE held elsewhere (a cancel, an expiry) blocks it until that transaction ends', async () => {
      const { user, booking } = await pendingBooking(1);
      let answered = false;
      let pending: Promise<number> | undefined;

      await db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${booking.id}::uuid FOR UPDATE`;
        pending = pay(user, booking.id).then((res) => {
          answered = true;
          return res.status;
        });
        await pause(BLOCKED_MS);
        expect(answered).toBe(false);
      });

      expect(await pending).toBe(201);
    });
  });

  // ─── Concurrency ───

  describe('concurrency', () => {
    it(`cancel vs POST /payments/vnpay, ${RACE_ROUNDS} rounds: no 5xx, no deadlock, one consistent outcome`, async () => {
      const next = random(20_261_111);
      const { showtime, seat } = await scene(4);
      const labels = ['A', 'B', 'C', 'D'].flatMap((row) =>
        Array.from({ length: 12 }, (_, i) => `${row}${i + 1}`),
      );
      const server = captureServerErrors();
      const deadlocksBefore = await deadlocks();
      const outcomes = new Map<string, number>();

      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          clock.set(NOW);
          const seats = labels.slice(round * 2, round * 2 + 2).map(seat);
          const user = await newUser();
          const booking = await held(user, showtime.id, seats);
          const delays = [RACE_CANCEL_MAX_DELAY_MS, RACE_PAY_MAX_DELAY_MS].map((max) =>
            Math.floor(next() * max),
          );

          const [cancelled, paid] = await Promise.all([
            pause(delays[0]!).then(() => cancel(user, booking.id)),
            pause(delays[1]!).then(() => pay(user, booking.id)),
          ]);
          expect(formatServerErrors(server.errors)).toBe('');

          const label = `cancel ${cancelled.status}${cancelled.status === 204 ? '' : ` ${errorOf(cancelled).code}`} / pay ${paid.status}${paid.status === 201 ? '' : ` ${errorOf(paid).code}`}`;
          outcomes.set(label, (outcomes.get(label) ?? 0) + 1);

          const payments = await paymentsOf(booking.id);
          const seatRows = await db.prisma.showtimeSeat.findMany({
            where: { showtimeId: showtime.id, seatId: { in: seats } },
            select: { status: true, bookingId: true },
          });
          if (cancelled.status === 204) {
            // Cancel won: the payment saw the booking EXPIRED and wrote nothing.
            expect(paid.status).toBe(409);
            expect(errorOf(paid).code).toBe('BOOKING_NOT_PAYABLE');
            expect(await bookingStatus(booking.id)).toBe('EXPIRED');
            expect(payments).toEqual([]);
            expect(seatRows).toEqual([
              { status: 'AVAILABLE', bookingId: null },
              { status: 'AVAILABLE', bookingId: null },
            ]);
          } else {
            // Payment won: the cancel saw it and changed nothing.
            expect(cancelled.status).toBe(409);
            expect(errorOf(cancelled).code).toBe('BOOKING_HAS_PAYMENT_IN_PROGRESS');
            expect(paid.status).toBe(201);
            expect(await bookingStatus(booking.id)).toBe('PENDING');
            expect(payments).toEqual([
              expect.objectContaining({
                id: bodyOf<CreatedVnpayPayment>(paid).paymentId,
                status: 'PENDING',
              }),
            ]);
            expect(seatRows).toEqual([
              { status: 'HELD', bookingId: booking.id },
              { status: 'HELD', bookingId: booking.id },
            ]);
          }
        }

        // Backends report their statistics with a delay; give them a moment before reading.
        await pause(1_500);
        const found = (await deadlocks()) - deadlocksBefore;
        console.info(
          `[payment] ${RACE_ROUNDS} rounds: ${JSON.stringify(Object.fromEntries(outcomes))}; deadlocks ${found}`,
        );
        expect(found).toBe(0);
      } finally {
        server.restore();
      }
    }, 60_000);
  });
});
