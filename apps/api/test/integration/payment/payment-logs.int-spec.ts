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
} from '@ticketify/shared';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { LOG_DESTINATION } from '../../../src/config/logger.module';
import { ClockService } from '../../../src/infra/clock/clock.service';
import { FakeClock } from '../../../src/infra/clock/testing/fake-clock';
import { AccessTokenIssuer } from '../../../src/modules/auth/tokens/access-token.issuer';
import { TicketCodes } from '../../../src/modules/payment/seat-settlement';
import { VnpayService } from '../../../src/modules/payment/vnpay/vnpay.service';
import { appTestEnv } from '../../support/app-env';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { bodyOf } from '../../support/http';
import { createTestRedis, type TestRedis } from '../../support/redis';

/** 17:00 Sunday 2026-11-01 in Vietnam. */
const NOW = '2026-11-01T10:00:00.000Z';
/** Test-only merchant settings; never a real secret. */
const VNPAY_ENV = {
  VNPAY_TMN_CODE: 'TKFTEST1',
  VNPAY_HASH_SECRET: 'logs-test-vnpay-hash-secret-7f3c9a',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_RETURN_URL: 'http://localhost:5173/payment/result',
} as const;
/** pino-http logs a request once its response has finished; give that a moment. */
const LOG_FLUSH_MS = 100;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Ticket codes the test can pin to one value, to make one IPN fail with a database error. */
class ControllableTicketCodes extends TicketCodes {
  constant: string | null = null;
  override next(): string {
    return this.constant ?? super.next();
  }
}

/**
 * What the API writes to its log while the VNPay return page and the IPN are called with signed
 * queries: real HMAC-SHA512 signatures (128 hex characters, made with the test merchant secret)
 * and forged ones of the same shape. Every line pino writes — the pino-http request log and the
 * Nest loggers (`app.useLogger`, as in main.ts) — goes to a stream the test reads.
 */
describe('Payment logs never carry signatures or secrets (real Postgres + Redis)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: INestApplication<App>;
  let adminId: string;
  const clock = new FakeClock(NOW);
  const ticketCodes = new ControllableTicketCodes();
  const vnpay = new VnpayService();
  const lines: string[] = [];
  const capture: DestinationStream = { write: (line: string) => void lines.push(line) };

  beforeAll(async () => {
    [db, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
    Object.assign(
      process.env,
      appTestEnv({ databaseUrl: db.url, redisUrl: redis.url }, { LOG_LEVEL: 'info', ...VNPAY_ENV }),
    );
    const { AppModule } = await import('../../../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService)
      .useValue(clock)
      .overrideProvider(TicketCodes)
      .useValue(ticketCodes)
      .overrideProvider(LOG_DESTINATION)
      .useValue(capture)
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();
    adminId = (
      await db.prisma.user.create({
        data: {
          email: `admin-${randomUUID()}@test.local`,
          passwordHash: 'not-a-real-hash',
          fullName: 'Logs Admin',
          role: Role.ADMIN,
        },
      })
    ).id;
    await db.prisma.seatPrice.createMany({
      data: Object.values(SeatType).flatMap((seatType) =>
        Object.values(DayType).map((dayType) => ({ seatType, dayType, price: 90_000 })),
      ),
    });
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.drop(), redis?.close()]);
  });

  const http = () => request(app.getHttpServer());
  const tokenOf = (id: string, role: Role) => app.get(AccessTokenIssuer).issue({ id, role }).token;

  /** A user with a PENDING booking of two seats and one PENDING payment for it. */
  async function paidBooking(n: number) {
    const auth = { Authorization: `Bearer ${tokenOf(adminId, Role.ADMIN)}` };
    const roomRes = await http()
      .post('/admin/rooms')
      .set(auth)
      .send({ name: `Phòng Logs ${n}`, rows: 1, cols: 12 });
    expect(roomRes.status).toBe(201);
    const room = bodyOf<AdminRoom>(roomRes);
    const movie = await db.prisma.movie.create({
      data: {
        title: `Logs Movie ${n}`,
        slug: `logs-movie-${randomUUID()}`,
        duration: 100,
        ageRating: 'P',
        releaseDate: new FakeClock('2026-10-01').now(),
      },
    });
    const showtimeRes = await http()
      .post('/admin/showtimes')
      .set(auth)
      .send({ movieId: movie.id, roomId: room.id, startsAt: '2026-11-02T19:00:00+07:00' });
    expect(showtimeRes.status).toBe(201);
    const showtime = bodyOf<CreatedShowtime>(showtimeRes);

    const user = await db.prisma.user.create({
      data: {
        email: `logs-${n}-${randomUUID()}@test.local`,
        passwordHash: 'not-a-real-hash',
        fullName: `Logs User ${n}`,
      },
    });
    const userAuth = { Authorization: `Bearer ${tokenOf(user.id, Role.USER)}` };
    const holdRes = await http()
      .post('/bookings')
      .set(userAuth)
      .set('Idempotency-Key', randomUUID())
      .send({ showtimeId: showtime.id, seatIds: room.seats.slice(0, 2).map((s) => s.id) });
    expect(holdRes.status).toBe(201);
    const booking = bodyOf<Booking>(holdRes);
    const payRes = await http()
      .post('/payments/vnpay')
      .set(userAuth)
      .send({ bookingId: booking.id });
    expect(payRes.status).toBe(201);
    return { booking, payment: bodyOf<CreatedVnpayPayment>(payRes) };
  }

  /** Every vnp_SecureHash value sent, real or forged: none of them may appear in the log. */
  const signatures: string[] = [];

  /** What VNPay sends back (return URL and IPN carry the same parameters), signed with `secret`. */
  function signedQuery(
    paid: { booking: Booking; payment: CreatedVnpayPayment },
    overrides: Record<string, string> = {},
    secret: string = VNPAY_ENV.VNPAY_HASH_SECRET,
  ): Record<string, string> {
    const query = Object.fromEntries(
      new URLSearchParams(
        vnpay.buildSignedQuery(
          {
            vnp_Amount: String(paid.booking.total * 100),
            vnp_BankCode: 'NCB',
            vnp_BankTranNo: 'VNP14226112',
            vnp_CardType: 'ATM',
            vnp_OrderInfo: `Thanh toan ve ${paid.booking.code}`,
            vnp_PayDate: '20261101170500',
            vnp_ResponseCode: '00',
            vnp_TmnCode: VNPAY_ENV.VNPAY_TMN_CODE,
            vnp_TransactionNo: String(14_226_112 + signatures.length),
            vnp_TransactionStatus: '00',
            vnp_TxnRef: paid.payment.txnRef,
            ...overrides,
          },
          secret,
        ),
      ),
    );
    expect(query.vnp_SecureHash).toMatch(/^[0-9a-f]{128}$/);
    signatures.push(query.vnp_SecureHash!);
    return query;
  }

  it('return page and IPN, signed and forged, success, retry and 500: no signature, no secret', async () => {
    const first = await paidBooking(1);
    const second = await paidBooking(2);
    const answers: string[] = [];
    const call = async (path: string, query: Record<string, string>) => {
      const res = await http().get(path).query(query);
      answers.push(`${path} ${res.status} ${JSON.stringify(res.body)}`);
      return res;
    };

    // Return page: a valid signature, then the same query signed with another secret.
    expect((await call('/payments/vnpay/return', signedQuery(first))).body).toMatchObject({
      verified: true,
    });
    const forged = signedQuery(first, {}, 'not-the-merchant-secret');
    expect((await call('/payments/vnpay/return', forged)).body).toEqual({ verified: false });

    // IPN: forged (97), wrong amount (04), paid (00), repeated (02).
    expect((await call('/payments/vnpay/ipn', forged)).body).toMatchObject({ RspCode: '97' });
    expect(
      (await call('/payments/vnpay/ipn', signedQuery(first, { vnp_Amount: '100' }))).body,
    ).toMatchObject({ RspCode: '04' });
    const paid = signedQuery(first);
    expect((await call('/payments/vnpay/ipn', paid)).body).toMatchObject({ RspCode: '00' });
    expect((await call('/payments/vnpay/ipn', paid)).body).toMatchObject({ RspCode: '02' });

    // IPN that fails in the database (duplicate ticket codes): 500, logged with its stack.
    ticketCodes.constant = 'DUPLICATE2CD';
    const failing = await call('/payments/vnpay/ipn', signedQuery(second));
    ticketCodes.constant = null;
    expect(failing.status).toBe(500);
    expect(failing.body).toEqual({ RspCode: '99', Message: 'Unknown error' });

    await pause(LOG_FLUSH_MS);
    const log = lines.join('');

    // The log did record these requests (the test is not looking at an empty log).
    // pino-http's own line per request: 'request completed', or 'request errored' for a 5xx.
    const requestLines = lines.filter((line) => /"msg":"request (completed|errored)"/.test(line));
    expect(requestLines.filter((line) => line.includes('request errored'))).toHaveLength(1);
    expect(requestLines.filter((line) => line.includes('/payments/vnpay/return'))).toHaveLength(2);
    expect(requestLines.filter((line) => line.includes('/payments/vnpay/ipn'))).toHaveLength(5);
    expect(log).toContain(`vnp_TxnRef=${first.payment.txnRef}`);
    for (const text of ['IPN 97', 'IPN 04', 'IPN 00', 'IPN 02', 'IPN 500', 'tickets_code_key']) {
      expect(log).toContain(text);
    }

    // …and none of it carries a signature, the parameter that holds it, or the secret.
    expect(signatures).toHaveLength(5);
    for (const signature of signatures) {
      expect(log).not.toContain(signature);
      expect(log.toUpperCase()).not.toContain(signature.toUpperCase());
    }
    expect(log).not.toContain('vnp_SecureHash');
    expect(log).not.toContain('SecureHash');
    expect(log).not.toContain('HashSecret');
    expect(log).not.toContain(VNPAY_ENV.VNPAY_HASH_SECRET);
    expect(answers).toHaveLength(7);
  });
});
