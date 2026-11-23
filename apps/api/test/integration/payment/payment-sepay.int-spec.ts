import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  type AdminRoom,
  type Booking,
  type CreatedSepayPayment,
  createdSepayPaymentSchema,
  type CreatedShowtime,
  DayType,
  Role,
  SeatType,
  SepayTransactionOutcome,
} from '@ticketify/shared';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { LOG_DESTINATION } from '../../../src/config/logger.module';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { OutboxEventType } from '../../../src/infra/outbox/outbox-events';
import { OUTBOX_POLL_INTERVAL_MS } from '../../../src/infra/outbox/outbox-relay.service';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { SWEEP_INTERVAL_MS } from '../../../src/modules/bookings/booking-expiry.processor';
import { BookingExpiryService } from '../../../src/modules/bookings/booking-expiry.service';
import { signSepayWebhook } from '../../../src/modules/payment/sepay/sepay-webhook.validator';
import { VnpayQuerydrClient } from '../../../src/modules/payment/vnpay/vnpay-querydr.client';
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
const SEAT_PRICE = 90_000;
/** Test-only SePay settings; never real ones. */
const SEPAY = {
  secret: 'integration-test-sepay-webhook-secret-0123',
  accountNumber: '0071000888999',
  bankCode: 'MBBank',
  holder: 'CONG TY TICKETIFY TEST',
  prefix: 'TKF',
} as const;
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

describe('SePay bank transfer — create, webhook, late transfers (real Postgres + Redis, signed webhooks over HTTP)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let workerRef: TestingModule;
  let expiry: BookingExpiryService;
  let adminId: string;
  const clock = new FakeClock(NOW);
  const vnpay = new VnpayService();
  const channelKey = `ticketify-test:${randomUUID()}`;
  const lines: string[] = [];
  const capture: DestinationStream = { write: (line: string) => void lines.push(line) };

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    // First: the env is read once, when the module graph is imported.
    Object.assign(
      process.env,
      appTestEnv(
        { databaseUrl: db.url, redisUrl: redis.url },
        {
          LOG_LEVEL: 'info',
          HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
          PAYMENT_GRACE_SECONDS: String(PAYMENT_GRACE_SECONDS),
          PAYMENT_RATE_LIMIT_MAX: '1000',
          SEPAY_WEBHOOK_SECRET: SEPAY.secret,
          SEPAY_BANK_ACCOUNT_NUMBER: SEPAY.accountNumber,
          SEPAY_BANK_CODE: SEPAY.bankCode,
          SEPAY_ACCOUNT_HOLDER: SEPAY.holder,
          SEPAY_PAYMENT_CODE_PREFIX: SEPAY.prefix,
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
      .overrideProvider(LOG_DESTINATION)
      .useValue(capture)
      .compile();
    // As main.ts: rawBody for the signature, pino as the Nest logger.
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
      bufferLogs: true,
    });
    app.useLogger(app.get(Logger));
    await app.init();
    adminId = (
      await db.prisma.user.create({
        data: {
          email: `admin-${randomUUID()}@test.local`,
          passwordHash: 'not-a-real-hash',
          fullName: 'SePay Admin',
          role: Role.ADMIN,
        },
      })
    ).id;
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: SEAT_PRICE })),
      ),
    });

    // Worker side, compiled but not started: the test drives the expiry itself.
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
      .overrideProvider(LOG_DESTINATION)
      .useValue(capture)
      .compile();
    expiry = workerRef.get(BookingExpiryService);
  });

  afterAll(async () => {
    await workerRef?.close();
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  beforeEach(() => clock.set(NOW));
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
        email: `sepay-${userCounter}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `SePay User ${userCounter}`,
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
      name: `Phòng SePay ${counter}`,
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
          title: 'SePay Movie',
          slug: `sepay-movie-${randomUUID()}`,
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

  const holdSeats = (user: TestUser, showtimeId: string, seatIds: string[]) =>
    http()
      .post('/bookings')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId, seatIds });

  /** A user with a fresh PENDING booking of two seats (2 × 90 000 ₫). */
  async function pendingBooking() {
    const { showtime, seat } = await scene();
    const user = await newUser();
    const seatIds = [seat('A1'), seat('A2')];
    const res = await holdSeats(user, showtime.id, seatIds);
    expect(res.status).toBe(201);
    return { user, booking: bodyOf<Booking>(res), showtimeId: showtime.id, seatIds };
  }

  const paySepay = (user: TestUser, body: object) =>
    http()
      .post('/payments/sepay')
      .set('Authorization', `Bearer ${tokenOf(user)}`)
      .send(body);

  async function sepayPayment(user: TestUser, bookingId: string): Promise<CreatedSepayPayment> {
    const res = await paySepay(user, { bookingId });
    expect(res.status).toBe(201);
    return createdSepayPaymentSchema.parse(res.body);
  }

  const paymentOf = (id: string) =>
    db.prisma.payment.findUniqueOrThrow({
      where: { id },
      select: {
        provider: true,
        txnRef: true,
        amount: true,
        status: true,
        providerTransactionId: true,
        vnpTransactionNo: true,
        bankCode: true,
      },
    });

  const bookingStatus = async (id: string) =>
    (await db.prisma.booking.findUniqueOrThrow({ where: { id } })).status;

  const outboxTypes = async (bookingId: string) =>
    (
      await db.prisma.outboxEvent.findMany({
        where: { aggregateId: bookingId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.type);

  const ticketsOf = (bookingId: string) => db.prisma.ticket.count({ where: { bookingId } });

  const ledgerOf = (sepayId: number) =>
    db.prisma.sepayTransaction.findMany({
      where: { sepayId: BigInt(sepayId) },
      select: { outcome: true, paymentId: true, reference: true, transferAmount: true },
    });

  /** SePay transaction ids: one per bank transaction, the same on every delivery of it. */
  let sepayIds = 7_000_000;
  const nextSepayId = () => ++sepayIds;

  /** The webhook body SePay would send for a transfer paying `created` exactly. */
  function transfer(
    created: CreatedSepayPayment,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: nextSepayId(),
      gateway: 'MBBank',
      transactionDate: '2026-11-01 17:02:00',
      accountNumber: SEPAY.accountNumber,
      subAccount: '',
      code: created.transferContent,
      content: `${created.transferContent} thanh toan ve`,
      transferType: 'in',
      transferAmount: created.amount,
      accumulated: 0,
      referenceCode: 'SB2611010001',
      description: '',
      ...overrides,
    };
  }

  interface SignOptions {
    secret?: string;
    /** Unix seconds; default the fake clock's now. */
    timestamp?: string;
    /** Sign this body but send another one. */
    sentBody?: string;
    contentType?: string;
    skipHeaders?: boolean;
  }

  /** POSTs `body` as SePay does: raw JSON, signed `{timestamp}.{raw body}`. */
  function deliver(body: unknown, options: SignOptions = {}) {
    const raw = JSON.stringify(body);
    const timestamp = options.timestamp ?? String(Math.floor(clock.now().getTime() / 1000));
    const signature = signSepayWebhook(options.secret ?? SEPAY.secret, timestamp, Buffer.from(raw));
    let req = http()
      .post('/payments/sepay/webhook')
      .set('Content-Type', options.contentType ?? 'application/json');
    if (!options.skipHeaders) {
      req = req.set('X-SePay-Timestamp', timestamp).set('X-SePay-Signature', signature);
    }
    return req.send(options.sentBody ?? raw);
  }

  async function expectNoViolations() {
    expect(await paymentViolations(db.prisma)).toEqual(NO_PAYMENT_VIOLATIONS);
  }

  // ─── Creation ───

  describe('POST /payments/sepay', () => {
    it('201: a Payment PENDING (SEPAY) whose code is the transfer content; the QR names account, bank, amount and code', async () => {
      const { user, booking } = await pendingBooking();

      const created = await sepayPayment(user, booking.id);

      expect(created).toMatchObject({
        provider: 'SEPAY',
        amount: booking.total,
        bankCode: SEPAY.bankCode,
        accountNumber: SEPAY.accountNumber,
        accountHolder: SEPAY.holder,
        expiresAt: booking.expiresAt,
        reused: false,
      });
      expect(created.transferContent).toMatch(/^TKF\d{8}$/);
      const qr = new URL(created.qrCodeUrl);
      expect(qr.origin + qr.pathname).toBe('https://vietqr.app/img');
      expect(Object.fromEntries(qr.searchParams)).toMatchObject({
        acc: SEPAY.accountNumber,
        bank: SEPAY.bankCode,
        amount: String(booking.total),
        des: created.transferContent,
      });
      expect(JSON.stringify(created)).not.toContain(SEPAY.secret);
      expect(await paymentOf(created.paymentId)).toEqual({
        provider: 'SEPAY',
        txnRef: created.transferContent,
        amount: booking.total,
        status: 'PENDING',
        providerTransactionId: null,
        vnpTransactionNo: null,
        bankCode: null,
      });
      expect(await bookingStatus(booking.id)).toBe('PENDING');
    });

    it('called again while PENDING: the same attempt and code', async () => {
      const { user, booking } = await pendingBooking();
      const first = await sepayPayment(user, booking.id);

      const again = await sepayPayment(user, booking.id);

      expect(again).toEqual({ ...first, reused: true });
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('five clicks at once: one payment row, one code, no 5xx', async () => {
      const { user, booking } = await pendingBooking();
      const errors = captureServerErrors();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => paySepay(user, { bookingId: booking.id })),
      );

      expect(formatServerErrors(errors.errors)).toBe('');
      errors.restore();
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(
        new Set(results.map((r) => (r.body as CreatedSepayPayment).transferContent)).size,
      ).toBe(1);
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('400: an amount in the body is refused; the amount always comes from the booking', async () => {
      const { user, booking } = await pendingBooking();

      const res = await paySepay(user, { bookingId: booking.id, amount: 1_000 });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it("404: another user's booking; nothing written", async () => {
      const { booking } = await pendingBooking();

      const res = await paySepay(await newUser(), { bookingId: booking.id });

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('BOOKING_NOT_FOUND');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('422: the booking expired; nothing written', async () => {
      const { user, booking } = await pendingBooking();
      clock.set(booking.expiresAt);

      const res = await paySepay(user, { bookingId: booking.id });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('BOOKING_EXPIRED');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('409: the booking is already paid; no new attempt', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      expect((await deliver(transfer(created))).status).toBe(200);

      const res = await paySepay(user, { bookingId: booking.id });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('BOOKING_NOT_PAYABLE');
      expect(await db.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });
  });

  // ─── Webhook ───

  describe('POST /payments/sepay/webhook', () => {
    it('a matching incoming transfer: 200 {"success":true}, Payment SUCCESS, booking CONFIRMED, tickets, one booking.confirmed', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const body = transfer(created);

      const res = await deliver(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(await paymentOf(created.paymentId)).toMatchObject({
        status: 'SUCCESS',
        providerTransactionId: String(body.id),
        vnpTransactionNo: null,
        bankCode: 'MBBank',
      });
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      expect(await ticketsOf(booking.id)).toBe(2);
      expect(await outboxTypes(booking.id)).toEqual([OutboxEventType.BOOKING_CONFIRMED]);
      expect(await ledgerOf(body.id as number)).toEqual([
        {
          outcome: SepayTransactionOutcome.SETTLED,
          paymentId: created.paymentId,
          reference: created.transferContent,
          transferAmount: BigInt(created.amount),
        },
      ]);
      await expectNoViolations();
    });

    it(`${DUPLICATES} identical deliveries at once, then a retry: all 200, one ledger row, one confirmation, one event`, async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const body = transfer(created);
      const errors = captureServerErrors();

      const results = await Promise.all(Array.from({ length: DUPLICATES }, () => deliver(body)));
      const retry = await deliver(body);

      expect(formatServerErrors(errors.errors)).toBe('');
      errors.restore();
      expect([...results, retry].map((r) => r.status)).toEqual(Array(DUPLICATES + 1).fill(200));
      expect(await ledgerOf(body.id as number)).toHaveLength(1);
      expect(await ticketsOf(booking.id)).toBe(2);
      expect(await outboxTypes(booking.id)).toEqual([OutboxEventType.BOOKING_CONFIRMED]);
      await expectNoViolations();
    });

    it('a second, different transfer for the same code: recorded DUPLICATE_TRANSFER, nothing else changes', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const first = transfer(created);
      await deliver(first);

      const second = transfer(created);
      const res = await deliver(second);

      expect(res.status).toBe(200);
      expect(await ledgerOf(second.id as number)).toEqual([
        expect.objectContaining({
          outcome: SepayTransactionOutcome.DUPLICATE_TRANSFER,
          paymentId: created.paymentId,
        }),
      ]);
      expect((await paymentOf(created.paymentId)).providerTransactionId).toBe(String(first.id));
      expect(await ticketsOf(booking.id)).toBe(2);
      expect(await outboxTypes(booking.id)).toEqual([OutboxEventType.BOOKING_CONFIRMED]);
      await expectNoViolations();
    });

    it('the code only in a bank-decorated content (SePay code null): still settled', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);

      const res = await deliver(
        transfer(created, {
          code: null,
          content: `MBVCB.9912.${created.transferContent.toLowerCase()}.CT tu 0123 NGUYEN VAN A`,
        }),
      );

      expect(res.status).toBe(200);
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
    });

    it.each<[string, SignOptions]>([
      ['signed with another secret', { secret: 'another-secret-0123456789abc' }],
      // The marker is replaced below by the signed body with another amount.
      ['a body changed after signing', { sentBody: 'tampered' }],
      [
        'a timestamp 301 s old (replay)',
        { timestamp: String(Math.floor(Date.parse(NOW) / 1000) - 301) },
      ],
      ['no signature headers', { skipHeaders: true }],
    ])('401 when %s: nothing written', async (_label, options) => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const body = transfer(created);
      const opts: SignOptions = { ...options };
      if (options.sentBody) opts.sentBody = JSON.stringify({ ...body, transferAmount: 1_000 });

      const res = await deliver(body, opts);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, message: 'Invalid signature' });
      expect(await ledgerOf(body.id as number)).toEqual([]);
      expect((await paymentOf(created.paymentId)).status).toBe('PENDING');
      expect(await bookingStatus(booking.id)).toBe('PENDING');
    });

    it.each([
      ['a string amount', { transferAmount: '180000' }, undefined],
      ['an unexpected transferType', { transferType: 'refund' }, undefined],
      ['no accountNumber', { accountNumber: undefined }, undefined],
      ['a form-encoded body', {}, 'application/x-www-form-urlencoded'],
    ])('400 for %s (signed): nothing written', async (_label, overrides, contentType) => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const body = transfer(created, overrides);

      const res = await deliver(body, contentType ? { contentType } : {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'Invalid payload' });
      expect(await ledgerOf(body.id as number)).toEqual([]);
      expect((await paymentOf(created.paymentId)).status).toBe('PENDING');
    });

    it.each([
      ['money going out', { transferType: 'out' }, SepayTransactionOutcome.OUTGOING],
      [
        'another receiving account',
        { accountNumber: '1234567890' },
        SepayTransactionOutcome.WRONG_ACCOUNT,
      ],
      ['too little', { transferAmount: 179_999 }, SepayTransactionOutcome.AMOUNT_MISMATCH],
      ['too much', { transferAmount: 180_001 }, SepayTransactionOutcome.AMOUNT_MISMATCH],
      [
        'no payment code',
        { code: null, content: 'chuyen tien' },
        SepayTransactionOutcome.NO_REFERENCE,
      ],
      [
        'an unknown payment code',
        { code: 'TKF99999999', content: 'TKF99999999' },
        SepayTransactionOutcome.UNKNOWN_REFERENCE,
      ],
    ])(
      '%s: 200, recorded as %s, the payment and booking unchanged',
      async (_label, overrides, outcome) => {
        const { user, booking } = await pendingBooking();
        const created = await sepayPayment(user, booking.id);
        const body = transfer(created, overrides);

        const res = await deliver(body);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(await ledgerOf(body.id as number)).toEqual([expect.objectContaining({ outcome })]);
        expect(await paymentOf(created.paymentId)).toMatchObject({
          status: 'PENDING',
          providerTransactionId: null,
        });
        expect(await bookingStatus(booking.id)).toBe('PENDING');
        expect(await outboxTypes(booking.id)).toEqual([]);
      },
    );

    it('a wrong amount, then the right one: the right one confirms the booking', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      await deliver(transfer(created, { transferAmount: 1_000 }));

      expect((await deliver(transfer(created))).status).toBe(200);

      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      await expectNoViolations();
    });

    it('a late transfer after the expiry, seats still free: recorded, seats taken back (branch B), CONFIRMED; VNPay was never asked', async () => {
      const lookUp = jest.spyOn(workerRef.get(VnpayQuerydrClient), 'lookUp');
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      clock.advance({ minutes: HOLD_MINUTES });
      expect((await expiry.expire(booking.id)).outcome).toBe('expired');
      expect(lookUp).not.toHaveBeenCalled();
      expect((await paymentOf(created.paymentId)).status).toBe('EXPIRED');

      expect((await deliver(transfer(created))).status).toBe(200);

      expect((await paymentOf(created.paymentId)).status).toBe('SUCCESS');
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      expect(await ticketsOf(booking.id)).toBe(2);
      await expectNoViolations();
    });

    it('a late transfer after another customer took the seats: Payment SUCCESS, booking NEEDS_REVIEW, no ticket', async () => {
      const { user, booking, showtimeId, seatIds } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      clock.advance({ minutes: HOLD_MINUTES });
      expect((await expiry.expire(booking.id)).outcome).toBe('expired');
      expect((await holdSeats(await newUser(), showtimeId, seatIds)).status).toBe(201);

      expect((await deliver(transfer(created))).status).toBe(200);

      expect((await paymentOf(created.paymentId)).status).toBe('SUCCESS');
      expect(await bookingStatus(booking.id)).toBe('NEEDS_REVIEW');
      expect(await ticketsOf(booking.id)).toBe(0);
      expect(await outboxTypes(booking.id)).toContain(OutboxEventType.BOOKING_NEEDS_REVIEW);
      await expectNoViolations();
    });

    it('paid with VNPay first, then the transfer arrives: the SePay payment is REFUND_REQUIRED, named SEPAY in the event', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const vnpayRes = await http()
        .post('/payments/vnpay')
        .set('Authorization', `Bearer ${tokenOf(user)}`)
        .send({ bookingId: booking.id });
      expect(vnpayRes.status).toBe(201);
      const vnpayIpn = vnpay.buildSignedQuery(
        {
          vnp_Amount: String(booking.total * 100),
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: '00',
          vnp_TransactionNo: '14226199',
          vnp_TxnRef: (vnpayRes.body as { txnRef: string }).txnRef,
        },
        VNPAY_ENV.VNPAY_HASH_SECRET,
      );
      expect((await http().get(`/payments/vnpay/ipn?${vnpayIpn}`)).body).toMatchObject({
        RspCode: '00',
      });
      const body = transfer(created);

      expect((await deliver(body)).status).toBe(200);

      expect(await paymentOf(created.paymentId)).toMatchObject({
        status: 'REFUND_REQUIRED',
        providerTransactionId: String(body.id),
      });
      const refund = await db.prisma.outboxEvent.findFirstOrThrow({
        where: { type: OutboxEventType.PAYMENT_REFUND_REQUIRED, aggregateId: created.paymentId },
      });
      expect(refund.payload).toMatchObject({
        provider: 'SEPAY',
        providerTransactionId: String(body.id),
        vnpTransactionNo: null,
      });
      expect(await ledgerOf(body.id as number)).toEqual([
        expect.objectContaining({ outcome: SepayTransactionOutcome.SETTLED }),
      ]);
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      expect(await ticketsOf(booking.id)).toBe(2);
      await expectNoViolations();
    });

    it('logs never carry the webhook secret or the signature', async () => {
      const { user, booking } = await pendingBooking();
      const created = await sepayPayment(user, booking.id);
      const body = transfer(created);
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const signature = signSepayWebhook(SEPAY.secret, timestamp, Buffer.from(raw));
      lines.length = 0;

      await deliver(body);
      await deliver(body, { secret: 'another-secret-0123456789abc' });

      const log = lines.join('');
      expect(log).toContain('/payments/sepay/webhook');
      expect(log).not.toContain(SEPAY.secret);
      expect(log).not.toContain(signature.slice('sha256='.length));
      expect(log.toLowerCase()).not.toContain('"x-sepay-signature":"sha256=');
    });
  });
});
