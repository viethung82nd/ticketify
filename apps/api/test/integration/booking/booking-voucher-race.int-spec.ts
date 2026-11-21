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
  type VoucherUsageStatus,
} from '@ticketify/shared';
import request, { type Response } from 'supertest';
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
/** Every seat type and day type: one seat is 90 000 ₫. */
const SEAT_PRICE = 90_000;
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

/** `[T, T, …]` of length N, so that destructuring `newUsers(3)` is typed without `undefined`. */
type Tuple<T, N extends number, R extends T[] = []> = R['length'] extends N
  ? R
  : Tuple<T, N, [T, ...R]>;

/** `{ "201": 1, "409 VOUCHER_USAGE_LIMIT_REACHED": 19 }`: what a crowd of holds got back. */
function tally(responses: readonly Response[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const res of responses) {
    const key = res.status === 201 ? '201' : `${res.status} ${errorOf(res).code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Contention on a voucher's uses (ROADMAP 5.3, PLAN §6 and §4): many holds racing for the last
 * use, one user racing themselves past `perUserLimit`, an expiry giving a use back while someone
 * asks for it, the voucher row locked past VOUCHER_LOCK_TIMEOUT_MS, and a client that edits the
 * payload to set its own price. The voucher row's FOR UPDATE lock is the only thing that orders
 * these holds; whatever the timing, the whole-database invariants must hold after every test.
 * The single-request rules are in booking-voucher.int-spec.ts (5.2).
 */
describe('Voucher contention — the last use, per-user limits, give-back, tampering (real Postgres + Redis)', () => {
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
    // The production pool (10): fewer connections than racing holds, so some wait for one.
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
          fullName: 'Voucher Race Admin',
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

  async function newUsers<N extends number>(count: N): Promise<Tuple<TestUser, N>> {
    const emails = Array.from({ length: count }, () => `race-${randomUUID()}@test.local`);
    await db.prisma.user.createMany({
      data: emails.map((email) => ({ email, passwordHash: 'not-a-real-hash', fullName: 'Race' })),
    });
    const users = await db.prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    expect(users).toHaveLength(count);
    return users as Tuple<TestUser, N>;
  }
  const newUser = async (): Promise<TestUser> => (await newUsers(1))[0];

  const admin = (path: string, body: object) =>
    http()
      .post(path)
      .set('Authorization', `Bearer ${tokenOf({ id: adminId }, Role.ADMIN)}`)
      .send(body);

  let movieId: string | undefined;
  let counter = 0;
  /** Fresh 1 × `cols` room with one upcoming showtime; `seat(n)` is the id of seat A`n`. */
  async function scene(cols = 8) {
    counter += 1;
    const roomRes = await admin('/admin/rooms', { name: `Phòng Đua ${counter}`, rows: 1, cols });
    expect(roomRes.status).toBe(201);
    const room = bodyOf<AdminRoom>(roomRes);
    const ids = new Map(room.seats.map((s) => [s.number, s.id]));
    const seat = (n: number) => {
      const id = ids.get(n);
      if (!id) throw new Error(`No seat A${n}`);
      return id;
    };
    movieId ??= (
      await db.prisma.movie.create({
        data: {
          title: 'Voucher Race Movie',
          slug: `voucher-race-movie-${randomUUID()}`,
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
  /** A voucher in effect around NOW: 20 % capped at 30 000 ₫, no limits unless overridden. */
  async function voucher(overrides: Partial<Prisma.VoucherCreateInput> = {}) {
    codeCounter += 1;
    return db.prisma.voucher.create({
      data: {
        code: `RACE${codeCounter}${randomUUID().slice(0, 6).replace(/-/g, '').toUpperCase()}`,
        discountType: 'PERCENT',
        discountValue: 20,
        maxDiscount: 30_000,
        minSubtotal: 0,
        usageLimit: null,
        perUserLimit: null,
        startsAt: instant('2026-10-01T00:00:00.000Z'),
        endsAt: instant('2026-12-01T00:00:00.000Z'),
        ...overrides,
      },
    });
  }

  const hold = (user: TestUser, body: object, key: string = randomUUID()) =>
    http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', key)
      .send(body);

  async function held(user: TestUser, body: object): Promise<Booking> {
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

  let transactionNo = 15_326_000;
  /** A successful IPN for this payment, correctly signed, for `amount` ₫ (default: the total). */
  function sendIpn(booking: Booking, payment: CreatedVnpayPayment, amount = booking.total) {
    transactionNo += 1;
    const query = vnpay.buildSignedQuery(
      {
        vnp_Amount: String(amount * 100),
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
  /** Uses that count against the limits: RESERVED and CONSUMED. */
  const activeUses = async (voucherId: string) =>
    (await usesOf(voucherId)).filter((use) => use.status !== 'RELEASED');

  /**
   * Every refused hold of a race left nothing behind: the only bookings of these showtimes are the
   * winners', each with its own use, and every seat not theirs is still AVAILABLE.
   */
  async function expectOnlyWinnersWritten(showtimeIds: string[], winners: Booking[]) {
    const bookings = await db.prisma.booking.findMany({
      where: { showtimeId: { in: showtimeIds } },
      select: { id: true },
    });
    expect(bookings.map((b) => b.id).sort()).toEqual(winners.map((b) => b.id).sort());
    const taken = await db.prisma.showtimeSeat.findMany({
      where: { showtimeId: { in: showtimeIds }, status: { not: 'AVAILABLE' } },
      select: { bookingId: true },
    });
    expect(taken.map((s) => s.bookingId).sort()).toEqual(
      winners.flatMap((b) => b.seats.map(() => b.id)).sort(),
    );
    for (const winner of winners) expect(await useOf(winner.id)).toBe('RESERVED');
  }

  // ─── The last use ───

  describe('many holds race for the last uses', () => {
    it('usageLimit 1, 20 users at once, 10 rounds: exactly one 201, 19 × 409 VOUCHER_USAGE_LIMIT_REACHED', async () => {
      const rounds: Record<string, number>[] = [];
      for (let round = 0; round < 10; round++) {
        const { showtime, seat } = await scene(20);
        const v = await voucher({ usageLimit: 1 });
        const users = await newUsers(20);
        // A seat each: no seat conflict, only the voucher row orders them.
        const responses = await Promise.all(
          users.map((user, i) =>
            hold(user, { showtimeId: showtime.id, seatIds: [seat(i + 1)], voucherCode: v.code }),
          ),
        );
        rounds.push(tally(responses));

        expect({ round, tally: tally(responses) }).toEqual({
          round,
          tally: { '201': 1, '409 VOUCHER_USAGE_LIMIT_REACHED': 19 },
        });
        const at = responses.findIndex((res) => res.status === 201);
        const winner = bodyOf<Booking>(responses[at]!);
        expect(winner.discount).toBe(18_000);
        expect(await activeUses(v.id)).toEqual([
          { bookingId: winner.id, userId: users[at]!.id, status: 'RESERVED' },
        ]);
        await expectOnlyWinnersWritten([showtime.id], [winner]);
      }
      console.info(`[5.3] 20 holds for 1 use × 10 rounds: ${JSON.stringify(rounds)}`);
    }, 120_000);

    it('usageLimit 5 with 2 already CONSUMED and 1 RELEASED, 12 users at once: exactly 3 win', async () => {
      const v = await voucher({ usageLimit: 5 });
      // History: two paid bookings keep their use, one expired booking gave its use back.
      const past = await scene();
      const [payer1, payer2, quitter] = await newUsers(3);
      for (const [i, payer] of [payer1, payer2].entries()) {
        const booking = await held(payer, {
          showtimeId: past.showtime.id,
          seatIds: [past.seat(i + 1)],
          voucherCode: v.code,
        });
        expect((await sendIpn(booking, await paymentFor(payer, booking.id))).body).toEqual(OK);
      }
      const gone = await held(quitter, {
        showtimeId: past.showtime.id,
        seatIds: [past.seat(3)],
        voucherCode: v.code,
      });
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(gone.id)).resolves.toMatchObject({ outcome: 'expired' });
      expect((await usesOf(v.id)).map((use) => use.status)).toEqual([
        'CONSUMED',
        'CONSUMED',
        'RELEASED',
      ]);

      const { showtime, seat } = await scene(12);
      const users = await newUsers(12);
      const responses = await Promise.all(
        users.map((user, i) =>
          hold(user, { showtimeId: showtime.id, seatIds: [seat(i + 1)], voucherCode: v.code }),
        ),
      );

      expect(tally(responses)).toEqual({ '201': 3, '409 VOUCHER_USAGE_LIMIT_REACHED': 9 });
      const winners = responses.filter((res) => res.status === 201).map((r) => bodyOf<Booking>(r));
      expect(await activeUses(v.id)).toHaveLength(5);
      await expectOnlyWinnersWritten([showtime.id], winners);
    }, 60_000);

    it('holds without the voucher are not held up by the race: they all succeed alongside it', async () => {
      const { showtime, seat } = await scene(16);
      const v = await voucher({ usageLimit: 1 });
      const users = await newUsers(16);
      const responses = await Promise.all(
        users.map((user, i) =>
          hold(user, {
            showtimeId: showtime.id,
            seatIds: [seat(i + 1)],
            // Every other user asks for the voucher.
            ...(i % 2 === 0 ? { voucherCode: v.code } : {}),
          }),
        ),
      );

      expect(tally(responses)).toEqual({ '201': 9, '409 VOUCHER_USAGE_LIMIT_REACHED': 7 });
      const plain = responses.filter((_, i) => i % 2 === 1);
      expect(plain.every((res) => res.status === 201)).toBe(true);
      for (const res of plain) expect(bodyOf<Booking>(res)).toMatchObject({ discount: 0 });
      expect(await activeUses(v.id)).toHaveLength(1);
    }, 60_000);
  });

  // ─── Per-user limit ───

  describe('one user races themselves past perUserLimit', () => {
    /** `count` showtimes, each in its own room: one user may hold one booking per showtime. */
    async function showtimes(count: number) {
      return Promise.all(Array.from({ length: count }, () => scene()));
    }

    it('perUserLimit 1, one user holds 5 showtimes at once, 10 rounds: exactly one 201, 4 × 409 VOUCHER_USER_LIMIT_REACHED', async () => {
      const rounds: Record<string, number>[] = [];
      for (let round = 0; round < 10; round++) {
        const scenes = await showtimes(5);
        const v = await voucher({ perUserLimit: 1 });
        const user = await newUser();
        // Different showtimes: the (user, showtime) advisory lock and the one-PENDING rule do not
        // order these, only the voucher row does.
        const responses = await Promise.all(
          scenes.map(({ showtime, seat }) =>
            hold(user, { showtimeId: showtime.id, seatIds: [seat(1)], voucherCode: v.code }),
          ),
        );
        rounds.push(tally(responses));

        expect({ round, tally: tally(responses) }).toEqual({
          round,
          tally: { '201': 1, '409 VOUCHER_USER_LIMIT_REACHED': 4 },
        });
        for (const res of responses.filter((r) => r.status === 409)) {
          expect(errorOf(res).details).toEqual({ perUserLimit: 1 });
        }
        const winner = bodyOf<Booking>(responses.find((res) => res.status === 201)!);
        await expectOnlyWinnersWritten(
          scenes.map((s) => s.showtime.id),
          [winner],
        );
      }
      console.info(
        `[5.3] one user, 5 holds, perUserLimit 1 × 10 rounds: ${JSON.stringify(rounds)}`,
      );
    }, 120_000);

    it('perUserLimit 2, two users with 4 holds each at once: each gets exactly 2', async () => {
      const scenes = await showtimes(4);
      const v = await voucher({ perUserLimit: 2 });
      const [anna, binh] = await newUsers(2);
      const responses = await Promise.all(
        [anna, binh].flatMap((user, u) =>
          scenes.map(({ showtime, seat }) =>
            hold(user, { showtimeId: showtime.id, seatIds: [seat(u + 1)], voucherCode: v.code }),
          ),
        ),
      );

      expect(tally(responses.slice(0, 4))).toEqual({
        '201': 2,
        '409 VOUCHER_USER_LIMIT_REACHED': 2,
      });
      expect(tally(responses.slice(4))).toEqual({ '201': 2, '409 VOUCHER_USER_LIMIT_REACHED': 2 });
      const byUser = (await activeUses(v.id)).map((use) => use.userId);
      expect(byUser.filter((id) => id === anna.id)).toHaveLength(2);
      expect(byUser.filter((id) => id === binh.id)).toHaveLength(2);
    }, 60_000);

    it('both limits at once (usageLimit 2, perUserLimit 1): 2 winners, never 2 for the same user', async () => {
      for (let round = 0; round < 5; round++) {
        const scenes = await showtimes(3);
        const v = await voucher({ usageLimit: 2, perUserLimit: 1 });
        const [greedy, ...others] = await newUsers(4);
        const responses = await Promise.all([
          // One user tries three showtimes, three others one seat each of the first showtime.
          ...scenes.map(({ showtime, seat }) =>
            hold(greedy, { showtimeId: showtime.id, seatIds: [seat(1)], voucherCode: v.code }),
          ),
          ...others.map((user, i) =>
            hold(user, {
              showtimeId: scenes[0]!.showtime.id,
              seatIds: [scenes[0]!.seat(i + 2)],
              voucherCode: v.code,
            }),
          ),
        ]);

        const wins = responses.filter((res) => res.status === 201);
        expect({ round, wins: wins.length }).toEqual({ round, wins: 2 });
        expect(
          responses.slice(0, 3).filter((res) => res.status === 201).length,
        ).toBeLessThanOrEqual(1);
        for (const res of responses.filter((r) => r.status !== 201)) {
          expect(res.status).toBe(409);
          expect(['VOUCHER_USAGE_LIMIT_REACHED', 'VOUCHER_USER_LIMIT_REACHED']).toContain(
            errorOf(res).code,
          );
        }
        const active = await activeUses(v.id);
        expect(active).toHaveLength(2);
        expect(new Set(active.map((use) => use.userId)).size).toBe(2);
        await expectOnlyWinnersWritten(
          scenes.map((s) => s.showtime.id),
          wins.map((res) => bodyOf<Booking>(res)),
        );
      }
    }, 120_000);
  });
});
