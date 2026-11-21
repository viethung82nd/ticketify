import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  type CreatedVnpayPayment,
  DayType,
  Role,
  SeatType,
  VOUCHER_LIMITS,
  type VoucherUsageStatus,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Prisma } from '../../../src/generated/prisma/client';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../../src/modules/bookings/booking-expiry.service';
import { VnpayService } from '../../../src/modules/payment/vnpay/vnpay.service';
import { REALTIME_CHANNEL_KEY } from '../../../src/modules/realtime/realtime-redis';
import { appTestEnv } from '../../support/app-env';
import { createTestDatabase, type TestDatabase } from '../../support/database';
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
/** Every seat type and day type: two seats are 180 000 ₫. */
const SEAT_PRICE = 90_000;
const FLOOR = VOUCHER_LIMITS.payableTotalMin;
/** Test-only merchant settings; never a real secret. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;
const OK = { RspCode: '00', Message: 'Confirm Success' };

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();

interface TestUser {
  id: string;
}

/**
 * Voucher use through a booking's whole life (ROADMAP 5.2): reserved in the hold transaction,
 * CONSUMED when the payment confirms it, RELEASED when it expires, is cancelled or goes to review.
 * After every test the whole-database payment invariants must hold, voucher rules included.
 * The race for the last use is 5.3.
 */
describe('Voucher on a booking — POST /bookings voucherCode (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminId: string;
  const clock = new FakeClock(NOW);
  const vnpay = new VnpayService();
  const channelKey = `ticketify-test:${randomUUID()}`;
  let serverErrors: ReturnType<typeof captureServerErrors>;

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
          BOOKING_RATE_LIMIT_MAX: '1000',
          PAYMENT_RATE_LIMIT_MAX: '100',
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
          fullName: 'Voucher Admin',
          role: Role.ADMIN,
        },
      })
    ).id;
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: SEAT_PRICE })),
      ),
    });

    const { WorkerModule } = await import('../../../src/worker.module.js');
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(SWEEP_INTERVAL_MS)
      .useValue(0)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    expiry = workerRef.get(BookingExpiryService);
  });

  afterAll(async () => {
    await workerRef?.close();
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => {
    clock.set(NOW);
    serverErrors = captureServerErrors();
  });
  afterEach(async () => {
    serverErrors.restore();
    expect(formatServerErrors(serverErrors.errors)).toBe('');
    expect(await paymentViolations(db.prisma)).toEqual(NO_PAYMENT_VIOLATIONS);
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const tokenOf = (user: TestUser, role: Role = Role.USER) =>
    app.get(AccessTokenIssuer).issue({ id: user.id, role }).token;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `voucher-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Voucher User ${userCounter}`,
      },
    });
    return { id: user.id };
  }

  const admin = (path: string, body: object) =>
    http()
      .post(path)
      .set('Authorization', `Bearer ${tokenOf({ id: adminId }, Role.ADMIN)}`)
      .send(body);

  let movieId: string | undefined;
  let counter = 0;
  /** Fresh 1 × 8 room with one upcoming showtime; `seat('A1')` gives a seat id. */
  async function scene() {
    counter += 1;
    const roomRes = await admin('/admin/rooms', {
      name: `Phòng Voucher ${counter}`,
      rows: 1,
      cols: 8,
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
          title: 'Voucher Movie',
          slug: `voucher-movie-${randomUUID()}`,
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

  let codeCounter = 0;
  /** A voucher in effect around NOW: 20 % capped at 30 000 ₫, 1 use per user, by default. */
  async function voucher(overrides: Partial<Prisma.VoucherCreateInput> = {}) {
    codeCounter += 1;
    return db.prisma.voucher.create({
      data: {
        code: `TEST${codeCounter}${randomUUID().slice(0, 6).replace(/-/g, '').toUpperCase()}`,
        discountType: 'PERCENT',
        discountValue: 20,
        maxDiscount: 30_000,
        minSubtotal: 0,
        usageLimit: null,
        perUserLimit: 1,
        startsAt: instant('2026-10-01T00:00:00.000Z'),
        endsAt: instant('2026-12-01T00:00:00.000Z'),
        ...overrides,
      },
    });
  }

  interface HoldBody {
    showtimeId: string;
    seatIds: string[];
    voucherCode?: unknown;
  }

  const hold = (user: TestUser, body: HoldBody, key: string = randomUUID()) =>
    http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', key)
      .send(body);

  async function held(user: TestUser, body: HoldBody): Promise<Booking> {
    const res = await hold(user, body);
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  async function paymentFor(user: TestUser, bookingId: string): Promise<CreatedVnpayPayment> {
    const res = await http()
      .post('/payments/vnpay')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .send({ bookingId });
    expect(res.status).toBe(201);
    return bodyOf<CreatedVnpayPayment>(res);
  }

  let transactionNo = 15_226_000;
  /** The successful IPN VNPay would send for this payment of this booking, correctly signed. */
  function sendIpn(booking: Booking, payment: CreatedVnpayPayment) {
    transactionNo += 1;
    const query = vnpay.buildSignedQuery(
      {
        vnp_Amount: String(booking.total * 100),
        vnp_BankCode: 'NCB',
        vnp_OrderInfo: `Thanh toan ve ${booking.code}`,
        vnp_PayDate: '20261101170500',
        vnp_ResponseCode: '00',
        vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
        vnp_TransactionNo: String(transactionNo),
        vnp_TransactionStatus: '00',
        vnp_TxnRef: payment.txnRef,
      },
      VNPAY_ENV.VNPAY_HASH_SECRET,
    );
    return http()
      .get('/payments/vnpay/ipn')
      .query(Object.fromEntries(new URLSearchParams(query)));
  }

  const usesOf = (voucherId: string) =>
    db.prisma.voucherUsage.findMany({
      where: { voucherId },
      select: { bookingId: true, userId: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
  const useOf = async (bookingId: string): Promise<VoucherUsageStatus | undefined> =>
    (await db.prisma.voucherUsage.findUnique({ where: { bookingId }, select: { status: true } }))
      ?.status;

  /** Nothing of a refused hold may exist: no booking, no seat held, no use. */
  async function expectNothingWritten(showtimeId: string, voucherId?: string) {
    expect(await db.prisma.booking.count({ where: { showtimeId } })).toBe(0);
    expect(
      await db.prisma.showtimeSeat.count({ where: { showtimeId, status: { not: 'AVAILABLE' } } }),
    ).toBe(0);
    if (voucherId) expect(await usesOf(voucherId)).toEqual([]);
  }

  // ─── Discount ───

  describe('201: the API computes the discount and reserves one use', () => {
    it('PERCENT with a cap: 20 % of 180 000 = 36 000, capped at 30 000; one RESERVED use', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher({ discountType: 'PERCENT', discountValue: 20, maxDiscount: 30_000 });
      const user = await newUser();

      const booking = await held(user, {
        showtimeId: showtime.id,
        seatIds: [seat('A1'), seat('A2')],
        // Trimmed and upper-cased by the API, like the admin form.
        voucherCode: `  ${v.code.toLowerCase()} `,
      });

      expect(booking).toMatchObject({
        status: 'PENDING',
        subtotal: 180_000,
        discount: 30_000,
        total: 150_000,
        voucherCode: v.code,
      });
      expect(await usesOf(v.id)).toEqual([
        { bookingId: booking.id, userId: user.id, status: 'RESERVED' },
      ]);
      const stored = await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(stored).toMatchObject({ subtotal: 180_000, discount: 30_000, total: 150_000 });
      // Every read of the booking shows the voucher, not only the hold answer.
      const read = await http()
        .get(`/bookings/${booking.id}`)
        .set('Authorization', `Bearer ${tokenOf(user)}`);
      expect(bodyOf<Booking>(read)).toMatchObject({ voucherCode: v.code, discount: 30_000 });
    });

    it('PERCENT under its cap, rounded down: 15 % of 90 000 = 13 500', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher({ discountValue: 15, maxDiscount: 30_000 });

      const booking = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: v.code,
      });
      expect(booking).toMatchObject({ subtotal: 90_000, discount: 13_500, total: 76_500 });
    });

    it('FIXED: 20 000 off', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher({ discountType: 'FIXED', discountValue: 20_000, maxDiscount: null });

      const booking = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1'), seat('A2')],
        voucherCode: v.code,
      });
      expect(booking).toMatchObject({ subtotal: 180_000, discount: 20_000, total: 160_000 });
    });

    it(`FIXED above the subtotal and 100 % both stop at a payable ${FLOOR} ₫`, async () => {
      const { showtime, seat } = await scene();
      const big = await voucher({
        discountType: 'FIXED',
        discountValue: 500_000,
        maxDiscount: null,
      });
      const all = await voucher({ discountValue: 100, maxDiscount: null });

      const fixed = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: big.code,
      });
      const percent = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A2')],
        voucherCode: all.code,
      });

      for (const booking of [fixed, percent]) {
        expect(booking).toMatchObject({ subtotal: 90_000, discount: 90_000 - FLOOR, total: FLOOR });
      }
      // And the booking can be paid: the payment is created for exactly that total.
      const user = await db.prisma.booking.findUniqueOrThrow({ where: { id: fixed.id } });
      const payment = await paymentFor({ id: user.userId }, fixed.id);
      expect(
        (await db.prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).amount,
      ).toBe(FLOOR);
    });

    it('a hold without a voucher is unchanged: no discount, no use, voucherCode null', async () => {
      const { showtime, seat } = await scene();
      const booking = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
      });
      expect(booking).toMatchObject({ discount: 0, total: 90_000, voucherCode: null });
      expect(await useOf(booking.id)).toBeUndefined();
    });

    it('RELEASED uses do not count: a use given back by an expired booking can be taken again', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher({ usageLimit: 1, perUserLimit: 1 });
      const user = await newUser();
      const first = await held(user, {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: v.code,
      });
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(first.id)).resolves.toMatchObject({ outcome: 'expired' });

      // The same user, the only use of the voucher: both limits count only RESERVED + CONSUMED.
      const second = await held(user, {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: v.code,
      });
      expect(second.discount).toBeGreaterThan(0);
      expect((await usesOf(v.id)).map((u) => u.status)).toEqual(['RELEASED', 'RESERVED']);
    });
  });

  // ─── Refusals: nothing is written ───

  describe('refused: nothing is written (no booking, no seat held, no use)', () => {
    it('400 VALIDATION_FAILED for a malformed code, before any database work', async () => {
      const { showtime, seat } = await scene();
      for (const voucherCode of ['ABC', 'SUMMER-10', 42]) {
        const res = await hold(await newUser(), {
          showtimeId: showtime.id,
          seatIds: [seat('A1')],
          voucherCode,
        });
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      await expectNothingWritten(showtime.id);
    });

    it('422 VOUCHER_NOT_AVAILABLE: unknown code, and switched-off voucher alike', async () => {
      const { showtime, seat } = await scene();
      const off = await voucher({ isActive: false });

      for (const voucherCode of ['NOSUCHCODE', off.code]) {
        const res = await hold(await newUser(), {
          showtimeId: showtime.id,
          seatIds: [seat('A1')],
          voucherCode,
        });
        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({ code: 'VOUCHER_NOT_AVAILABLE' });
        expect(errorOf(res).details).toBeUndefined();
      }
      await expectNothingWritten(showtime.id, off.id);
    });

    it('422 VOUCHER_NOT_IN_EFFECT before startsAt and from endsAt on (details: the period)', async () => {
      const { showtime, seat } = await scene();
      const later = await voucher({
        startsAt: instant('2026-11-01T10:00:00.001Z'),
        endsAt: instant('2026-12-01T00:00:00.000Z'),
      });
      const over = await voucher({
        startsAt: instant('2026-10-01T00:00:00.000Z'),
        endsAt: instant(NOW),
      });

      for (const v of [later, over]) {
        const res = await hold(await newUser(), {
          showtimeId: showtime.id,
          seatIds: [seat('A1')],
          voucherCode: v.code,
        });
        expect(res.status).toBe(422);
        expect(errorOf(res)).toMatchObject({
          code: 'VOUCHER_NOT_IN_EFFECT',
          details: { startsAt: v.startsAt.toISOString(), endsAt: v.endsAt.toISOString() },
        });
        await expectNothingWritten(showtime.id, v.id);
      }
    });

    it('422 VOUCHER_MIN_SUBTOTAL_NOT_MET with details.minSubtotal and the subtotal', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher({ minSubtotal: 180_000 });

      const res = await hold(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: v.code,
      });
      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'VOUCHER_MIN_SUBTOTAL_NOT_MET',
        details: { minSubtotal: 180_000, subtotal: 90_000 },
      });
      await expectNothingWritten(showtime.id, v.id);

      // Exactly the minimum is enough.
      const ok = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1'), seat('A2')],
        voucherCode: v.code,
      });
      expect(ok.discount).toBe(30_000);
    });

    it('409 VOUCHER_USAGE_LIMIT_REACHED once every use is RESERVED or CONSUMED (details.usageLimit)', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher({ usageLimit: 1, perUserLimit: null });
      const first = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: v.code,
      });

      const res = await hold(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A2')],
        voucherCode: v.code,
      });
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'VOUCHER_USAGE_LIMIT_REACHED',
        details: { usageLimit: 1 },
      });
      // Only the first booking exists, with the one use.
      expect(await db.prisma.booking.count({ where: { showtimeId: showtime.id } })).toBe(1);
      expect(
        (
          await db.prisma.showtimeSeat.findFirstOrThrow({
            where: { showtimeId: showtime.id, seatId: seat('A2') },
          })
        ).status,
      ).toBe('AVAILABLE');
      expect(await usesOf(v.id)).toEqual([
        expect.objectContaining({ bookingId: first.id, status: 'RESERVED' }),
      ]);
    });

    it('409 VOUCHER_USER_LIMIT_REACHED: a CONSUMED use on another showtime counts (details.perUserLimit)', async () => {
      const v = await voucher({ usageLimit: null, perUserLimit: 1 });
      const user = await newUser();
      const a = await scene();
      const paid = await held(user, {
        showtimeId: a.showtime.id,
        seatIds: [a.seat('A1')],
        voucherCode: v.code,
      });
      expect((await sendIpn(paid, await paymentFor(user, paid.id))).body).toEqual(OK);
      expect(await useOf(paid.id)).toBe('CONSUMED');

      const b = await scene();
      const res = await hold(user, {
        showtimeId: b.showtime.id,
        seatIds: [b.seat('A1')],
        voucherCode: v.code,
      });
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'VOUCHER_USER_LIMIT_REACHED',
        details: { perUserLimit: 1 },
      });
      await expectNothingWritten(b.showtime.id);
      expect(await usesOf(v.id)).toHaveLength(1);

      // Another user still can.
      const other = await held(await newUser(), {
        showtimeId: b.showtime.id,
        seatIds: [b.seat('A1')],
        voucherCode: v.code,
      });
      expect(other.discount).toBeGreaterThan(0);
    });

    it('seat problems come first: a taken seat is 409 SEAT_UNAVAILABLE even with a bad voucher', async () => {
      const { showtime, seat } = await scene();
      await held(await newUser(), { showtimeId: showtime.id, seatIds: [seat('A1')] });

      const res = await hold(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: 'NOSUCHCODE',
      });
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('SEAT_UNAVAILABLE');
    });
  });

  // ─── Idempotency ───

  describe('Idempotency-Key with a voucher', () => {
    it('same key, same voucher (any letter case) → 200 with the same booking, still one use', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher();
      const user = await newUser();
      const key = randomUUID();
      const body = { showtimeId: showtime.id, seatIds: [seat('A1')], voucherCode: v.code };

      const first = await hold(user, body, key);
      const again = await hold(user, { ...body, voucherCode: v.code.toLowerCase() }, key);

      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(bodyOf<Booking>(again)).toEqual(bodyOf<Booking>(first));
      expect(await usesOf(v.id)).toHaveLength(1);
    });

    it('same key, another voucher or none → 422 IDEMPOTENCY_KEY_REUSED, nothing more written', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher();
      const w = await voucher();
      const user = await newUser();
      const key = randomUUID();
      const body = { showtimeId: showtime.id, seatIds: [seat('A1')] };

      expect((await hold(user, { ...body, voucherCode: v.code }, key)).status).toBe(201);
      for (const changed of [{ ...body, voucherCode: w.code }, body]) {
        const res = await hold(user, changed, key);
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
      }
      expect(await db.prisma.booking.count({ where: { showtimeId: showtime.id } })).toBe(1);
      expect(await usesOf(v.id)).toHaveLength(1);
      expect(await usesOf(w.id)).toEqual([]);
    });

    it('same key first without a voucher, then with one → 422 as well', async () => {
      const { showtime, seat } = await scene();
      const v = await voucher();
      const user = await newUser();
      const key = randomUUID();
      const body = { showtimeId: showtime.id, seatIds: [seat('A1')] };

      expect((await hold(user, body, key)).status).toBe(201);
      const res = await hold(user, { ...body, voucherCode: v.code }, key);
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await usesOf(v.id)).toEqual([]);
    });
  });

  // ─── The use follows the booking ───

  describe('the use follows the booking', () => {
    async function bookedWith(v: { code: string }, seats = ['A1']) {
      const { showtime, seat } = await scene();
      const user = await newUser();
      const booking = await held(user, {
        showtimeId: showtime.id,
        seatIds: seats.map(seat),
        voucherCode: v.code,
      });
      return { user, booking, showtime, seat };
    }

    it('expiry: RESERVED → RELEASED with the booking, and the use is free for someone else', async () => {
      const v = await voucher({ usageLimit: 1, perUserLimit: null });
      const { booking, showtime, seat } = await bookedWith(v);
      const blocked = await hold(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A2')],
        voucherCode: v.code,
      });
      expect(errorOf(blocked).code).toBe('VOUCHER_USAGE_LIMIT_REACHED');

      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      expect(await useOf(booking.id)).toBe('RELEASED');

      const next = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A2')],
        voucherCode: v.code,
      });
      expect(await useOf(next.id)).toBe('RESERVED');
    });

    it('a second expiry of the same booking changes nothing (noop)', async () => {
      const v = await voucher();
      const { booking } = await bookedWith(v);
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      await expect(expiry.expire(booking.id)).resolves.toEqual({ outcome: 'noop' });
      expect(await useOf(booking.id)).toBe('RELEASED');
    });

    it('cancel (DELETE /bookings/:id): RESERVED → RELEASED, the use is free again', async () => {
      const v = await voucher({ usageLimit: 1, perUserLimit: 1 });
      const { user, booking, showtime, seat } = await bookedWith(v);

      const res = await http()
        .delete(`/bookings/${booking.id}`)
        .set('Authorization', `Bearer ${tokenOf(user)}`);
      expect(res.status).toBe(204);
      expect(await useOf(booking.id)).toBe('RELEASED');

      const again = await held(user, {
        showtimeId: showtime.id,
        seatIds: [seat('A1')],
        voucherCode: v.code,
      });
      expect(again.voucherCode).toBe(v.code);
    });

    it('payment: the IPN charges the discounted total and turns the use CONSUMED', async () => {
      const v = await voucher({ discountValue: 20, maxDiscount: 30_000 });
      const { user, booking } = await bookedWith(v, ['A1', 'A2']);
      const payment = await paymentFor(user, booking.id);
      expect(
        (await db.prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).amount,
      ).toBe(150_000);

      expect((await sendIpn(booking, payment)).body).toEqual(OK);
      expect(
        (await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status,
      ).toBe('CONFIRMED');
      expect(await useOf(booking.id)).toBe('CONSUMED');
    });

    it('review from PENDING: a seat lost after holdUntil → NEEDS_REVIEW, the use is RELEASED', async () => {
      const v = await voucher();
      const { user, booking, showtime, seat } = await bookedWith(v);
      const payment = await paymentFor(user, booking.id);
      // Past holdUntil, not yet expired: another hold takes the seat (lazy expiry).
      clock.advance({ minutes: HOLD_MINUTES });
      await held(await newUser(), { showtimeId: showtime.id, seatIds: [seat('A1')] });

      expect((await sendIpn(booking, payment)).body).toEqual(OK);
      expect(
        (await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status,
      ).toBe('NEEDS_REVIEW');
      expect(await useOf(booking.id)).toBe('RELEASED');
    });

    it('review from EXPIRED: the use the expiry released stays RELEASED', async () => {
      const v = await voucher();
      const { user, booking, showtime, seat } = await bookedWith(v);
      const payment = await paymentFor(user, booking.id);
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      await held(await newUser(), { showtimeId: showtime.id, seatIds: [seat('A1')] });

      expect((await sendIpn(booking, payment)).body).toEqual(OK);
      expect(
        (await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status,
      ).toBe('NEEDS_REVIEW');
      expect(await useOf(booking.id)).toBe('RELEASED');
    });

    it('late payment of an EXPIRED booking (branch B): the use is taken back, even over the limit', async () => {
      const v = await voucher({ usageLimit: 1, perUserLimit: null });
      const { user, booking, showtime, seat } = await bookedWith(v);
      const payment = await paymentFor(user, booking.id);
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      // Meanwhile someone else takes the only use, on another seat.
      const rival = await held(await newUser(), {
        showtimeId: showtime.id,
        seatIds: [seat('A2')],
        voucherCode: v.code,
      });

      // The money came in at the discounted total: the booking is confirmed with its use.
      expect((await sendIpn(booking, payment)).body).toEqual(OK);
      expect(
        (await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status,
      ).toBe('CONFIRMED');
      expect(await useOf(booking.id)).toBe('CONSUMED');
      expect(await useOf(rival.id)).toBe('RESERVED');
      // Documented consequence (ROADMAP "Đã chốt", awaiting review): one use over usageLimit.
      expect(
        await db.prisma.voucherUsage.count({
          where: { voucherId: v.id, status: { in: ['RESERVED', 'CONSUMED'] } },
        }),
      ).toBe(2);
    });
  });
});
