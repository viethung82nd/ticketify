import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminBooking,
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  type CreatedVnpayPayment,
  DayType,
  type OccupancyReport,
  type Page,
  type RevenueReport,
  Role,
  SeatType,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { VnpayService } from '../../../src/modules/payment/vnpay/vnpay.service';
import { REALTIME_CHANNEL_KEY } from '../../../src/modules/realtime/realtime-redis';
import { appTestEnv } from '../../support/app-env';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { bodyOf, errorOf } from '../../support/http';
import { createTestRedis, type TestRedis } from '../../support/redis';
import { captureServerErrors, formatServerErrors } from '../../support/server-errors';

const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
const SEAT_PRICE = 90_000;
/** Test-only merchant settings; never a real secret. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;
const OK = { RspCode: '00', Message: 'Confirm Success' };

/** An instant given on the cinema's wall clock (UTC+7). */
const vnInstant = (date: string, time: string): string =>
  new Date(`${date}T${time}:00+07:00`).toISOString();

interface TestUser {
  id: string;
  email: string;
}

/**
 * The admin booking list and dashboard (ROADMAP 5.5), against real Postgres: which bookings each
 * filter returns, which bookings count as revenue on which cinema day (midnight in Vietnam, not
 * UTC), and how full each showtime is. Bookings are made and paid through the real API, with the
 * clock set to the minute around the cinema-day boundaries.
 */
describe('Admin bookings and dashboard — GET /admin/bookings, /admin/dashboard/* (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let admin: TestUser;
  const clock = new FakeClock('2026-11-01T03:00:00.000Z');
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
          PAYMENT_RATE_LIMIT_MAX: '1000',
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
    admin = await newUser(Role.ADMIN);
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
    serverErrors = captureServerErrors();
  });
  afterEach(() => {
    serverErrors.restore();
    expect(formatServerErrors(serverErrors.errors)).toBe('');
  });

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const tokenOf = (user: { id: string }, role: Role = Role.USER) =>
    app.get(AccessTokenIssuer).issue({ id: user.id, role }).token;

  let userCounter = 0;
  async function newUser(role: Role = Role.USER, email?: string): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: email ?? `report-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Report User ${userCounter}`,
        role,
      },
    });
    return { id: user.id, email: user.email };
  }

  const asAdmin = (path: string) =>
    http()
      .get(path)
      .set('Authorization', `Bearer ${tokenOf(admin, Role.ADMIN)}`);
  const adminPost = (path: string, body: object) =>
    http()
      .post(path)
      .set('Authorization', `Bearer ${tokenOf(admin, Role.ADMIN)}`)
      .send(body);

  let movieId: string | undefined;
  let roomCounter = 0;
  /** A fresh 1 × `cols` room with one showtime starting at `startsAt` (cinema wall clock). */
  async function scene(date: string, time: string, cols = 6) {
    roomCounter += 1;
    const roomRes = await adminPost('/admin/rooms', {
      name: `Phòng Báo Cáo ${roomCounter}`,
      rows: 1,
      cols,
    });
    expect(roomRes.status).toBe(201);
    const room = bodyOf<AdminRoom>(roomRes);
    movieId ??= (
      await db.prisma.movie.create({
        data: {
          title: 'Report Movie',
          slug: `report-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: new Date('2026-10-01'),
        },
      })
    ).id;
    const showtimeRes = await adminPost('/admin/showtimes', {
      movieId,
      roomId: room.id,
      startsAt: `${date}T${time}:00+07:00`,
    });
    expect(showtimeRes.status).toBe(201);
    const seatIds = new Map(room.seats.map((s) => [s.number, s.id]));
    const seat = (n: number) => {
      const id = seatIds.get(n);
      if (!id) throw new Error(`No seat A${n}`);
      return id;
    };
    return { room, showtime: bodyOf<CreatedShowtime>(showtimeRes), seat };
  }

  async function hold(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
    const res = await http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });
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

  let transactionNo = 15_526_000;
  async function sendIpn(booking: Booking, payment: CreatedVnpayPayment) {
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
    const res = await http()
      .get('/payments/vnpay/ipn')
      .query(Object.fromEntries(new URLSearchParams(query)));
    expect(res.body).toEqual(OK);
  }

  /** Holds `seats` at `at` and pays a minute later: CONFIRMED with confirmedAt = at + 1 min. */
  async function paidBooking(user: TestUser, showtimeId: string, seats: string[], at: string) {
    clock.set(at);
    const booking = await hold(user, showtimeId, seats);
    const payment = await paymentFor(user, booking.id);
    clock.advance({ minutes: 1 });
    await sendIpn(booking, payment);
    return booking;
  }

  const listOf = async (query: string) => {
    const res = await asAdmin(`/admin/bookings${query}`);
    expect(res.status).toBe(200);
    return bodyOf<Page<AdminBooking>>(res);
  };

  // ─── Access ───

  describe('access', () => {
    it.each(['/admin/bookings', '/admin/dashboard/revenue', '/admin/dashboard/occupancy'])(
      '%s: 401 without a token, 403 for a USER and a STAFF',
      async (path) => {
        expect((await http().get(path)).status).toBe(401);
        for (const role of [Role.USER, Role.STAFF]) {
          const res = await http()
            .get(path)
            .set('Authorization', `Bearer ${tokenOf(admin, role)}`);
          expect(res.status).toBe(403);
        }
      },
    );
  });

  // ─── GET /admin/bookings ───

  describe('GET /admin/bookings', () => {
    let alice: TestUser;
    let bob: TestUser;
    let lateEvening: Booking;
    let afterMidnight: Booking;
    let paid: Booking;

    beforeAll(async () => {
      alice = await newUser(Role.USER, `alice-${randomUUID().slice(0, 8)}@report.test`);
      bob = await newUser(Role.USER, `bob_${randomUUID().slice(0, 8)}@report.test`);
      const { showtime, seat } = await scene('2026-11-20', '19:00');
      // 23:59 on Nov 10 and 00:01 on Nov 11 in Vietnam: two cinema days, one UTC day.
      clock.set(vnInstant('2026-11-10', '23:59'));
      lateEvening = await hold(alice, showtime.id, [seat(2), seat(1)]);
      clock.set(vnInstant('2026-11-11', '00:01'));
      afterMidnight = await hold(bob, showtime.id, [seat(3)]);
      paid = await paidBooking(alice, showtime.id, [seat(4)], vnInstant('2026-11-12', '09:00'));
    });

    const ids = (page: Page<AdminBooking>) => page.items.map((item) => item.id);

    it('newest first, with what an admin needs to answer a customer', async () => {
      const page = await listOf('?from=2026-11-10&to=2026-11-12');

      expect(ids(page)).toEqual([paid.id, afterMidnight.id, lateEvening.id]);
      expect(page).toMatchObject({ total: 3, page: 1, pageSize: 20 });
      expect(page.items[2]).toMatchObject({
        code: lateEvening.code,
        status: 'PENDING',
        subtotal: 2 * SEAT_PRICE,
        discount: 0,
        total: 2 * SEAT_PRICE,
        voucherCode: null,
        confirmedAt: null,
        paymentStatus: null,
        user: { id: alice.id, email: alice.email },
        showtime: { movieTitle: 'Report Movie' },
        seatLabels: ['A1', 'A2'],
      });
      expect(page.items[0]).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'SUCCESS' });
      expect(page.items[0]?.confirmedAt).toBe(
        new Date(Date.parse(vnInstant('2026-11-12', '09:00')) + 60_000).toISOString(),
      );
    });

    it('from/to are cinema days: 23:59 and 00:01 in Vietnam fall on different days', async () => {
      expect(ids(await listOf('?from=2026-11-10&to=2026-11-10'))).toEqual([lateEvening.id]);
      expect(ids(await listOf('?from=2026-11-11&to=2026-11-11'))).toEqual([afterMidnight.id]);
      expect(ids(await listOf('?from=2026-11-11&to=2026-11-12'))).toEqual([
        paid.id,
        afterMidnight.id,
      ]);
    });

    it('status filter', async () => {
      const page = await listOf('?from=2026-11-10&to=2026-11-12&status=PENDING');
      expect(ids(page)).toEqual([afterMidnight.id, lateEvening.id]);
    });

    it('q: the booking code exactly in any letter case, or part of the email', async () => {
      expect(ids(await listOf(`?q=${afterMidnight.code.toLowerCase()}`))).toEqual([
        afterMidnight.id,
      ]);
      expect(ids(await listOf(`?q=${encodeURIComponent(' ALICE- ')}`))).toEqual([
        paid.id,
        lateEvening.id,
      ]);
      expect((await listOf(`?q=${afterMidnight.code.slice(0, 5)}`)).total).toBe(0);
    });

    it('q: % and _ are matched as themselves, not as wildcards', async () => {
      expect((await listOf('?q=%25')).total).toBe(0);
      expect(ids(await listOf('?q=bob_'))).toEqual([afterMidnight.id]);
      expect((await listOf('?q=alice_')).total).toBe(0);
    });

    it('pages: pageSize, page, total; past the end is an empty page', async () => {
      const first = await listOf('?from=2026-11-10&to=2026-11-12&pageSize=2');
      const second = await listOf('?from=2026-11-10&to=2026-11-12&pageSize=2&page=2');
      const third = await listOf('?from=2026-11-10&to=2026-11-12&pageSize=2&page=3');

      expect(ids(first)).toEqual([paid.id, afterMidnight.id]);
      expect(ids(second)).toEqual([lateEvening.id]);
      expect(third).toMatchObject({ items: [], total: 3, page: 3 });
    });

    it.each([
      ['from after to', '?from=2026-11-12&to=2026-11-11', 'to'],
      ['an unknown status', '?status=PAID', 'status'],
      ['a malformed date', '?from=2026-11-31', 'from'],
      ['pageSize over 100', '?pageSize=101', 'pageSize'],
      ['an unknown parameter', '?sort=total', 'sort'],
    ])('400 VALIDATION_FAILED for %s', async (_label, query, field) => {
      const res = await asAdmin(`/admin/bookings${query}`);
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [expect.objectContaining({ field })],
      });
    });
  });

  // ─── GET /admin/dashboard/revenue ───

  describe('GET /admin/dashboard/revenue', () => {
    const revenue = async (query: string) => {
      const res = await asAdmin(`/admin/dashboard/revenue${query}`);
      expect(res.status).toBe(200);
      return bodyOf<RevenueReport>(res);
    };

    beforeAll(async () => {
      const { showtime, seat } = await scene('2026-12-20', '19:00', 8);
      const buyer = await newUser();
      // Confirmed 23:59 on Dec 1 and 00:00 on Dec 2 in Vietnam (16:59 and 17:00 UTC, Dec 1).
      await paidBooking(buyer, showtime.id, [seat(1), seat(2)], vnInstant('2026-12-01', '23:58'));
      await paidBooking(buyer, showtime.id, [seat(3)], vnInstant('2026-12-01', '23:59'));
      // Dec 2: one more paid booking, one never paid, one that ends NEEDS_REVIEW.
      await paidBooking(await newUser(), showtime.id, [seat(4)], vnInstant('2026-12-02', '10:00'));
      clock.set(vnInstant('2026-12-02', '11:00'));
      await hold(await newUser(), showtime.id, [seat(5)]);

      // NEEDS_REVIEW: paid after holdUntil, once its seat went to someone else (the new hold
      // takes the run-out hold lazily; no expiry job, so no querydr call).
      const late = await newUser();
      clock.set(vnInstant('2026-12-02', '12:00'));
      const lost = await hold(late, showtime.id, [seat(6)]);
      const lostPayment = await paymentFor(late, lost.id);
      await paidBooking(await newUser(), showtime.id, [seat(6)], vnInstant('2026-12-02', '12:30'));
      clock.set(vnInstant('2026-12-02', '12:40'));
      await sendIpn(lost, lostPayment);
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe(
        'NEEDS_REVIEW',
      );
    });

    it('one row per cinema day, zeros included; midnight is Vietnam midnight', async () => {
      const report = await revenue('?from=2026-11-30&to=2026-12-03');

      expect(report).toMatchObject({
        from: '2026-11-30',
        to: '2026-12-03',
        timeZone: 'Asia/Ho_Chi_Minh',
      });
      expect(report.days).toEqual([
        { date: '2026-11-30', revenue: 0, bookings: 0, tickets: 0 },
        // Confirmed at 23:59: two seats.
        { date: '2026-12-01', revenue: 2 * SEAT_PRICE, bookings: 1, tickets: 2 },
        // Confirmed at 00:00 (1 seat), 10:01 (1 seat) and 12:31 (1 seat, the seat lost by the
        // booking that went to review). Not the PENDING one, not the NEEDS_REVIEW one.
        { date: '2026-12-02', revenue: 3 * SEAT_PRICE, bookings: 3, tickets: 3 },
        { date: '2026-12-03', revenue: 0, bookings: 0, tickets: 0 },
      ]);
      expect(report.totals).toEqual({ revenue: 5 * SEAT_PRICE, bookings: 4, tickets: 5 });
    });

    it('defaults: the last 7 days up to today; from alone gives 7 days from it', async () => {
      clock.set(vnInstant('2026-12-03', '08:00'));
      const byDefault = await revenue('');
      expect(byDefault).toMatchObject({ from: '2026-11-27', to: '2026-12-03' });
      expect(byDefault.days).toHaveLength(7);
      expect(byDefault.totals.revenue).toBe(5 * SEAT_PRICE);

      const fromOnly = await revenue('?from=2026-12-02');
      expect(fromOnly).toMatchObject({ from: '2026-12-02', to: '2026-12-08' });
      const toOnly = await revenue('?to=2026-12-01');
      expect(toOnly).toMatchObject({ from: '2026-11-25', to: '2026-12-01' });
    });

    it('31 days at most', async () => {
      expect((await revenue('?from=2026-11-01&to=2026-12-01')).days).toHaveLength(31);
      const res = await asAdmin('/admin/dashboard/revenue?from=2026-11-01&to=2026-12-02');
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [expect.objectContaining({ field: 'to' })],
      });
    });

    it('400 for from after to and for a malformed date', async () => {
      for (const query of ['?from=2026-12-02&to=2026-12-01', '?to=2026-12-32']) {
        const res = await asAdmin(`/admin/dashboard/revenue${query}`);
        expect({ query, status: res.status }).toEqual({ query, status: 400 });
      }
    });
  });

  // ─── GET /admin/dashboard/occupancy ───

  describe('GET /admin/dashboard/occupancy', () => {
    const occupancy = async (query: string) => {
      const res = await asAdmin(`/admin/dashboard/occupancy${query}`);
      expect(res.status).toBe(200);
      return bodyOf<OccupancyReport>(res);
    };

    it('showtimes of the cinema day: sellable seats, sold, held by a live hold only', async () => {
      // Two showtimes on Jan 5: 00:30 in Vietnam is still Jan 5 (17:30 UTC, Jan 4).
      const early = await scene('2027-01-05', '00:30', 4);
      const evening = await scene('2027-01-05', '20:00', 8);
      const nextDay = await scene('2027-01-06', '09:00', 4);
      const buyer = await newUser();
      await paidBooking(
        buyer,
        evening.showtime.id,
        [evening.seat(1), evening.seat(2)],
        vnInstant('2027-01-04', '10:00'),
      );
      clock.set(vnInstant('2027-01-04', '10:10'));
      await hold(await newUser(), evening.showtime.id, [evening.seat(3)]);
      clock.set(vnInstant('2027-01-04', '09:50'));
      // This hold has run out by 10:10 + a minute: HELD in the table, but not counted.
      await hold(await newUser(), evening.showtime.id, [evening.seat(4)]);
      clock.set(vnInstant('2027-01-04', '10:11'));

      const report = await occupancy('?date=2027-01-05');
      expect(report.date).toBe('2027-01-05');
      expect(report.showtimes.map((s) => s.id)).toEqual([early.showtime.id, evening.showtime.id]);
      expect(report.showtimes[0]).toMatchObject({
        totalSeats: 4,
        soldSeats: 0,
        heldSeats: 0,
        occupancy: 0,
        status: 'SCHEDULED',
        roomName: early.room.name,
      });
      expect(report.showtimes[1]).toMatchObject({
        totalSeats: 8,
        soldSeats: 2,
        heldSeats: 1,
        occupancy: 0.25,
      });
      expect(report.showtimes.some((s) => s.id === nextDay.showtime.id)).toBe(false);
    });

    it('today by default; a day without showtimes is an empty list', async () => {
      clock.set(vnInstant('2027-02-10', '12:00'));
      expect(await occupancy('')).toEqual({ date: '2027-02-10', showtimes: [] });
    });

    it('400 for a malformed date', async () => {
      const res = await asAdmin('/admin/dashboard/occupancy?date=10-02-2027');
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });
  });
});
