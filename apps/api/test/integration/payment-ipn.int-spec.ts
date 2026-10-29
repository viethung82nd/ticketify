import { randomUUID } from 'node:crypto';
import { type INestApplication, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedShowtime,
  type CreatedVnpayPayment,
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
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../src/modules/bookings/booking-expiry.service';
import { reclaimSeatsForExpiredBooking } from '../../src/modules/payment/reclaim-seats';
import { TicketCodes } from '../../src/modules/payment/seat-settlement';
import { VnpayService } from '../../src/modules/payment/vnpay/vnpay.service';
import { REALTIME_CHANNEL_KEY } from '../../src/modules/realtime/realtime-redis';
import { SeatEvents } from '../../src/modules/realtime/seat-events';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf, errorOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';
import { captureServerErrors, formatServerErrors } from '../support/server-errors';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
/** Past holdUntil: the hold TTL plus the payment grace. */
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
const SEAT_PRICE = 90_000;
/** Test-only merchant settings; never a real secret. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;
const RACE_ROUNDS = 20;
/**
 * Random start offset of each side of a race (ms). Wide enough for either side to finish first:
 * an IPN that confirms takes a few tens of milliseconds, a cancel or a hold less.
 */
const RACE_MAX_DELAY_MS = 40;
const DUPLICATES = 10;

const OK = { RspCode: '00', Message: 'Confirm Success' };
const ALREADY = { RspCode: '02', Message: 'Order already confirmed' };
const NOT_FOUND = { RspCode: '01', Message: 'Order not found' };
const BAD_AMOUNT = { RspCode: '04', Message: 'Invalid amount' };
const BAD_SIGNATURE = { RspCode: '97', Message: 'Invalid signature' };
const UNKNOWN = { RspCode: '99', Message: 'Unknown error' };

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

/** Ticket codes the tests can pin to one value, to make the ticket insert fail mid-transaction. */
class ControllableTicketCodes extends TicketCodes {
  constant: string | null = null;
  override next(): string {
    return this.constant ?? super.next();
  }
}

interface TestUser {
  id: string;
}

interface Paid {
  user: TestUser;
  booking: Booking;
  payment: CreatedVnpayPayment;
  seatIds: string[];
  showtimeId: string;
}

describe('VNPay IPN — GET /payments/vnpay/ipn (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  /** Worker side, compiled but not started: `BookingExpiryService` is called directly. */
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminId: string;
  const clock = new FakeClock(NOW);
  const ticketCodes = new ControllableTicketCodes();
  const vnpay = new VnpayService();
  /** Own channel prefix: Redis pub/sub ignores the logical database the suites are split into. */
  const channelKey = `ticketify-test:${randomUUID()}`;

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
      .overrideProvider(TicketCodes)
      .useValue(ticketCodes)
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
          fullName: 'IPN Admin',
          role: Role.ADMIN,
        },
      })
    ).id;
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: SEAT_PRICE })),
      ),
    });

    const { WorkerModule } = await import('../../src/worker.module.js');
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
    ticketCodes.constant = null;
  });
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
        email: `ipn-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `IPN User ${userCounter}`,
      },
    });
    return { id: user.id };
  }

  /** Signed at the clock's current now, like `tokenOf`: tests move the clock past 15 minutes. */
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
  /** Fresh `rows × 12` room with one upcoming showtime; `seat('A1')` gives a seat id. */
  async function scene(rows = 2, startsAt = vn('2026-11-02', '19:00')) {
    counter += 1;
    const roomRes = await admin('/admin/rooms', {
      name: `Phòng IPN ${counter}`,
      rows,
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
          title: 'IPN Movie',
          slug: `ipn-movie-${randomUUID()}`,
          duration: 100,
          ageRating: 'P',
          releaseDate: instant('2026-10-01'),
        },
      })
    ).id;
    const showtimeRes = await admin('/admin/showtimes', { movieId, roomId: room.id, startsAt });
    expect(showtimeRes.status).toBe(201);
    return { showtime: bodyOf<CreatedShowtime>(showtimeRes), seat };
  }

  const hold = (user: TestUser, showtimeId: string, seatIds: string[]) =>
    http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });

  async function held(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
    const res = await hold(user, showtimeId, seatIds);
    expect(res.status).toBe(201);
    return bodyOf<Booking>(res);
  }

  const startPayment = (user: TestUser, bookingId: string) =>
    http()
      .post('/payments/vnpay')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .send({ bookingId });

  async function paymentFor(user: TestUser, bookingId: string): Promise<CreatedVnpayPayment> {
    const res = await startPayment(user, bookingId);
    expect(res.status).toBe(201);
    return bodyOf<CreatedVnpayPayment>(res);
  }

  /** A user, a PENDING booking of `seatIds` and one PENDING payment for it, at the clock's now. */
  async function bookAndPay(showtimeId: string, seatIds: string[]): Promise<Paid> {
    const user = await newUser();
    const booking = await held(user, showtimeId, seatIds);
    const payment = await paymentFor(user, booking.id);
    return { user, booking, payment, seatIds: [...seatIds].sort(), showtimeId };
  }

  /** A fresh showtime and one paid-for booking of `seats` seats on it (row A). */
  async function paidBooking(seats = 2) {
    const { showtime, seat } = await scene();
    const labels = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].slice(0, seats);
    return { ...(await bookAndPay(showtime.id, labels.map(seat))), seat };
  }

  const cancel = (user: TestUser, bookingId: string) =>
    http()
      .delete(`/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${tokenOf(user)}`);

  let transactionNo = 14_226_000;
  /** The IPN VNPay would send for `paid`, signed with the merchant secret unless told otherwise. */
  function ipnQuery(
    paid: Pick<Paid, 'payment' | 'booking'>,
    overrides: Record<string, string> = {},
    secret: string = VNPAY_ENV.VNPAY_HASH_SECRET,
  ): Record<string, string> {
    transactionNo += 1;
    const query = vnpay.buildSignedQuery(
      {
        vnp_Amount: String(paid.booking.total * 100),
        vnp_BankCode: 'NCB',
        vnp_BankTranNo: `VNP${transactionNo}`,
        vnp_CardType: 'ATM',
        vnp_OrderInfo: `Thanh toan ve ${paid.booking.code}`,
        vnp_PayDate: '20261101170500',
        vnp_ResponseCode: '00',
        vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
        vnp_TransactionNo: String(transactionNo),
        vnp_TransactionStatus: '00',
        vnp_TxnRef: paid.payment.txnRef,
        ...overrides,
      },
      secret,
    );
    return Object.fromEntries(new URLSearchParams(query));
  }

  const sendIpn = (query: Record<string, string>) => http().get('/payments/vnpay/ipn').query(query);

  /** Everything the IPN may change for one booking. */
  async function stateOf(paid: Pick<Paid, 'booking' | 'showtimeId' | 'seatIds'>) {
    const [booking, payments, seats, tickets, events] = await Promise.all([
      db.prisma.booking.findUniqueOrThrow({
        where: { id: paid.booking.id },
        select: { status: true, confirmedAt: true },
      }),
      db.prisma.payment.findMany({
        where: { bookingId: paid.booking.id },
        select: {
          id: true,
          status: true,
          vnpTransactionNo: true,
          bankCode: true,
          responseCode: true,
          processedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.prisma.showtimeSeat.findMany({
        where: { showtimeId: paid.showtimeId, seatId: { in: paid.seatIds } },
        select: { seatId: true, status: true, bookingId: true },
        orderBy: { seatId: 'asc' },
      }),
      db.prisma.ticket.findMany({
        where: { bookingId: paid.booking.id },
        select: { seatId: true, status: true, code: true },
        orderBy: { seatId: 'asc' },
      }),
      db.prisma.outboxEvent.findMany({
        where: { aggregateId: paid.booking.id },
        select: { type: true, status: true, payload: true },
      }),
    ]);
    return { booking, payments, seats, tickets, events };
  }

  const seatsOf = (
    paid: Pick<Paid, 'showtimeId' | 'seatIds'>,
    status: string,
    bookingId: string | null,
  ) => paid.seatIds.map((seatId) => ({ seatId, status, bookingId }));

  /**
   * The rules that must hold after every test and every race round, over the whole database:
   * one live ticket per seat; a CONFIRMED booking owns all of its seats SOLD and one ticket per
   * seat; a SOLD seat belongs to a CONFIRMED/NEEDS_REVIEW booking; tickets only for CONFIRMED
   * bookings; a SUCCESS payment only for CONFIRMED/NEEDS_REVIEW; no seat HELD by an EXPIRED or
   * CONFIRMED booking; one outbox event per CONFIRMED / NEEDS_REVIEW booking and none for others.
   */
  async function violations() {
    const q = <T>(sql: TemplateStringsArray) => db.prisma.$queryRaw<T[]>(sql);
    const [
      duplicateTickets,
      confirmedNotSold,
      soldWithoutPaidBooking,
      ticketsOfUnconfirmed,
      ticketCountMismatch,
      successNotSettled,
      heldByOver,
      outboxMismatch,
    ] = await Promise.all([
      q`SELECT showtime_id, seat_id, count(*)::int AS n FROM tickets WHERE status <> 'VOID'
        GROUP BY showtime_id, seat_id HAVING count(*) > 1`,
      q`SELECT b.id, bs.seat_id FROM bookings b
        JOIN booking_seats bs ON bs.booking_id = b.id
        JOIN showtime_seats ss ON ss.showtime_id = bs.showtime_id AND ss.seat_id = bs.seat_id
        WHERE b.status = 'CONFIRMED' AND (ss.status <> 'SOLD' OR ss.booking_id IS DISTINCT FROM b.id)`,
      q`SELECT ss.showtime_id, ss.seat_id FROM showtime_seats ss
        LEFT JOIN bookings b ON b.id = ss.booking_id
        WHERE ss.status = 'SOLD' AND (b.id IS NULL OR b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW'))`,
      q`SELECT t.id FROM tickets t JOIN bookings b ON b.id = t.booking_id
        WHERE b.status <> 'CONFIRMED'`,
      q`SELECT b.id FROM bookings b WHERE b.status = 'CONFIRMED'
        AND (SELECT count(*) FROM tickets t WHERE t.booking_id = b.id AND t.status <> 'VOID')
          <> (SELECT count(*) FROM booking_seats bs WHERE bs.booking_id = b.id)`,
      q`SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE p.status = 'SUCCESS' AND b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW')`,
      q`SELECT ss.seat_id FROM showtime_seats ss JOIN bookings b ON b.id = ss.booking_id
        WHERE ss.status = 'HELD' AND b.status IN ('EXPIRED', 'CONFIRMED')`,
      q`SELECT b.id, b.status::text AS status,
               count(o.id) FILTER (WHERE o.type = 'booking.confirmed')::int AS confirmed,
               count(o.id) FILTER (WHERE o.type = 'booking.needs_review')::int AS review
        FROM bookings b LEFT JOIN outbox_events o ON o.aggregate_id = b.id::text
        GROUP BY b.id, b.status
        HAVING count(o.id) FILTER (WHERE o.type = 'booking.confirmed')
                 <> CASE WHEN b.status = 'CONFIRMED' THEN 1 ELSE 0 END
            OR count(o.id) FILTER (WHERE o.type = 'booking.needs_review')
                 <> CASE WHEN b.status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END`,
    ]);
    return {
      duplicateTickets,
      confirmedNotSold,
      soldWithoutPaidBooking,
      ticketsOfUnconfirmed,
      ticketCountMismatch,
      successNotSettled,
      heldByOver,
      outboxMismatch,
    };
  }

  const NO_VIOLATIONS = {
    duplicateTickets: [],
    confirmedNotSold: [],
    soldWithoutPaidBooking: [],
    ticketsOfUnconfirmed: [],
    ticketCountMismatch: [],
    successNotSettled: [],
    heldByOver: [],
    outboxMismatch: [],
  };

  const deadlocks = async () => {
    const [row] = await db.prisma.$queryRaw<{ deadlocks: number }[]>`
      SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    return row?.deadlocks ?? 0;
  };

  afterEach(async () => expect(await violations()).toEqual(NO_VIOLATIONS));

  // ─── One test per row of the IPN table ───

  describe('1 — 97 Invalid signature (nothing changes)', () => {
    it('signed with another secret', async () => {
      const paid = await paidBooking(2);
      const before = await stateOf(paid);

      const res = await sendIpn(ipnQuery(paid, {}, 'another-secret'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(BAD_SIGNATURE);
      expect(await stateOf(paid)).toEqual(before);
    });

    it('vnp_ResponseCode changed after signing (a failure dressed up as a success)', async () => {
      const paid = await paidBooking(1);
      const before = await stateOf(paid);
      const query = { ...ipnQuery(paid, { vnp_ResponseCode: '24' }), vnp_ResponseCode: '00' };

      expect((await sendIpn(query)).body).toEqual(BAD_SIGNATURE);
      expect(await stateOf(paid)).toEqual(before);
    });

    it('no parameters at all', async () => {
      const res = await http().get('/payments/vnpay/ipn');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(BAD_SIGNATURE);
    });
  });

  describe('2 — 01 Order not found (nothing changes)', () => {
    it('an unknown vnp_TxnRef, correctly signed', async () => {
      const paid = await paidBooking(1);
      const before = await stateOf(paid);
      const stranger = { ...paid, payment: { ...paid.payment, txnRef: 'ZZZZZZZZZZZZZZZZZZZZ' } };

      const res = await sendIpn(ipnQuery(stranger));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await stateOf(paid)).toEqual(before);
    });

    it('a signed IPN without vnp_TxnRef', async () => {
      const paid = await paidBooking(1);
      const before = await stateOf(paid);

      expect((await sendIpn(ipnQuery(paid, { vnp_TxnRef: '' }))).body).toEqual(NOT_FOUND);
      expect(await stateOf(paid)).toEqual(before);
    });
  });

  describe('3 — 04 Invalid amount (nothing changes)', () => {
    it.each([
      ['in dong instead of × 100', (total: number) => String(total)],
      ['one dong short', (total: number) => String(total * 100 - 100)],
    ])('vnp_Amount %s', async (_label, amountOf) => {
      const paid = await paidBooking(2);
      const before = await stateOf(paid);

      const res = await sendIpn(ipnQuery(paid, { vnp_Amount: amountOf(paid.booking.total) }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(BAD_AMOUNT);
      expect(await stateOf(paid)).toEqual(before);
    });
  });

  describe('4 — 02 Order already confirmed', () => {
    it('the same IPN twice: one transition, the second answers 02 and changes nothing', async () => {
      const paid = await paidBooking(2);
      const query = ipnQuery(paid);

      expect((await sendIpn(query)).body).toEqual(OK);
      const after = await stateOf(paid);
      clock.advance({ seconds: 30 });
      const again = await sendIpn(query);

      expect(again.status).toBe(200);
      expect(again.body).toEqual(ALREADY);
      expect(await stateOf(paid)).toEqual(after);
      expect(after.tickets).toHaveLength(2);
    });

    it('a success after a recorded failure: 02, the payment stays FAILED', async () => {
      const paid = await paidBooking(1);
      expect(
        (await sendIpn(ipnQuery(paid, { vnp_ResponseCode: '24', vnp_TransactionStatus: '02' })))
          .body,
      ).toEqual(OK);
      const after = await stateOf(paid);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(ALREADY);
      expect(await stateOf(paid)).toEqual(after);
      expect(after.payments.map((p) => p.status)).toEqual(['FAILED']);
    });
  });

  describe('5 — not paid: 00, Payment FAILED, booking stays PENDING', () => {
    it.each([
      ['customer cancelled', '24', '02'],
      ['response 00 but transaction status 02', '00', '02'],
    ])(
      '%s (vnp_ResponseCode %s, vnp_TransactionStatus %s)',
      async (_label, responseCode, status) => {
        const paid = await paidBooking(2);
        const query = ipnQuery(paid, {
          vnp_ResponseCode: responseCode,
          vnp_TransactionStatus: status,
          vnp_TransactionNo: '0',
        });

        const res = await sendIpn(query);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(OK);
        const state = await stateOf(paid);
        expect(state.booking).toEqual({ status: 'PENDING', confirmedAt: null });
        expect(state.payments).toEqual([
          {
            id: paid.payment.paymentId,
            status: 'FAILED',
            vnpTransactionNo: null,
            bankCode: 'NCB',
            responseCode,
            processedAt: clock.now(),
          },
        ]);
        expect(state.seats).toEqual(seatsOf(paid, 'HELD', paid.booking.id));
        expect(state.tickets).toEqual([]);
        expect(state.events).toEqual([]);
        const [raw] = await db.prisma.payment.findMany({
          where: { id: paid.payment.paymentId },
          select: { rawPayload: true },
        });
        expect(raw?.rawPayload).toEqual(query);
      },
    );

    it('two failed payments with vnp_TransactionNo 0 do not collide; the user may pay again', async () => {
      const paid = await paidBooking(1);
      const failed = {
        vnp_ResponseCode: '24',
        vnp_TransactionStatus: '02',
        vnp_TransactionNo: '0',
      };
      expect((await sendIpn(ipnQuery(paid, failed))).body).toEqual(OK);

      const retry = await paymentFor(paid.user, paid.booking.id);
      expect((await sendIpn(ipnQuery({ ...paid, payment: retry }, failed))).body).toEqual(OK);
      const third = await paymentFor(paid.user, paid.booking.id);
      expect((await sendIpn(ipnQuery({ ...paid, payment: third }))).body).toEqual(OK);

      const state = await stateOf(paid);
      expect(state.payments.map((p) => p.status)).toEqual(['FAILED', 'FAILED', 'SUCCESS']);
      expect(state.booking.status).toBe('CONFIRMED');
    });
  });

  describe('6 — paid, branch A: seats still HELD → CONFIRMED with tickets', () => {
    it('Payment SUCCESS, seats SOLD, one ISSUED ticket per seat, booking.confirmed once, seat:sold', async () => {
      const paid = await paidBooking(3);
      const sold = jest.spyOn(app.get(SeatEvents), 'sold');
      clock.advance({ minutes: 2 });
      const query = ipnQuery(paid);

      const res = await sendIpn(query);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking).toEqual({ status: 'CONFIRMED', confirmedAt: clock.now() });
      expect(state.payments).toEqual([
        {
          id: paid.payment.paymentId,
          status: 'SUCCESS',
          vnpTransactionNo: query.vnp_TransactionNo,
          bankCode: 'NCB',
          responseCode: '00',
          processedAt: clock.now(),
        },
      ]);
      expect(state.seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
      expect(state.tickets.map((t) => [t.seatId, t.status])).toEqual(
        paid.seatIds.map((seatId) => [seatId, 'ISSUED']),
      );
      expect(new Set(state.tickets.map((t) => t.code)).size).toBe(3);
      for (const ticket of state.tickets) expect(ticket.code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
      expect(state.events).toEqual([
        {
          type: 'booking.confirmed',
          status: 'PENDING',
          payload: expect.objectContaining({
            bookingId: paid.booking.id,
            paymentId: paid.payment.paymentId,
            seatIds: paid.seatIds,
            reclaimed: false,
          }) as unknown,
        },
      ]);
      expect(sold).toHaveBeenCalledWith(paid.showtimeId, paid.seatIds);

      // Afterwards the booking can neither be cancelled nor paid again.
      const cancelled = await cancel(paid.user, paid.booking.id);
      expect(cancelled.status).toBe(409);
      expect(errorOf(cancelled).code).toBe('BOOKING_NOT_CANCELLABLE');
      const again = await startPayment(paid.user, paid.booking.id);
      expect(again.status).toBe(409);
      expect(errorOf(again).code).toBe('BOOKING_NOT_PAYABLE');
    });

    it('past holdUntil with the seats still HELD (expiry not run yet): CONFIRMED', async () => {
      const paid = await paidBooking(2);
      clock.advance({ minutes: HOLD_MINUTES + 5 });

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('CONFIRMED');
      expect(state.seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
      // The expiry job that runs later finds nothing to do.
      await expect(expiry.expire(paid.booking.id)).resolves.toEqual({ outcome: 'noop' });
    });

    it('the showtime has started (owner decision pending): still CONFIRMED', async () => {
      // Starts 17:12 Vietnam time, two minutes after the booking's expiresAt.
      const { showtime, seat } = await scene(1, vn('2026-11-01', '17:12'));
      const paid = await bookAndPay(showtime.id, [seat('A1')]);
      clock.set(instant(vn('2026-11-01', '17:13')));

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      expect((await stateOf(paid)).booking.status).toBe('CONFIRMED');
    });
  });

  // ─── 3.5: EXPIRED booking — take the seats back, or review ───

  describe('6 — paid after the booking EXPIRED (branches B and C)', () => {
    /** A paid booking that expired before the IPN: seats AVAILABLE again. */
    async function expiredPaid(seats = 2) {
      const paid = await paidBooking(seats);
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(paid.booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      return paid;
    }

    it('B: every seat still free → seats taken back, CONFIRMED, tickets, reclaimed: true', async () => {
      const paid = await expiredPaid(2);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking).toEqual({ status: 'CONFIRMED', confirmedAt: clock.now() });
      expect(state.payments.map((p) => p.status)).toEqual(['SUCCESS']);
      expect(state.seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
      expect(state.tickets).toHaveLength(2);
      expect(state.events).toEqual([
        expect.objectContaining({
          type: 'booking.confirmed',
          payload: expect.objectContaining({ reclaimed: true }) as unknown,
        }),
      ]);
    });

    it('B: a seat another booking held and let expire is taken back too', async () => {
      const paid = await expiredPaid(2);
      const rival = await newUser();
      const rivalBooking = await held(rival, paid.showtimeId, [paid.seatIds[1]!]);
      clock.advance({ minutes: HOLD_MINUTES });

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      expect((await stateOf(paid)).seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
      // The rival's booking is past holdUntil; its expiry releases nothing it no longer has.
      await expect(expiry.expire(rivalBooking.id)).resolves.toMatchObject({
        outcome: 'expired',
        releasedSeatIds: [],
      });
    });

    it('C: one seat held by a live booking → NEEDS_REVIEW, no ticket, no seat changes', async () => {
      const paid = await expiredPaid(2);
      const rival = await newUser();
      const rivalBooking = await held(rival, paid.showtimeId, [paid.seatIds[1]!]);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking).toEqual({ status: 'NEEDS_REVIEW', confirmedAt: null });
      expect(state.payments.map((p) => p.status)).toEqual(['SUCCESS']);
      expect(state.seats).toEqual([
        { seatId: paid.seatIds[0], status: 'AVAILABLE', bookingId: null },
        { seatId: paid.seatIds[1], status: 'HELD', bookingId: rivalBooking.id },
      ]);
      expect(state.tickets).toEqual([]);
      expect(state.events).toEqual([
        {
          type: 'booking.needs_review',
          status: 'PENDING',
          payload: expect.objectContaining({
            bookingId: paid.booking.id,
            paymentId: paid.payment.paymentId,
            amount: paid.booking.total,
            reason: 'SEAT_HELD_BY_OTHER',
            seatIds: [paid.seatIds[1]],
          }) as unknown,
        },
      ]);
    });

    it('C: one seat SOLD to another booking → NEEDS_REVIEW; the other booking keeps its seat and tickets', async () => {
      const paid = await expiredPaid(2);
      const other = await bookAndPay(paid.showtimeId, [paid.seatIds[0]!]);
      expect((await sendIpn(ipnQuery(other))).body).toEqual(OK);
      const otherBefore = await stateOf(other);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('NEEDS_REVIEW');
      expect(state.tickets).toEqual([]);
      expect(state.events.map((e) => [e.type, (e.payload as { reason: string }).reason])).toEqual([
        ['booking.needs_review', 'SEAT_SOLD'],
      ]);
      expect(state.seats).toEqual([
        { seatId: paid.seatIds[0], status: 'SOLD', bookingId: other.booking.id },
        { seatId: paid.seatIds[1], status: 'AVAILABLE', bookingId: null },
      ]);
      expect(await stateOf(other)).toEqual(otherBefore);
    });

    it('C: the showtime was cancelled after the booking expired → NEEDS_REVIEW', async () => {
      const paid = await expiredPaid(1);
      const cancelled = await admin(`/admin/showtimes/${paid.showtimeId}/cancel`);
      expect(cancelled.status).toBe(200);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('NEEDS_REVIEW');
      expect(state.seats).toEqual(seatsOf(paid, 'AVAILABLE', null));
      expect(state.events.map((e) => (e.payload as { reason: string }).reason)).toEqual([
        'SHOWTIME_CANCELLED',
      ]);
    });

    it('C: a PENDING booking past holdUntil that lost a seat to a new hold → NEEDS_REVIEW', async () => {
      const paid = await paidBooking(2);
      clock.advance({ minutes: HOLD_MINUTES });
      const rival = await newUser();
      const rivalBooking = await held(rival, paid.showtimeId, [paid.seatIds[0]!]);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('NEEDS_REVIEW');
      // Seats untouched: the rival keeps its seat, the booking's other seat stays HELD by it.
      expect(state.seats).toEqual([
        { seatId: paid.seatIds[0], status: 'HELD', bookingId: rivalBooking.id },
        { seatId: paid.seatIds[1], status: 'HELD', bookingId: paid.booking.id },
      ]);
      expect(state.tickets).toEqual([]);
    });
  });

  describe('reclaimSeatsForExpiredBooking, called directly (3.5)', () => {
    async function expiredBooking(seats = 2) {
      const { showtime, seat } = await scene();
      const user = await newUser();
      const labels = ['A1', 'A2'].slice(0, seats);
      const booking = await held(user, showtime.id, labels.map(seat));
      clock.advance({ minutes: HOLD_MINUTES });
      await expect(expiry.expire(booking.id)).resolves.toMatchObject({ outcome: 'expired' });
      const seatIds = labels.map(seat).sort();
      return { booking, showtimeId: showtime.id, seatIds };
    }
    const reclaim = (bookingId: string) =>
      db.prisma.$transaction((tx) => reclaimSeatsForExpiredBooking(tx, bookingId, clock.now()));
    const seatsNow = (showtimeId: string, seatIds: string[]) =>
      db.prisma.showtimeSeat.findMany({
        where: { showtimeId, seatId: { in: seatIds } },
        select: { seatId: true, status: true, bookingId: true },
        orderBy: { seatId: 'asc' },
      });

    it('seats still free → reclaimed, HELD by the booking again', async () => {
      const { booking, showtimeId, seatIds } = await expiredBooking(2);

      await expect(reclaim(booking.id)).resolves.toMatchObject({ reclaimed: true, seatIds });
      expect(await seatsNow(showtimeId, seatIds)).toEqual(
        seatIds.map((seatId) => ({ seatId, status: 'HELD', bookingId: booking.id })),
      );
      // Leave it as the IPN would never leave it: back to EXPIRED and free.
      await db.prisma.$executeRaw`
        UPDATE showtime_seats SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL
        WHERE booking_id = ${booking.id}::uuid`;
    });

    it('one seat SOLD → not reclaimed (SEAT_SOLD), nothing changes', async () => {
      const { booking, showtimeId, seatIds } = await expiredBooking(1);
      const other = await bookAndPay(showtimeId, seatIds);
      expect((await sendIpn(ipnQuery(other))).body).toEqual(OK);
      const before = await seatsNow(showtimeId, seatIds);

      await expect(reclaim(booking.id)).resolves.toMatchObject({
        reclaimed: false,
        problem: { reason: 'SEAT_SOLD', seatIds },
      });
      expect(await seatsNow(showtimeId, seatIds)).toEqual(before);
    });

    it('one seat held by a live booking → not reclaimed (SEAT_HELD_BY_OTHER)', async () => {
      const { booking, showtimeId, seatIds } = await expiredBooking(1);
      const rival = await held(await newUser(), showtimeId, seatIds);

      await expect(reclaim(booking.id)).resolves.toMatchObject({
        reclaimed: false,
        problem: { reason: 'SEAT_HELD_BY_OTHER', seatIds },
      });
      expect(await seatsNow(showtimeId, seatIds)).toEqual([
        { seatId: seatIds[0], status: 'HELD', bookingId: rival.id },
      ]);
    });

    it('two seats, one held by another booking → not reclaimed, and the free seat is not touched either', async () => {
      const { booking, showtimeId, seatIds } = await expiredBooking(2);
      const rival = await held(await newUser(), showtimeId, [seatIds[1]!]);

      await expect(reclaim(booking.id)).resolves.toMatchObject({
        reclaimed: false,
        problem: { reason: 'SEAT_HELD_BY_OTHER', seatIds: [seatIds[1]] },
      });
      expect(await seatsNow(showtimeId, seatIds)).toEqual([
        { seatId: seatIds[0], status: 'AVAILABLE', bookingId: null },
        { seatId: seatIds[1], status: 'HELD', bookingId: rival.id },
      ]);
    });
  });

  // ─── Duplicates ───

  describe('duplicate IPNs', () => {
    it(`${DUPLICATES} identical IPNs at once: one 00, the rest 02, no 5xx, no extra ticket`, async () => {
      const paid = await paidBooking(4);
      const query = ipnQuery(paid);
      const server = captureServerErrors();

      try {
        const answers = await Promise.all(Array.from({ length: DUPLICATES }, () => sendIpn(query)));
        expect(formatServerErrors(server.errors)).toBe('');
        expect(answers.map((res) => res.status)).toEqual(Array(DUPLICATES).fill(200));
        const codes = answers.map((res) => bodyOf<{ RspCode: string }>(res).RspCode).sort();
        expect(codes).toEqual(['00', ...Array<string>(DUPLICATES - 1).fill('02')]);
      } finally {
        server.restore();
      }
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('CONFIRMED');
      expect(state.tickets).toHaveLength(4);
      expect(state.events).toHaveLength(1);
    }, 30_000);

    it('two payment pages of one booking both paid: the first confirms, the second answers 02 and stays PENDING', async () => {
      const paid = await paidBooking(1);
      clock.advance({ seconds: 1 });
      const second = await paymentFor(paid.user, paid.booking.id);
      // The second IPN is logged as an error on purpose (a manual refund); not in the output.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      expect((await sendIpn(ipnQuery(paid))).body).toEqual(OK);
      const after = await stateOf(paid);
      expect((await sendIpn(ipnQuery({ ...paid, payment: second }))).body).toEqual(ALREADY);

      expect(await stateOf(paid)).toEqual(after);
      expect(after.payments.map((p) => [p.id, p.status])).toEqual([
        [paid.payment.paymentId, 'SUCCESS'],
        [second.paymentId, 'PENDING'],
      ]);
    });
  });

  // ─── Errors: 500, nothing half written ───

  describe('errors in the middle of the transaction: HTTP 500 (99), nothing written', () => {
    // The controller logs each 500 with its stack; expected here, so kept out of the output.
    beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));

    it('ticket insert fails (duplicate ticket code): rolled back, then the retry confirms', async () => {
      const paid = await paidBooking(2);
      const before = await stateOf(paid);
      ticketCodes.constant = 'DUPLICATE2CD';
      const query = ipnQuery(paid);

      const res = await sendIpn(query);

      expect(res.status).toBe(500);
      expect(res.body).toEqual(UNKNOWN);
      // Payment SUCCESS, seats SOLD and booking CONFIRMED were written before the failing insert.
      expect(await stateOf(paid)).toEqual(before);

      // VNPay calls again later; this time the insert goes through.
      ticketCodes.constant = null;
      expect((await sendIpn(query)).body).toEqual(OK);
      expect((await stateOf(paid)).tickets).toHaveLength(2);
    });

    it('a live ticket already exists for one seat: the partial unique index stops a second one', async () => {
      const paid = await paidBooking(2);
      // A ticket no flow would leave there (only the IPN issues tickets): the last line of defence.
      await db.prisma.ticket.create({
        data: {
          bookingId: paid.booking.id,
          showtimeId: paid.showtimeId,
          seatId: paid.seatIds[1]!,
          code: 'STRAYTICKET2',
        },
      });
      const before = await stateOf(paid);

      const res = await sendIpn(ipnQuery(paid));

      expect(res.status).toBe(500);
      expect(res.body).toEqual(UNKNOWN);
      expect(await stateOf(paid)).toEqual(before);
      expect(before.tickets).toHaveLength(1);
      await db.prisma.ticket.deleteMany({ where: { code: 'STRAYTICKET2' } });
    });

    it('no hash secret configured: 500, nothing read or written', async () => {
      const paid = await paidBooking(1);
      const before = await stateOf(paid);
      const config = app.get(AppConfig);
      const original = config.get.bind(config);
      jest
        .spyOn(config, 'get')
        .mockImplementation(<K extends keyof Env>(key: K): Env[K] =>
          key === 'VNPAY_HASH_SECRET' ? (undefined as Env[K]) : original(key),
        );

      const res = await sendIpn(ipnQuery(paid));

      expect(res.status).toBe(500);
      expect(res.body).toEqual(UNKNOWN);
      expect(await stateOf(paid)).toEqual(before);
    });
  });

  // ─── Races ───

  describe('races', () => {
    it(`IPN vs cancel, ${RACE_ROUNDS} rounds: no 5xx, no deadlock, never a ticket for a cancelled booking`, async () => {
      const next = random(20_261_201);
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
          const paid = await bookAndPay(
            showtime.id,
            labels.slice(round * 2, round * 2 + 2).map(seat),
          );
          // Half the rounds VNPay reports a success, half a payment the customer cancelled.
          const success = next() < 0.5;
          const query = success
            ? ipnQuery(paid)
            : ipnQuery(paid, { vnp_ResponseCode: '24', vnp_TransactionStatus: '02' });
          const delays = [0, 0].map(() => Math.floor(next() * RACE_MAX_DELAY_MS));

          const [ipn, cancelled] = await Promise.all([
            pause(delays[0]!).then(() => sendIpn(query)),
            pause(delays[1]!).then(() => cancel(paid.user, paid.booking.id)),
          ]);
          expect(formatServerErrors(server.errors)).toBe('');
          expect(ipn.status).toBe(200);
          expect(ipn.body).toEqual(OK);
          const cancelLabel =
            cancelled.status === 204 ? '204' : `${cancelled.status} ${errorOf(cancelled).code}`;
          const label = `${success ? 'paid' : 'not paid'}: cancel ${cancelLabel}`;
          outcomes.set(label, (outcomes.get(label) ?? 0) + 1);

          const state = await stateOf(paid);
          if (success) {
            // The cancel either saw the payment PENDING (in progress) or SUCCESS: never 204.
            expect(cancelled.status).toBe(409);
            expect(['BOOKING_HAS_PAYMENT_IN_PROGRESS', 'BOOKING_NOT_CANCELLABLE']).toContain(
              errorOf(cancelled).code,
            );
            expect(state.booking.status).toBe('CONFIRMED');
            expect(state.seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
            expect(state.tickets).toHaveLength(2);
          } else if (cancelled.status === 204) {
            // The IPN recorded the failure first; the cancel then went through.
            expect(state.booking.status).toBe('EXPIRED');
            expect(state.payments.map((p) => p.status)).toEqual(['FAILED']);
            expect(state.seats).toEqual(seatsOf(paid, 'AVAILABLE', null));
            expect(state.tickets).toEqual([]);
          } else {
            expect(cancelled.status).toBe(409);
            expect(errorOf(cancelled).code).toBe('BOOKING_HAS_PAYMENT_IN_PROGRESS');
            expect(state.booking.status).toBe('PENDING');
            expect(state.payments.map((p) => p.status)).toEqual(['FAILED']);
            expect(state.seats).toEqual(seatsOf(paid, 'HELD', paid.booking.id));
            expect(state.tickets).toEqual([]);
          }
          expect(await violations()).toEqual(NO_VIOLATIONS);
        }

        await pause(1_500);
        const found = (await deadlocks()) - deadlocksBefore;
        console.info(
          `[ipn×cancel] ${RACE_ROUNDS} rounds: ${JSON.stringify(Object.fromEntries(outcomes))}; deadlocks ${found}`,
        );
        expect(found).toBe(0);
      } finally {
        server.restore();
      }
    }, 90_000);

    it(`IPN vs expireBooking, ${RACE_ROUNDS} rounds: no 5xx, no deadlock, always CONFIRMED with SOLD seats`, async () => {
      const next = random(20_261_202);
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
          const paid = await bookAndPay(
            showtime.id,
            labels.slice(round * 2, round * 2 + 2).map(seat),
          );
          // Every other round the expiry runs on time (holdUntil passed), the others too early.
          const overdue = round % 2 === 0;
          if (overdue) clock.advance({ minutes: HOLD_MINUTES });
          const query = ipnQuery(paid);
          const delays = [0, 0].map(() => Math.floor(next() * RACE_MAX_DELAY_MS));

          const [ipn, expired] = await Promise.all([
            pause(delays[0]!).then(() => sendIpn(query)),
            pause(delays[1]!).then(() => expiry.expire(paid.booking.id)),
          ]);
          expect(formatServerErrors(server.errors)).toBe('');
          expect(ipn.status).toBe(200);
          expect(ipn.body).toEqual(OK);
          const state = await stateOf(paid);
          const reclaimed = (state.events[0]?.payload as { reclaimed?: boolean } | undefined)
            ?.reclaimed;
          const label = `${overdue ? 'overdue' : 'live'}: expire ${expired.outcome}${reclaimed ? ', reclaimed' : ''}`;
          outcomes.set(label, (outcomes.get(label) ?? 0) + 1);

          expect(overdue ? ['expired', 'skipped', 'noop'] : ['early', 'skipped', 'noop']).toContain(
            expired.outcome,
          );
          // Whoever went first, the seats were free for the paid booking: always confirmed.
          expect(state.booking.status).toBe('CONFIRMED');
          expect(state.seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
          expect(state.tickets).toHaveLength(2);
          expect(Boolean(reclaimed)).toBe(expired.outcome === 'expired');
          expect(await violations()).toEqual(NO_VIOLATIONS);
        }

        await pause(1_500);
        const found = (await deadlocks()) - deadlocksBefore;
        console.info(
          `[ipn×expire] ${RACE_ROUNDS} rounds: ${JSON.stringify(Object.fromEntries(outcomes))}; deadlocks ${found}`,
        );
        expect(found).toBe(0);
      } finally {
        server.restore();
      }
    }, 90_000);

    it(`IPN vs another user's hold, ${RACE_ROUNDS} rounds: SOLD seats of other bookings never change`, async () => {
      const next = random(20_261_203);
      const { showtime, seat } = await scene(5);
      const labels = ['A', 'B', 'C', 'D', 'E'].flatMap((row) =>
        Array.from({ length: 12 }, (_, i) => `${row}${i + 1}`),
      );
      const server = captureServerErrors();
      const deadlocksBefore = await deadlocks();
      const outcomes = new Map<string, number>();
      const variants = ['sold to another', 'expired', 'pending, overdue'] as const;

      try {
        for (let round = 0; round < RACE_ROUNDS; round++) {
          clock.set(NOW);
          const [s1, s2, s3] = labels.slice(round * 3, round * 3 + 3).map(seat) as [
            string,
            string,
            string,
          ];
          const variant = variants[Math.floor(next() * variants.length)]!;
          const paid = await bookAndPay(showtime.id, [s1, s2]);
          clock.advance({ minutes: HOLD_MINUTES });
          let other: Paid | null = null;
          if (variant !== 'pending, overdue') {
            await expect(expiry.expire(paid.booking.id)).resolves.toMatchObject({
              outcome: 'expired',
            });
          }
          if (variant === 'sold to another') {
            other = await bookAndPay(showtime.id, [s2]);
            expect((await sendIpn(ipnQuery(other))).body).toEqual(OK);
          }
          const otherBefore = other ? await stateOf(other) : null;
          const rival = await newUser();
          const rivalSeats = variant === 'pending, overdue' ? [s2, s3] : [s1, s3];
          const delays = [0, 0].map(() => Math.floor(next() * RACE_MAX_DELAY_MS));

          const [ipn, rivalHold] = await Promise.all([
            pause(delays[0]!).then(() => sendIpn(ipnQuery(paid))),
            pause(delays[1]!).then(() => hold(rival, showtime.id, rivalSeats)),
          ]);
          expect(formatServerErrors(server.errors)).toBe('');
          expect(ipn.status).toBe(200);
          expect(ipn.body).toEqual(OK);
          expect([201, 409]).toContain(rivalHold.status);
          if (rivalHold.status === 409) {
            expect(['SEAT_LOCKED', 'SEAT_UNAVAILABLE']).toContain(errorOf(rivalHold).code);
          }
          const rivalBooking = rivalHold.status === 201 ? bodyOf<Booking>(rivalHold) : null;
          const state = await stateOf(paid);
          const rivalLabel =
            rivalHold.status === 201 ? '201' : `${rivalHold.status} ${errorOf(rivalHold).code}`;
          const label = `${variant}: ${state.booking.status} / rival ${rivalLabel}`;
          outcomes.set(label, (outcomes.get(label) ?? 0) + 1);

          if (otherBefore && other) {
            // The seat sold to the other booking, and its tickets, never change.
            expect(await stateOf(other)).toEqual(otherBefore);
            expect(state.booking.status).toBe('NEEDS_REVIEW');
          }
          if (state.booking.status === 'CONFIRMED') {
            expect(state.seats).toEqual(seatsOf(paid, 'SOLD', paid.booking.id));
            expect(state.tickets).toHaveLength(2);
            expect(rivalBooking).toBeNull();
          } else {
            expect(state.booking.status).toBe('NEEDS_REVIEW');
            expect(state.tickets).toEqual([]);
            if (!other) expect(rivalBooking).not.toBeNull();
          }
          if (rivalBooking) {
            const rivalSeatRows = await db.prisma.showtimeSeat.findMany({
              where: { showtimeId: showtime.id, seatId: { in: rivalSeats } },
              select: { status: true, bookingId: true },
            });
            expect(rivalSeatRows).toEqual(
              rivalSeats.map(() => ({ status: 'HELD', bookingId: rivalBooking.id })),
            );
          }
          expect(await violations()).toEqual(NO_VIOLATIONS);
        }

        await pause(1_500);
        const found = (await deadlocks()) - deadlocksBefore;
        console.info(
          `[ipn×hold] ${RACE_ROUNDS} rounds: ${JSON.stringify(Object.fromEntries(outcomes))}; deadlocks ${found}`,
        );
        expect(found).toBe(0);
      } finally {
        server.restore();
      }
    }, 120_000);
  });
});
