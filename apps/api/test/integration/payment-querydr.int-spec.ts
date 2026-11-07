import { createHmac, randomUUID } from 'node:crypto';
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
import { ClockService } from '../../src/infra/clock/clock.service';
import { FakeClock } from '../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../src/modules/bookings/booking-expiry.service';
import type { ExpireOutcome } from '../../src/modules/bookings/expire-booking';
import { VnpayService } from '../../src/modules/payment/vnpay/vnpay.service';
import { querydrResponseHashData } from '../../src/modules/payment/vnpay/vnpay-querydr';
import { REALTIME_CHANNEL_KEY } from '../../src/modules/realtime/realtime-redis';
import { appTestEnv } from '../support/app-env';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { bodyOf } from '../support/http';
import { createTestRedis, type TestRedis } from '../support/redis';

/**
 * querydr in the booking expiry (ROADMAP 3.7, PLAN §4 "Luồng hết hạn"): before giving a booking's
 * seats up, the worker asks VNPay whether the pending payment went through — an HTTP call made
 * **outside** the transaction, whose answer is then checked again under the row locks.
 *
 * No request ever leaves the machine: `fetch` is replaced with the answer VNPay would have sent,
 * signed with the suite's own test secret (the sandbox credentials are registered by hand and are
 * not in the repo, see README). Real sandbox payments are ROADMAP 3.6, on hold.
 *
 * Every test asserts the final state in the database — booking, payments, seats, tickets, outbox —
 * not just the value the service returned.
 */

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
const HOLD_TTL_SECONDS = 600;
const PAYMENT_GRACE_SECONDS = 300;
/** Past holdUntil: the hold TTL plus the payment grace. */
const HOLD_MINUTES = (HOLD_TTL_SECONDS + PAYMENT_GRACE_SECONDS) / 60;
const SEAT_PRICE = 90_000;
const API_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';
/** Test-only merchant settings; never real secrets. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'integration-test-vnpay-hash-secret',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
  VNPAY_API_URL: API_URL,
  VNPAY_QUERYDR_TIMEOUT_MS: '2000',
} as const;

const vn = (date: string, time: string): string => `${date}T${time}:00+07:00`;
const instant = (value: string): Date => new FakeClock(value).now();

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

/** One recorded querydr request. */
interface SentQuery {
  url: string;
  body: Record<string, string>;
}

describe('querydr in the booking expiry (real Postgres + Redis, VNPay stubbed)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  /** Worker side, compiled but not started: `BookingExpiryService` is called directly. */
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminId: string;
  const clock = new FakeClock(NOW);
  const vnpay = new VnpayService();
  /** Own channel prefix: Redis pub/sub ignores the logical database the suites are split into. */
  const channelKey = `ticketify-test:${randomUUID()}`;
  let sent: SentQuery[] = [];

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
    adminId = (
      await db.prisma.user.create({
        data: {
          email: `admin-${randomUUID()}@test.local`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Querydr Admin',
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
    sent = [];
    // The worker logs a warning for every payment querydr reports paid; keep the output readable.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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
        email: `querydr-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Querydr User ${userCounter}`,
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
  /** Fresh 2×12 room with one upcoming showtime; `seat('A1')` gives a seat id. */
  async function scene(startsAt = vn('2026-11-02', '19:00')) {
    counter += 1;
    const roomRes = await admin('/admin/rooms', {
      name: `Phòng Querydr ${counter}`,
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
          title: 'Querydr Movie',
          slug: `querydr-movie-${randomUUID()}`,
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

  async function held(user: TestUser, showtimeId: string, seatIds: string[]): Promise<Booking> {
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

  /** A user, a PENDING booking of `seatIds` and one PENDING payment for it, at the clock's now. */
  async function bookAndPay(showtimeId: string, seatIds: string[]): Promise<Paid> {
    const user = await newUser();
    const booking = await held(user, showtimeId, seatIds);
    const payment = await paymentFor(user, booking.id);
    return { user, booking, payment, seatIds: [...seatIds].sort(), showtimeId };
  }

  /** A fresh showtime and one booking of row-A seats with a PENDING payment on it. */
  async function waitingForPayment(seats = 2) {
    const { showtime, seat } = await scene();
    const labels = ['A1', 'A2', 'A3'].slice(0, seats);
    return { ...(await bookAndPay(showtime.id, labels.map(seat))), seat };
  }

  let transactionNo = 15_330_000;
  /** The querydr response VNPay would send for `paid`, signed with the test secret. */
  function querydrResponse(
    paid: Pick<Paid, 'payment' | 'booking'>,
    overrides: Record<string, string | undefined> = {},
    secret: string = VNPAY_ENV.VNPAY_HASH_SECRET,
  ): Record<string, string> {
    transactionNo += 1;
    const fields: Record<string, string> = {
      vnp_ResponseId: randomUUID().replaceAll('-', ''),
      vnp_Command: 'querydr',
      vnp_ResponseCode: '00',
      vnp_Message: 'Success',
      vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
      vnp_TxnRef: paid.payment.txnRef,
      vnp_Amount: String(paid.booking.total * 100),
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20261101170500',
      vnp_TransactionNo: String(transactionNo),
      vnp_TransactionType: '01',
      vnp_TransactionStatus: '00',
      vnp_OrderInfo: `Truy van thanh toan ve ${paid.booking.code}`,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete fields[key];
      else fields[key] = value;
    }
    return {
      ...fields,
      vnp_SecureHash: createHmac('sha512', secret)
        .update(querydrResponseHashData(fields), 'utf8')
        .digest('hex'),
    };
  }

  /** Replaces `fetch`: `answer` sees each recorded request and returns VNPay's reply. */
  function stubVnpay(answer: (body: Record<string, string>) => Promise<Response> | Response): void {
    jest.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
        string,
        string
      >;
      sent.push({ url, body });
      return Promise.resolve(answer(body));
    }) as unknown as typeof fetch);
  }

  const jsonReply = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  /** Everything the expiry may change for one booking. */
  async function stateOf(paid: Pick<Paid, 'booking' | 'showtimeId' | 'seatIds'>) {
    const [booking, payments, seats, tickets, events] = await Promise.all([
      db.prisma.booking.findUniqueOrThrow({
        where: { id: paid.booking.id },
        select: { status: true, confirmedAt: true },
      }),
      db.prisma.payment.findMany({
        where: { bookingId: paid.booking.id },
        select: {
          status: true,
          vnpTransactionNo: true,
          bankCode: true,
          responseCode: true,
          processedAt: true,
          rawPayload: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.prisma.showtimeSeat.findMany({
        where: { showtimeId: paid.showtimeId, seatId: { in: paid.seatIds } },
        select: { seatId: true, status: true, bookingId: true, heldUntil: true },
        orderBy: { seatId: 'asc' },
      }),
      db.prisma.ticket.findMany({
        where: { bookingId: paid.booking.id },
        select: { seatId: true, status: true },
        orderBy: { seatId: 'asc' },
      }),
      db.prisma.outboxEvent.findMany({
        where: { aggregateId: paid.booking.id },
        select: { type: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { booking, payments, seats, tickets, events };
  }

  /**
   * Whole-database rules that must hold after every test here: one live ticket per seat; a
   * CONFIRMED booking owns every one of its seats SOLD; a SOLD seat belongs to a settled booking;
   * no seat left HELD by a booking that is over; a SUCCESS payment only next to a settled booking;
   * one outbox event per settled booking.
   */
  async function violations() {
    const q = <T>(sql: TemplateStringsArray) => db.prisma.$queryRaw<T[]>(sql);
    const [
      duplicateTickets,
      confirmedNotSold,
      soldWithoutPaidBooking,
      heldByOver,
      successNotSettled,
      outboxMismatch,
    ] = await Promise.all([
      q`SELECT showtime_id, seat_id FROM tickets WHERE status <> 'VOID'
          GROUP BY showtime_id, seat_id HAVING count(*) > 1`,
      q`SELECT b.id FROM bookings b
          JOIN booking_seats bs ON bs.booking_id = b.id
          JOIN showtime_seats ss ON ss.showtime_id = bs.showtime_id AND ss.seat_id = bs.seat_id
          WHERE b.status = 'CONFIRMED'
            AND (ss.status <> 'SOLD' OR ss.booking_id IS DISTINCT FROM b.id)`,
      q`SELECT ss.seat_id FROM showtime_seats ss LEFT JOIN bookings b ON b.id = ss.booking_id
          WHERE ss.status = 'SOLD'
            AND (b.id IS NULL OR b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW'))`,
      q`SELECT ss.seat_id FROM showtime_seats ss JOIN bookings b ON b.id = ss.booking_id
          WHERE ss.status = 'HELD' AND b.status IN ('EXPIRED', 'CONFIRMED', 'NEEDS_REVIEW')`,
      q`SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE p.status = 'SUCCESS' AND b.status NOT IN ('CONFIRMED', 'NEEDS_REVIEW')`,
      q`SELECT b.id FROM bookings b LEFT JOIN outbox_events o ON o.aggregate_id = b.id::text
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
      heldByOver,
      successNotSettled,
      outboxMismatch,
    };
  }

  const NO_VIOLATIONS = {
    duplicateTickets: [],
    confirmedNotSold: [],
    soldWithoutPaidBooking: [],
    heldByOver: [],
    successNotSettled: [],
    outboxMismatch: [],
  };

  afterEach(async () => expect(await violations()).toEqual(NO_VIOLATIONS));

  /** Moves the clock past holdUntil and expires the booking, as the job would. */
  async function expireAfterHold(bookingId: string): Promise<ExpireOutcome> {
    clock.advance({ minutes: HOLD_MINUTES });
    return expiry.expire(bookingId);
  }

  // ─── The query itself ───

  describe('the request', () => {
    it('is one signed POST to VNPAY_API_URL, made before anything is written', async () => {
      const paid = await waitingForPayment(1);
      const payment = await db.prisma.payment.findFirstOrThrow({
        where: { txnRef: paid.payment.txnRef },
        select: { createdAt: true },
      });
      stubVnpay(() => jsonReply(querydrResponse(paid)));

      await expireAfterHold(paid.booking.id);

      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(API_URL);
      const body = sent[0]!.body;
      expect(body.vnp_Command).toBe('querydr');
      expect(body.vnp_Version).toBe('2.1.0');
      expect(body.vnp_TmnCode).toBe(VNPAY_ENV.VNPAY_TMN_CODE);
      expect(body.vnp_TxnRef).toBe(paid.payment.txnRef);
      // vnp_TransactionDate must be the vnp_CreateDate of the payment request (GMT+7).
      const created = new Date(payment.createdAt.getTime() + 7 * 3_600_000).toISOString();
      expect(body.vnp_TransactionDate).toBe(created.slice(0, 19).replaceAll(/[-T:]/g, ''));
      expect(body.vnp_SecureHash).toMatch(/^[0-9a-f]{128}$/);
      expect(body.vnp_RequestId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is not made for a booking that is not due yet', async () => {
      const paid = await waitingForPayment(1);
      stubVnpay(() => jsonReply(querydrResponse(paid)));

      // One minute in: expiresAt has not passed, let alone holdUntil.
      clock.advance({ minutes: 1 });
      const result = await expiry.expire(paid.booking.id);

      expect(result.outcome).toBe('early');
      expect(sent).toEqual([]);
    });

    it('is not made for a booking without a PENDING payment', async () => {
      const { showtime, seat } = await scene();
      const user = await newUser();
      const booking = await held(user, showtime.id, [seat('A1')]);
      stubVnpay(() => jsonReply({}));

      clock.advance({ minutes: HOLD_MINUTES });
      const result = await expiry.expire(booking.id);

      expect(result.outcome).toBe('expired');
      expect(sent).toEqual([]);
    });

    it('asks about the newest attempt first and stops at the one that was paid', async () => {
      const paid = await waitingForPayment(1);
      // A second attempt: the customer opened the payment page again.
      const second = await paymentFor(paid.user, paid.booking.id);
      stubVnpay((body) =>
        jsonReply(
          body.vnp_TxnRef === second.txnRef
            ? querydrResponse({ ...paid, payment: second })
            : querydrResponse(paid, { vnp_ResponseCode: '91' }),
        ),
      );

      const result = await expireAfterHold(paid.booking.id);

      expect(result.outcome).toBe('paid');
      expect(sent.map((s) => s.body.vnp_TxnRef)).toEqual([second.txnRef]);
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('CONFIRMED');
      // The attempt nobody paid is left PENDING: its own IPN still decides it.
      expect(state.payments.map((p) => p.status).sort()).toEqual(['PENDING', 'SUCCESS']);
    });
  });

  // ─── querydr says the payment went through ───

  describe('paid', () => {
    it('confirms the booking instead of expiring it: seats SOLD, tickets issued, outbox written', async () => {
      const paid = await waitingForPayment(2);
      const response = querydrResponse(paid);
      stubVnpay(() => jsonReply(response));

      const result = await expireAfterHold(paid.booking.id);

      expect(result.outcome).toBe('paid');
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('CONFIRMED');
      expect(state.booking.confirmedAt).not.toBeNull();
      expect(state.payments).toEqual([
        expect.objectContaining({
          status: 'SUCCESS',
          vnpTransactionNo: response.vnp_TransactionNo,
          bankCode: 'NCB',
          responseCode: '00',
        }),
      ]);
      // raw_payload is the querydr response as received, not a forged IPN.
      expect(state.payments[0]?.rawPayload).toEqual(response);
      expect(state.seats).toEqual(
        paid.seatIds.map((seatId) => ({
          seatId,
          status: 'SOLD',
          bookingId: paid.booking.id,
          heldUntil: null,
        })),
      );
      expect(state.tickets).toEqual(paid.seatIds.map((seatId) => ({ seatId, status: 'ISSUED' })));
      expect(state.events.map((e) => e.type)).toEqual(['booking.confirmed']);
    });

    it('sends the booking to review when another booking already took a seat', async () => {
      const paid = await waitingForPayment(2);
      // Past holdUntil the seats are free again (lazy expiry): someone else takes one and pays.
      clock.advance({ minutes: HOLD_MINUTES });
      const other = await bookAndPay(paid.showtimeId, [paid.seatIds[0]!]);
      const otherIpn = Object.fromEntries(
        new URLSearchParams(
          vnpay.buildSignedQuery(
            {
              vnp_Amount: String(other.booking.total * 100),
              vnp_BankCode: 'NCB',
              vnp_ResponseCode: '00',
              vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
              vnp_TransactionNo: '15339999',
              vnp_TransactionStatus: '00',
              vnp_TxnRef: other.payment.txnRef,
            },
            VNPAY_ENV.VNPAY_HASH_SECRET,
          ),
        ),
      );
      expect((await http().get('/payments/vnpay/ipn').query(otherIpn)).body).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      stubVnpay(() => jsonReply(querydrResponse(paid)));

      const result = await expiry.expire(paid.booking.id);

      expect(result.outcome).toBe('paid');
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('NEEDS_REVIEW');
      expect(state.payments[0]?.status).toBe('SUCCESS');
      expect(state.tickets).toEqual([]);
      // Its own seats are released; the seat the other booking bought is left alone.
      expect(state.seats.map((s) => s.status).sort()).toEqual(['AVAILABLE', 'SOLD']);
      expect(state.events.map((e) => e.type).sort()).toEqual([
        'booking.needs_review',
        'seats.released',
      ]);
    });

    it('takes the seats back for a booking that had already expired (branch B)', async () => {
      const paid = await waitingForPayment(2);
      // A first expiry with no answer from VNPay: the booking EXPIRED and gave its seats back.
      stubVnpay(() => jsonReply(querydrResponse(paid, { vnp_ResponseCode: '91' })));
      expect((await expireAfterHold(paid.booking.id)).outcome).toBe('expired');
      expect((await stateOf(paid)).booking.status).toBe('EXPIRED');

      // The customer had in fact paid, and a later IPN says so.
      const ipn = Object.fromEntries(
        new URLSearchParams(
          vnpay.buildSignedQuery(
            {
              vnp_Amount: String(paid.booking.total * 100),
              vnp_BankCode: 'NCB',
              vnp_ResponseCode: '00',
              vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
              vnp_TransactionNo: '15338888',
              vnp_TransactionStatus: '00',
              vnp_TxnRef: paid.payment.txnRef,
            },
            VNPAY_ENV.VNPAY_HASH_SECRET,
          ),
        ),
      );

      expect((await http().get('/payments/vnpay/ipn').query(ipn)).body).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      const state = await stateOf(paid);
      // Payment EXPIRED is not a final status: money that arrives late is still recorded.
      expect(state.booking.status).toBe('CONFIRMED');
      expect(state.payments[0]?.status).toBe('SUCCESS');
      expect(state.tickets).toHaveLength(2);
    });
  });

  // ─── Everything else: the booking expires exactly as it did before 3.7 ───

  describe('not paid, or no usable answer', () => {
    const expiresAsUsual = async (
      answer: (paid: Paid) => Promise<Response> | Response,
      asks = 1,
    ) => {
      const paid = await waitingForPayment(2);
      stubVnpay(() => answer(paid));

      const result = await expireAfterHold(paid.booking.id);

      expect(result).toEqual({
        outcome: 'expired',
        showtimeId: paid.showtimeId,
        releasedSeatIds: paid.seatIds,
        expiredPaymentIds: [expect.any(String)],
      });
      const state = await stateOf(paid);
      expect(state.booking.status).toBe('EXPIRED');
      // PLAN §4: the attempt is EXPIRED too, with nothing from VNPay recorded on it.
      expect(state.payments).toEqual([
        expect.objectContaining({
          status: 'EXPIRED',
          vnpTransactionNo: null,
          responseCode: null,
          processedAt: null,
          rawPayload: null,
        }),
      ]);
      expect(state.seats.map((s) => [s.status, s.bookingId, s.heldUntil])).toEqual(
        paid.seatIds.map(() => ['AVAILABLE', null, null]),
      );
      expect(state.tickets).toEqual([]);
      expect(state.events).toEqual([]);
      expect(sent).toHaveLength(asks);
      return paid;
    };

    it('vnp_ResponseCode 91: VNPay never saw the transaction', async () => {
      await expiresAsUsual((paid) => jsonReply(querydrResponse(paid, { vnp_ResponseCode: '91' })));
    });

    it.each([
      ['02 the payment failed', '02'],
      ['09 the refund was refused', '09'],
    ])('vnp_TransactionStatus %s', async (_label, status) => {
      await expiresAsUsual((paid) =>
        jsonReply(querydrResponse(paid, { vnp_TransactionStatus: status })),
      );
    });

    it.each([
      ['01 not complete', '01'],
      ['04 reversed at the bank', '04'],
      ['07 suspected fraud', '07'],
    ])('vnp_TransactionStatus %s is not settled: unknown', async (_label, status) => {
      await expiresAsUsual((paid) =>
        jsonReply(querydrResponse(paid, { vnp_TransactionStatus: status })),
      );
    });

    it('a response signed with another secret is never acted on', async () => {
      await expiresAsUsual((paid) => jsonReply(querydrResponse(paid, {}, 'another-secret')));
    });

    it('a response about another payment is never acted on', async () => {
      await expiresAsUsual((paid) =>
        jsonReply(querydrResponse(paid, { vnp_TxnRef: 'ZZZZZZZZZZZZZZZZZZZZ' })),
      );
    });

    it('a network error does not break the job', async () => {
      await expiresAsUsual(() => Promise.reject(new TypeError('fetch failed')));
    });

    it('a timeout does not break the job', async () => {
      await expiresAsUsual(() =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
        ),
      );
    });

    it('HTTP 500 from VNPay does not break the job', async () => {
      await expiresAsUsual(() => new Response('oops', { status: 500 }));
    });

    it('a body that is not JSON does not break the job', async () => {
      await expiresAsUsual(() => new Response('<html>maintenance</html>', { status: 200 }));
    });

    it('a "paid" answer whose amount does not match the row writes nothing', async () => {
      // The only answer that reaches confirmPayment and is then refused there: the amount check
      // runs under the payment's own lock, so a wrong amount can never confirm a booking.
      await expiresAsUsual((paid) => jsonReply(querydrResponse(paid, { vnp_Amount: '1' })));
    });

    it('the sweep reports no failure when VNPay is unreachable', async () => {
      const paid = await waitingForPayment(1);
      stubVnpay(() => Promise.reject(new TypeError('fetch failed')));

      clock.advance({ minutes: HOLD_MINUTES });
      const report = await expiry.sweep();

      expect(report.failed).toBe(0);
      expect(report.busy).toBe(0);
      expect(report.outcomes.expired).toBeGreaterThanOrEqual(1);
      expect((await stateOf(paid)).booking.status).toBe('EXPIRED');
    });
  });
});
