import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  type CreatedVnpayPayment,
  DayType,
  type NeedsReviewBooking,
  type Page,
  Role,
  REVIEW_LIMITS,
  SeatType,
} from '@ticketify/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { VnpayService } from '../../src/modules/payment/vnpay/vnpay.service';
import { REALTIME_CHANNEL_KEY } from '../../src/modules/realtime/realtime-redis';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

/**
 * The admin queue of NEEDS_REVIEW bookings (ROADMAP 3.8, PLAN §5 "Xử lý NEEDS_REVIEW"): listing
 * them, marking one handled with a required note, and the audit entry that records it. Also runs
 * the three checking queries of `docs/needs-review-queries.sql` verbatim against real data, so the
 * documented SQL cannot drift from what works.
 *
 * Marking a booking handled refunds nothing and does not change its status; both are asserted.
 */

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
const SEAT_PRICE = 90_000;
/** Test-only merchant settings; never real secrets. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;

const QUERIES_FILE = join(__dirname, '../../../../docs/needs-review-queries.sql');

/** The `-- name: x` blocks of the checking-queries file, as runnable SQL. */
function documentedQueries(): Map<string, string> {
  const text = readFileSync(QUERIES_FILE, 'utf8');
  const blocks = new Map<string, string>();
  const parts = text.split(/^-- name: (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i]!.trim();
    const sql = parts[i + 1]!.trim();
    blocks.set(name, sql.endsWith(';') ? sql.slice(0, -1) : sql);
  }
  return blocks;
}

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();

interface TestUser {
  id: string;
}

describe('Admin review queue — /admin/bookings (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let adminId: string;
  let otherAdminId: string;
  let staffId: string;
  const clock = new FakeClock(NOW);
  const vnpay = new VnpayService();
  const channelKey = `ticketify-test:${randomUUID()}`;
  const queries = documentedQueries();

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
          PAYMENT_RATE_LIMIT_MAX: '100',
          ...VNPAY_ENV,
        },
      ),
    );
    const { AppModule } = await import('../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(REALTIME_CHANNEL_KEY)
      .useValue(channelKey)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
    await app.init();

    const staffUser = async (role: Role, name: string) =>
      (
        await db.prisma.user.create({
          data: {
            email: `${name}-${randomUUID()}@test.local`,
            passwordHash: 'not-a-real-hash',
            fullName: name,
            role,
          },
        })
      ).id;
    adminId = await staffUser(Role.ADMIN, 'Review Admin');
    otherAdminId = await staffUser(Role.ADMIN, 'Second Admin');
    staffId = await staffUser(Role.STAFF, 'Review Staff');
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
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  // ─── Helpers ───

  const http = () => request(app.getHttpServer());
  const tokenFor = (id: string, role: Role) => app.get(AccessTokenIssuer).issue({ id, role }).token;
  const asAdmin = (id = adminId) =>
    ({ Authorization: `Bearer ${tokenFor(id, Role.ADMIN)}` }) as Record<string, string>;

  let userCounter = 0;
  async function newUser(): Promise<TestUser> {
    userCounter += 1;
    const user = await db.prisma.user.create({
      data: {
        email: `review-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Review User ${userCounter}`,
        phone: `090000${String(userCounter).padStart(4, '0')}`,
      },
    });
    return { id: user.id };
  }

  let movieId: string | undefined;
  let counter = 0;
  async function scene(startsAt = vn('2026-11-02', '19:00')) {
    counter += 1;
    const roomRes = await http()
      .post('/admin/rooms')
      .set(asAdmin())
      .send({ name: `Phòng Review ${counter}`, rows: 4, cols: 12 });
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
          title: 'Review Movie',
          slug: `review-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: instant('2026-10-01'),
        },
      })
    ).id;
    const res = await http()
      .post('/admin/showtimes')
      .set(asAdmin())
      .send({ movieId, roomId: room.id, startsAt });
    expect(res.status).toBe(201);
    return { showtime: bodyOf<CreatedShowtime>(res), seat, roomName: room.name };
  }

  async function held(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
    const res = await http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenFor(user.id, Role.USER)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  async function paymentFor(user: TestUser, bookingId: string): Promise<CreatedVnpayPayment> {
    const res = await http()
      .post('/payments/vnpay')
      .set('Authorization', `Bearer ${tokenFor(user.id, Role.USER)}`)
      .send({ bookingId });
    expect(res.status).toBe(201);
    return bodyOf<CreatedVnpayPayment>(res);
  }

  let transactionNo = 16_440_000;
  /** The IPN VNPay would send for one payment attempt, signed with the test secret. */
  function ipnQuery(txnRef: string, amount: number): Record<string, string> {
    transactionNo += 1;
    return Object.fromEntries(
      new URLSearchParams(
        vnpay.buildSignedQuery(
          {
            vnp_Amount: String(amount * 100),
            vnp_BankCode: 'NCB',
            vnp_PayDate: '20261101170500',
            vnp_ResponseCode: '00',
            vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
            vnp_TransactionNo: String(transactionNo),
            vnp_TransactionStatus: '00',
            vnp_TxnRef: txnRef,
          },
          VNPAY_ENV.VNPAY_HASH_SECRET,
        ),
      ),
    );
  }

  const sendIpn = (query: Record<string, string>) => http().get('/payments/vnpay/ipn').query(query);

  /**
   * A booking that is paid but lost its seats: the customer holds a seat and starts a payment,
   * the hold runs out, someone else takes the seat and pays, and only then does the first IPN
   * arrive — PLAN §5 step 4, which is exactly how the queue fills up in production.
   */
  async function reviewCase(label = 'A1') {
    const { showtime, seat, roomName } = await scene();
    const seatId = seat(label);
    const user = await newUser();
    const booking = await held(user, showtime.id, [seatId]);
    const payment = await paymentFor(user, booking.id);

    clock.advance({ minutes: HOLD_MINUTES });
    const winner = await newUser();
    const winnerBooking = await held(winner, showtime.id, [seatId]);
    const winnerPayment = await paymentFor(winner, winnerBooking.id);
    expect((await sendIpn(ipnQuery(winnerPayment.txnRef, winnerBooking.total))).body).toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });

    // The late IPN of the first customer: paid, seat gone → NEEDS_REVIEW.
    expect((await sendIpn(ipnQuery(payment.txnRef, booking.total))).body).toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    const after = await db.prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { status: true },
    });
    expect(after.status).toBe('NEEDS_REVIEW');
    return { booking, payment, user, showtime, roomName, seatLabel: label };
  }

  const list = (query: Record<string, string | number> = {}) =>
    http().get('/admin/bookings/needs-review').set(asAdmin()).query(query);

  const resolve = (bookingId: string, note: string, admin = adminId) =>
    http().post(`/admin/bookings/${bookingId}/resolve-review`).set(asAdmin(admin)).send({ note });

  const itemFor = (page: Page<NeedsReviewBooking>, bookingId: string) => {
    const found = page.items.find((item) => item.bookingId === bookingId);
    if (!found) throw new Error(`Booking ${bookingId} is not in the page`);
    return found;
  };

  // ─── Access ───

  describe('access', () => {
    it('needs a token', async () => {
      expect((await http().get('/admin/bookings/needs-review')).status).toBe(401);
    });

    it.each([
      ['a customer', Role.USER],
      ['STAFF', Role.STAFF],
    ])('refuses %s with 403', async (_label, role) => {
      const id = role === Role.STAFF ? staffId : (await newUser()).id;
      const res = await http()
        .get('/admin/bookings/needs-review')
        .set('Authorization', `Bearer ${tokenFor(id, role)}`);

      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
    });

    it('refuses a non-admin resolving a booking', async () => {
      const { booking } = await reviewCase();

      const res = await http()
        .post(`/admin/bookings/${booking.id}/resolve-review`)
        .set('Authorization', `Bearer ${tokenFor(staffId, Role.STAFF)}`)
        .send({ note: 'refunded' });

      expect(res.status).toBe(403);
      expect(
        (await db.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).reviewResolvedAt,
      ).toBeNull();
      expect(await db.prisma.auditLog.count({ where: { entityId: booking.id } })).toBe(0);
    });
  });

  // ─── Listing ───

  describe('GET /admin/bookings/needs-review', () => {
    it('shows everything an admin needs to refund by hand', async () => {
      const fixture = await reviewCase('A2');

      const res = await list();

      expect(res.status).toBe(200);
      const item = itemFor(bodyOf<Page<NeedsReviewBooking>>(res), fixture.booking.id);
      expect(item.status).toBe('NEEDS_REVIEW');
      expect(item.code).toBe(fixture.booking.code);
      expect(item.total).toBe(fixture.booking.total);
      expect(item.user.id).toBe(fixture.user.id);
      expect(item.user.phone).toMatch(/^090000/);
      expect(item.showtime.id).toBe(fixture.showtime.id);
      expect(item.showtime.movieTitle).toBe('Review Movie');
      expect(item.showtime.roomName).toBe(fixture.roomName);
      // booking_seats keeps the seat history even though the seat was released.
      expect(item.seatLabels).toEqual([fixture.seatLabel]);
      expect(item.payment).toEqual({
        id: expect.any(String) as string,
        txnRef: fixture.payment.txnRef,
        amount: fixture.booking.total,
        status: 'SUCCESS',
        vnpTransactionNo: expect.stringMatching(/^\d+$/) as string,
        bankCode: 'NCB',
        processedAt: expect.any(String) as string,
      });
      // Why the seats were lost, from the booking.needs_review outbox event.
      expect(item.reason).toBe('SEAT_SOLD');
      expect(item.resolution).toBeNull();
    });

    it('lists only NEEDS_REVIEW bookings', async () => {
      const fixture = await reviewCase('A3');

      const page = bodyOf<Page<NeedsReviewBooking>>(await list({ pageSize: 100 }));

      expect(page.items.some((item) => item.bookingId === fixture.booking.id)).toBe(true);
      const statuses = await db.prisma.booking.findMany({
        where: { id: { in: page.items.map((item) => item.bookingId) } },
        select: { status: true },
      });
      expect(statuses.every((row) => row.status === 'NEEDS_REVIEW')).toBe(true);
    });

    it('paginates, oldest first, and reports the total', async () => {
      const before = bodyOf<Page<NeedsReviewBooking>>(await list({ pageSize: 1 })).total;
      const first = await reviewCase('A4');
      const second = await reviewCase('A5');

      const page1 = bodyOf<Page<NeedsReviewBooking>>(await list({ page: 1, pageSize: 1 }));
      expect(page1.total).toBe(before + 2);
      expect(page1.items).toHaveLength(1);
      expect(page1.pageSize).toBe(1);

      const all = bodyOf<Page<NeedsReviewBooking>>(await list({ pageSize: 100 }));
      const order = all.items.map((item) => item.bookingId);
      // `open` is a work queue: the longest-waiting customer comes first.
      expect(order.indexOf(first.booking.id)).toBeLessThan(order.indexOf(second.booking.id));
    });

    it('caps pageSize at the documented maximum', async () => {
      const res = await list({ pageSize: REVIEW_LIMITS.listPageSizeMax + 1 });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['an unknown filter', { filter: 'whatever' }],
      ['page 0', { page: 0 }],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await list(query);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('splits the queue into open and resolved', async () => {
      const open = await reviewCase('A6');
      const done = await reviewCase('A7');
      expect((await resolve(done.booking.id, 'Đã hoàn tiền qua cổng VNPay')).status).toBe(200);

      const openPage = bodyOf<Page<NeedsReviewBooking>>(await list({ pageSize: 100 }));
      const resolvedPage = bodyOf<Page<NeedsReviewBooking>>(
        await list({ filter: 'resolved', pageSize: 100 }),
      );
      const allPage = bodyOf<Page<NeedsReviewBooking>>(
        await list({ filter: 'all', pageSize: 100 }),
      );

      const ids = (page: Page<NeedsReviewBooking>) => page.items.map((item) => item.bookingId);
      expect(ids(openPage)).toContain(open.booking.id);
      expect(ids(openPage)).not.toContain(done.booking.id);
      expect(ids(resolvedPage)).toContain(done.booking.id);
      expect(ids(resolvedPage)).not.toContain(open.booking.id);
      expect(ids(allPage)).toContain(open.booking.id);
      expect(ids(allPage)).toContain(done.booking.id);
    });
  });

  // ─── Marking one handled ───

  describe('POST /admin/bookings/:id/resolve-review', () => {
    it('records who, when and the note — and refunds nothing', async () => {
      const fixture = await reviewCase('B1');
      const before = await db.prisma.payment.findFirstOrThrow({
        where: { bookingId: fixture.booking.id },
        select: { status: true, amount: true, vnpTransactionNo: true },
      });

      const res = await resolve(fixture.booking.id, '  Đã hoàn tiền qua cổng VNPay, mã GD 123  ');

      expect(res.status).toBe(200);
      const item = bodyOf<NeedsReviewBooking>(res);
      // The booking keeps its status: this is an operational flag, not a state change.
      expect(item.status).toBe('NEEDS_REVIEW');
      expect(item.resolution).toEqual({
        at: expect.any(String) as string,
        byUserId: adminId,
        byName: 'Review Admin',
        note: 'Đã hoàn tiền qua cổng VNPay, mã GD 123',
      });

      const booking = await db.prisma.booking.findUniqueOrThrow({
        where: { id: fixture.booking.id },
        select: { status: true, reviewResolvedAt: true, reviewResolvedBy: true },
      });
      expect(booking.status).toBe('NEEDS_REVIEW');
      expect(booking.reviewResolvedAt).not.toBeNull();
      expect(booking.reviewResolvedBy).toBe(adminId);
      // The payment is untouched: no money moved, nothing was reversed in the database.
      await expect(
        db.prisma.payment.findFirstOrThrow({
          where: { bookingId: fixture.booking.id },
          select: { status: true, amount: true, vnpTransactionNo: true },
        }),
      ).resolves.toEqual(before);
      // No ticket appears either.
      expect(await db.prisma.ticket.count({ where: { bookingId: fixture.booking.id } })).toBe(0);
    });

    it('writes one audit entry with the state before and after', async () => {
      const fixture = await reviewCase('B2');

      await resolve(fixture.booking.id, 'Khách đồng ý đổi suất khác');

      const entries = await db.prisma.auditLog.findMany({
        where: { entityId: fixture.booking.id },
      });
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.action).toBe('booking.review_resolved');
      expect(entry.entityType).toBe('booking');
      expect(entry.actorId).toBe(adminId);
      expect(entry.note).toBe('Khách đồng ý đổi suất khác');
      expect(entry.before).toEqual({ status: 'NEEDS_REVIEW', reviewResolvedAt: null });
      expect(entry.after).toEqual({
        status: 'NEEDS_REVIEW',
        reviewResolvedAt: expect.any(String) as string,
        reviewResolvedBy: adminId,
      });
      expect(entry.createdAt.toISOString()).toBe(clock.now().toISOString());
    });

    it('refuses a second resolution and keeps the first note', async () => {
      const fixture = await reviewCase('B3');
      expect((await resolve(fixture.booking.id, 'Lần đầu: đã hoàn tiền')).status).toBe(200);

      const res = await resolve(fixture.booking.id, 'Lần hai', otherAdminId);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('REVIEW_ALREADY_RESOLVED');
      expect(errorOf(res).details).toEqual({ resolvedAt: expect.any(String) as string });
      const booking = await db.prisma.booking.findUniqueOrThrow({
        where: { id: fixture.booking.id },
        select: { reviewResolvedBy: true },
      });
      expect(booking.reviewResolvedBy).toBe(adminId);
      expect(await db.prisma.auditLog.count({ where: { entityId: fixture.booking.id } })).toBe(1);
    });

    it('only one of two admins clicking at the same time wins', async () => {
      const fixture = await reviewCase('B4');

      const results = await Promise.all([
        resolve(fixture.booking.id, 'Admin một', adminId),
        resolve(fixture.booking.id, 'Admin hai', otherAdminId),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await db.prisma.auditLog.count({ where: { entityId: fixture.booking.id } })).toBe(1);
      const booking = await db.prisma.booking.findUniqueOrThrow({
        where: { id: fixture.booking.id },
        select: { reviewResolvedAt: true, reviewResolvedBy: true },
      });
      expect(booking.reviewResolvedAt).not.toBeNull();
      expect([adminId, otherAdminId]).toContain(booking.reviewResolvedBy);
    });

    it('404 for an unknown booking, and nothing is written', async () => {
      const res = await resolve('01a17e75-0000-7000-8000-000000000000', 'nothing');

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
      expect(await db.prisma.auditLog.count({ where: { note: 'nothing' } })).toBe(0);
    });

    it('409 for a booking that is not under review', async () => {
      const { showtime, seat } = await scene();
      const user = await newUser();
      const booking = await held(user, showtime.id, [seat('C1')]);

      const res = await resolve(booking.id, 'không áp dụng');

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('BOOKING_NOT_IN_REVIEW');
      expect(await db.prisma.auditLog.count({ where: { entityId: booking.id } })).toBe(0);
    });

    it.each([
      ['an empty note', ''],
      ['a note of only spaces', '    '],
      ['a note over the limit', 'x'.repeat(REVIEW_LIMITS.noteMax + 1)],
    ])('400 for %s, and nothing is written', async (_label, note) => {
      const fixture = await reviewCase('C2');

      const res = await resolve(fixture.booking.id, note);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(
        (
          await db.prisma.booking.findUniqueOrThrow({
            where: { id: fixture.booking.id },
            select: { reviewResolvedAt: true },
          })
        ).reviewResolvedAt,
      ).toBeNull();
      expect(await db.prisma.auditLog.count({ where: { entityId: fixture.booking.id } })).toBe(0);
    });

    it('400 for a malformed booking id', async () => {
      const res = await http()
        .post('/admin/bookings/not-a-uuid/resolve-review')
        .set(asAdmin())
        .send({ note: 'x' });

      expect(res.status).toBe(400);
    });
  });

  // ─── The documented checking queries ───

  describe('docs/needs-review-queries.sql', () => {
    it('contains the three named queries', () => {
      expect([...queries.keys()]).toEqual(['refund-queue', 'double-success', 'refund-required']);
    });

    it('refund-queue finds every booking that was paid without being confirmed', async () => {
      const fixture = await reviewCase('D1');

      const rows = await db.prisma.$queryRawUnsafe<
        {
          payment_id: string;
          booking_id: string;
          booking_status: string;
          txn_ref: string;
          amount: number;
          review_resolved_at: Date | null;
        }[]
      >(queries.get('refund-queue')!);

      const row = rows.find((item) => item.booking_id === fixture.booking.id);
      expect(row).toBeDefined();
      expect(row?.booking_status).toBe('NEEDS_REVIEW');
      expect(row?.txn_ref).toBe(fixture.payment.txnRef);
      expect(row?.amount).toBe(fixture.booking.total);
      expect(row?.review_resolved_at).toBeNull();
      // Every row is a SUCCESS payment of a booking that is not CONFIRMED.
      expect(rows.every((item) => item.booking_status !== 'CONFIRMED')).toBe(true);
      // A booking stays in the queue after being marked handled; the flag is how it is filtered.
      await resolve(fixture.booking.id, 'Đã hoàn tiền');
      const after = await db.prisma.$queryRawUnsafe<
        { booking_id: string; review_resolved_at: Date | null }[]
      >(queries.get('refund-queue')!);
      expect(
        after.find((item) => item.booking_id === fixture.booking.id)?.review_resolved_at,
      ).not.toBeNull();
    });

    it('double-success is empty: the partial unique index forbids a second SUCCESS', async () => {
      const fixture = await reviewCase('D2');

      expect(await db.prisma.$queryRawUnsafe<unknown[]>(queries.get('double-success')!)).toEqual(
        [],
      );

      // And the index really is what stops it: a second SUCCESS cannot be inserted at all.
      await expect(
        db.prisma.payment.create({
          data: {
            bookingId: fixture.booking.id,
            txnRef: `dup${randomUUID().replaceAll('-', '').slice(0, 17)}`,
            amount: fixture.booking.total,
            status: 'SUCCESS',
          },
        }),
      ).rejects.toThrow(/payments_booking_id_success_key/);
      expect(await db.prisma.$queryRawUnsafe<unknown[]>(queries.get('double-success')!)).toEqual(
        [],
      );
    });

    it('refund-required finds the second payment of a booking paid twice', async () => {
      // Two payment pages open at once; the customer completes both.
      const { showtime, seat } = await scene();
      const user = await newUser();
      const booking = await held(user, showtime.id, [seat('D3')]);
      const first = await paymentFor(user, booking.id);
      const second = await paymentFor(user, booking.id);

      expect((await sendIpn(ipnQuery(first.txnRef, booking.total))).body).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      expect((await sendIpn(ipnQuery(second.txnRef, booking.total))).body).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });

      const rows = await db.prisma.$queryRawUnsafe<
        {
          payment_id: string;
          txn_ref: string;
          vnp_transaction_no: string | null;
          booking_id: string;
        }[]
      >(queries.get('refund-required')!);

      const row = rows.find((item) => item.txn_ref === second.txnRef);
      expect(row).toBeDefined();
      expect(row?.booking_id).toBe(booking.id);
      // The number the VNPay portal needs to send the money back.
      expect(row?.vnp_transaction_no).toMatch(/^\d+$/);
      // The first payment stands and the booking keeps its ticket.
      expect(rows.some((item) => item.txn_ref === first.txnRef)).toBe(false);
      const after = await db.prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { status: true },
      });
      expect(after.status).toBe('CONFIRMED');
      expect(await db.prisma.ticket.count({ where: { bookingId: booking.id } })).toBe(1);
      // A booking paid twice is CONFIRMED, so it is not in the manual queue...
      const queue = await db.prisma.$queryRawUnsafe<{ booking_id: string }[]>(
        queries.get('refund-queue')!,
      );
      expect(queue.some((item) => item.booking_id === booking.id)).toBe(false);
      // ...which is exactly why the third query exists.
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
