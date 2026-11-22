import { HttpException, Logger } from '@nestjs/common';
import {
  BookingStatus,
  PaymentErrorCode,
  PaymentStatus,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import { FakeClock } from '../../../infra/clock/testing/fake-clock';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { SeatEvents } from '../../realtime/seat-events';
import { TicketCodes } from '../seat-settlement';
import { mockTx, type Statement, writes } from '../testing/mock-tx';
import type { MomoClient, MomoCreateAnswer, MomoCreateSettings } from './momo.client';
import { MomoPaymentService } from './momo-payment.service';
import { generateMomoSignature, type MomoSignable } from './momo-signature';
import { momoSample } from './testing/momo-sample';

const at = (iso: string) => new FakeClock(iso).now();
const NOW = at('2026-11-01T10:05:00.000Z');
const EXPIRES_AT = at('2026-11-01T10:10:00.000Z');
const HELD_UNTIL = at('2026-11-01T10:15:00.000Z');
const USER_ID = '01a17e75-7100-7679-b8b1-0000000000e1';
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';
const { credentials } = momoSample;
const ORDER_ID = 'Bq2qmIzmEDBQ2nWyKR55';
const REQUEST_ID = '5f0c6d1e9a8b4c3d2e1f0a9b8c7d6e5f';
const PAY_URL = 'https://test-payment.momo.vn/v2/gateway/pay?t=abc';
const AMOUNT = 180_000;

const settings: MomoCreateSettings = {
  ...credentials,
  redirectUrl: 'http://localhost:5173/payment/result/momo',
  ipnUrl: 'https://api.example.test/payments/momo/ipn',
};

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

/** A signed IPN body, as MoMo POSTs it. */
function signedIpn(
  overrides: Record<string, string | number> = {},
  secretKey = credentials.secretKey,
) {
  const fields = { ...momoSample.cases.ipnSuccess.fields, ...overrides };
  const signature = generateMomoSignature('result', fields as MomoSignable<'result'>, {
    accessKey: credentials.accessKey,
    secretKey,
  });
  return { ...fields, signature };
}

interface SetupOptions {
  /** Rows answered, in order, by `$queryRaw` inside the transaction. */
  txRows?: unknown[][];
  txAffected?: number[];
  /** Rows answered, in order, by `$queryRaw` outside any transaction. */
  rows?: unknown[][];
  /** Row counts answered, in order, by `$executeRaw` outside any transaction. */
  affected?: number[];
  createAnswer?: MomoCreateAnswer;
  configured?: boolean;
  findFirst?: unknown;
}

function setup(options: SetupOptions = {}) {
  const { tx, statements, mock } = mockTx(options.txRows ?? [], options.txAffected ?? []);
  const inserted: unknown[] = [];
  Object.assign(mock, {
    payment: {
      createManyAndReturn: jest.fn(({ data }: { data: unknown[] }) => {
        inserted.push(...data);
        return Promise.resolve([{ id: PAYMENT_ID }]);
      }),
    },
  });
  const outside: Statement[] = [];
  const rows = [...(options.rows ?? [])];
  const affected = [...(options.affected ?? [])];
  const record = (strings: TemplateStringsArray, values: unknown[]) =>
    outside.push({ sql: strings.join('$').replace(/\s+/g, ' ').trim(), values });
  const prisma = {
    $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(rows.shift() ?? []);
    }),
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return Promise.resolve(affected.shift() ?? 0);
    }),
    payment: { findFirst: jest.fn(() => Promise.resolve(options.findFirst ?? null)) },
  };
  const configured = options.configured ?? true;
  const momo = {
    createSettings: jest.fn(() => (configured ? settings : null)),
    merchant: jest.fn(() => (configured ? credentials : null)),
    create: jest.fn(() =>
      Promise.resolve(options.createAnswer ?? { kind: 'created', payUrl: PAY_URL, resultCode: 0 }),
    ),
  };
  const seatEvents = { sold: jest.fn(), released: jest.fn() };
  const service = new MomoPaymentService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW.toISOString()),
    momo as unknown as MomoClient,
    seatEvents as unknown as SeatEvents,
    new TicketCodes(),
  );
  return { service, prisma, momo, statements, outside, inserted, seatEvents };
}

const bookingRow = (overrides: Record<string, unknown> = {}) => [
  {
    code: 'K7PX3MQ9TA',
    status: BookingStatus.PENDING,
    total: AMOUNT,
    expires_at: EXPIRES_AT,
    ...overrides,
  },
];
const openAttempt = (payUrl: string | null) => [
  {
    id: PAYMENT_ID,
    txn_ref: ORDER_ID,
    provider_request_id: REQUEST_ID,
    pay_url: payUrl,
    amount: AMOUNT,
  },
];

/** The API error a promise rejected with: HTTP status and `code`. */
async function apiErrorOf(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((e: unknown) => e);
  if (!(error instanceof HttpException))
    throw new Error(`Expected an HttpException, got ${String(error)}`);
  return { status: error.getStatus(), code: (error.getResponse() as { code: string }).code };
}

const create = (service: MomoPaymentService) =>
  service.create({ userId: USER_ID, bookingId: BOOKING_ID });

describe('MomoPaymentService.create', () => {
  it('a new attempt: booking locked FOR NO KEY UPDATE by id and owner, Payment PENDING MOMO, MoMo called, payUrl stored', async () => {
    const { service, momo, statements, outside, inserted } = setup({
      txRows: [bookingRow(), [], []],
      affected: [1],
    });

    const created = await create(service);

    expect(created).toEqual({
      paymentId: PAYMENT_ID,
      orderId: expect.stringMatching(/^[A-Za-z0-9]{20}$/) as unknown,
      payUrl: PAY_URL,
      expiresAt: EXPIRES_AT.toISOString(),
      reused: false,
    });
    expect(statements[0]?.sql).toMatch(
      /FROM bookings WHERE id = \$::uuid AND user_id = \$::uuid FOR NO KEY UPDATE$/,
    );
    expect(statements[0]?.values).toEqual([BOOKING_ID, USER_ID]);
    expect(inserted).toEqual([
      {
        bookingId: BOOKING_ID,
        provider: 'MOMO',
        txnRef: created.orderId,
        providerRequestId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
        amount: AMOUNT,
        status: PaymentStatus.PENDING,
        createdAt: NOW,
      },
    ]);
    const [row] = inserted as { providerRequestId: string }[];
    expect(momo.create).toHaveBeenCalledWith(settings, {
      orderId: created.orderId,
      requestId: row!.providerRequestId,
      amount: AMOUNT,
      orderInfo: 'Thanh toan ve K7PX3MQ9TA',
    });
    expect(outside).toEqual([
      {
        sql: "UPDATE payments SET pay_url = $, updated_at = $ WHERE id = $::uuid AND status = 'PENDING' AND provider = 'MOMO'",
        values: [PAY_URL, NOW, PAYMENT_ID],
      },
    ]);
  });

  it('the amount is the booking total from the database, never anything else', async () => {
    const { service, momo } = setup({
      txRows: [bookingRow({ total: 95_000 }), [], []],
      affected: [1],
    });

    await create(service);
    expect(momo.create).toHaveBeenCalledWith(settings, expect.objectContaining({ amount: 95_000 }));
  });

  it('not configured: 503 PAYMENT_NOT_CONFIGURED before any database work', async () => {
    const { service, prisma } = setup({ configured: false });

    await expect(apiErrorOf(create(service))).resolves.toEqual({
      status: 503,
      code: PaymentErrorCode.PAYMENT_NOT_CONFIGURED,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'another user’s booking (no row): 404 BOOKING_NOT_FOUND',
      [[]],
      404,
      PaymentErrorCode.BOOKING_NOT_FOUND,
    ],
    [
      'a CONFIRMED booking: 409 BOOKING_NOT_PAYABLE',
      [bookingRow({ status: BookingStatus.CONFIRMED })],
      409,
      PaymentErrorCode.BOOKING_NOT_PAYABLE,
    ],
    [
      'an EXPIRED booking: 409 BOOKING_NOT_PAYABLE',
      [bookingRow({ status: BookingStatus.EXPIRED })],
      409,
      PaymentErrorCode.BOOKING_NOT_PAYABLE,
    ],
    [
      'expiresAt passed: 422 BOOKING_EXPIRED',
      [bookingRow({ expires_at: NOW })],
      422,
      PaymentErrorCode.BOOKING_EXPIRED,
    ],
    [
      'already paid: 409 BOOKING_ALREADY_PAID',
      [bookingRow(), [{ id: 'paid' }]],
      409,
      PaymentErrorCode.BOOKING_ALREADY_PAID,
    ],
    [
      '999 VND: 422 PAYMENT_AMOUNT_NOT_SUPPORTED',
      [bookingRow({ total: 999 }), []],
      422,
      PaymentErrorCode.PAYMENT_AMOUNT_NOT_SUPPORTED,
    ],
    [
      '50 000 001 VND: 422 PAYMENT_AMOUNT_NOT_SUPPORTED',
      [bookingRow({ total: 50_000_001 }), []],
      422,
      PaymentErrorCode.PAYMENT_AMOUNT_NOT_SUPPORTED,
    ],
    [
      'nothing to pay: 409 BOOKING_NOT_PAYABLE',
      [bookingRow({ total: 0 }), []],
      409,
      PaymentErrorCode.BOOKING_NOT_PAYABLE,
    ],
  ])('%s; nothing written, MoMo not called', async (_label, txRows, status, code) => {
    const { service, momo, statements, inserted } = setup({ txRows });

    await expect(apiErrorOf(create(service))).resolves.toEqual({ status, code });
    expect(writes(statements)).toEqual([]);
    expect(inserted).toEqual([]);
    expect(momo.create).not.toHaveBeenCalled();
  });

  it('an open attempt with a payment page: handed back (reused), no insert, MoMo not called', async () => {
    const { service, momo, inserted, outside } = setup({
      txRows: [bookingRow(), [], openAttempt(PAY_URL)],
    });

    await expect(create(service)).resolves.toEqual({
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      payUrl: PAY_URL,
      expiresAt: EXPIRES_AT.toISOString(),
      reused: true,
    });
    expect(inserted).toEqual([]);
    expect(momo.create).not.toHaveBeenCalled();
    expect(outside).toEqual([]);
  });

  it('an open attempt without a page (an earlier timeout): the SAME orderId and requestId are re-sent', async () => {
    const { service, momo, inserted } = setup({
      txRows: [bookingRow(), [], openAttempt(null)],
      affected: [1],
    });

    await expect(create(service)).resolves.toMatchObject({ orderId: ORDER_ID, reused: true });
    expect(inserted).toEqual([]);
    expect(momo.create).toHaveBeenCalledWith(
      settings,
      expect.objectContaining({ orderId: ORDER_ID, requestId: REQUEST_ID }),
    );
  });

  it('MoMo refuses (final error): the attempt FAILED (it never had a page), 502 PAYMENT_PROVIDER_ERROR', async () => {
    const { service, outside } = setup({
      txRows: [bookingRow(), [], []],
      affected: [1],
      createAnswer: {
        kind: 'refused',
        resultCode: 21,
        message: 'Số tiền không hợp lệ',
        body: { resultCode: 21 },
      },
    });

    await expect(apiErrorOf(create(service))).resolves.toEqual({
      status: 502,
      code: PaymentErrorCode.PAYMENT_PROVIDER_ERROR,
    });
    expect(outside).toHaveLength(1);
    expect(outside[0]?.sql).toContain("SET status = 'FAILED', response_code = $");
    expect(outside[0]?.sql).toContain(
      "WHERE id = $::uuid AND status = 'PENDING' AND pay_url IS NULL",
    );
    expect(outside[0]?.values.slice(0, 2)).toEqual(['21', JSON.stringify({ resultCode: 21 })]);
  });

  it.each([
    ['a timeout', { kind: 'unavailable', reason: 'timed out after 30000 ms', timedOut: true }],
    [
      'MoMo still processing (7000)',
      { kind: 'unavailable', reason: 'resultCode 7000', timedOut: false },
    ],
  ] as const)(
    '%s: 503 PAYMENT_PROVIDER_UNAVAILABLE, the attempt stays PENDING untouched',
    async (_label, createAnswer) => {
      const { service, outside } = setup({ txRows: [bookingRow(), [], []], createAnswer });

      await expect(apiErrorOf(create(service))).resolves.toEqual({
        status: 503,
        code: PaymentErrorCode.PAYMENT_PROVIDER_UNAVAILABLE,
      });
      expect(outside).toEqual([]);
    },
  );

  it('created, but the attempt closed meanwhile (expired): the page is not handed out, 409', async () => {
    const { service } = setup({ txRows: [bookingRow(), [], []], affected: [0] });

    await expect(apiErrorOf(create(service))).resolves.toEqual({
      status: 409,
      code: PaymentErrorCode.BOOKING_NOT_PAYABLE,
    });
  });
});

describe('MomoPaymentService.ipn', () => {
  const known = [{ provider_request_id: REQUEST_ID }];
  const paymentRow = (status: PaymentStatus = PaymentStatus.PENDING, amount = AMOUNT) => [
    { id: PAYMENT_ID, booking_id: BOOKING_ID, amount, status },
  ];
  const bookingLocked = [
    {
      id: BOOKING_ID,
      code: 'K7PX3MQ9TA',
      user_id: USER_ID,
      showtime_id: SHOWTIME_ID,
      status: BookingStatus.PENDING,
    },
  ];
  const seats = [
    {
      seat_id: SEAT_A,
      status: ShowtimeSeatStatus.HELD,
      booking_id: BOOKING_ID,
      held_until: HELD_UNTIL,
    },
  ];
  const showtime = [
    {
      status: ShowtimeStatus.SCHEDULED,
      starts_at: at('2026-11-02T12:00:00.000Z'),
      ends_at: at('2026-11-02T13:55:00.000Z'),
    },
  ];

  it('a valid success: settled like a VNPay IPN (payment by orderId AND provider MOMO), CONFIRMED, seat:sold, 204', async () => {
    const { service, statements, seatEvents } = setup({
      rows: [known],
      txRows: [paymentRow(), bookingLocked, [], seats, showtime],
      txAffected: [1, 1, 1],
    });

    await expect(service.ipn(signedIpn())).resolves.toEqual({
      acknowledged: true,
      outcome: 'confirmed',
    });
    expect(statements[0]?.sql).toMatch(
      /WHERE txn_ref = \$ AND provider = \$::payment_provider FOR UPDATE$/,
    );
    expect(statements[0]?.values).toEqual([ORDER_ID, 'MOMO']);
    const success = statements.find((s) => s.sql.includes("SET status = 'SUCCESS'"));
    // MoMo's transId goes to provider_transaction_id; vnp_transaction_no stays NULL.
    expect(success?.values.slice(0, 2)).toEqual([null, '4088878653']);
    expect(seatEvents.sold).toHaveBeenCalledWith(SHOWTIME_ID, [SEAT_A]);
  });

  it('a failure (1006, user declined): Payment FAILED, booking untouched, 204', async () => {
    const { service, statements } = setup({
      rows: [known],
      txRows: [paymentRow()],
      txAffected: [1],
    });

    await expect(
      service.ipn(signedIpn({ resultCode: 1006, message: 'declined' })),
    ).resolves.toEqual({
      acknowledged: true,
      outcome: 'failed',
    });
    expect(writes(statements).map((s) => s.sql.slice(0, 40))).toEqual([
      "UPDATE payments SET status = 'FAILED', b",
    ]);
  });

  it('a duplicate IPN (payment already SUCCESS): nothing written, 204', async () => {
    const { service, statements } = setup({
      rows: [known],
      txRows: [paymentRow(PaymentStatus.SUCCESS)],
    });

    await expect(service.ipn(signedIpn())).resolves.toEqual({
      acknowledged: true,
      outcome: 'already_processed',
    });
    expect(writes(statements)).toEqual([]);
  });

  it('an amount that is not the payment’s: nothing written, 204 (and an error log)', async () => {
    const { service, statements } = setup({
      rows: [known],
      txRows: [paymentRow(PaymentStatus.PENDING, 90_000)],
    });

    await expect(service.ipn(signedIpn())).resolves.toEqual({
      acknowledged: true,
      outcome: 'invalid_amount',
    });
    expect(writes(statements)).toEqual([]);
  });

  it.each([1000, 7000, 9000])(
    'not final yet (%i): nothing looked up under lock, nothing written, 204',
    async (resultCode) => {
      const { service, prisma } = setup({ rows: [known] });

      await expect(service.ipn(signedIpn({ resultCode }))).resolves.toEqual({
        acknowledged: true,
        outcome: 'pending',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('an unknown orderId (correctly signed): ignored, 204, nothing written', async () => {
    const { service, prisma } = setup({ rows: [[]] });

    await expect(service.ipn(signedIpn())).resolves.toEqual({
      acknowledged: true,
      outcome: 'ignored',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a requestId that is not the one the order was created with: ignored, 204', async () => {
    const { service, prisma } = setup({ rows: [[{ provider_request_id: 'f'.repeat(32) }]] });

    await expect(service.ipn(signedIpn())).resolves.toEqual({
      acknowledged: true,
      outcome: 'ignored',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid signature (another secret)', () => signedIpn({}, 'another-secret')],
    ['a modified amount', () => ({ ...signedIpn(), amount: 1_000 })],
    ['a modified resultCode', () => ({ ...signedIpn({ resultCode: 1006 }), resultCode: 0 })],
    ['no signature', () => ({ ...signedIpn(), signature: undefined })],
    ['a missing field', () => ({ ...signedIpn(), transId: undefined })],
    ['not an object', () => 'resultCode=0'],
    ['an array', () => [signedIpn()]],
    ['another partnerCode (signed)', () => signedIpn({ partnerCode: 'MOMOOTHER' })],
  ])('%s: rejected (400), no database work at all', async (_label, body) => {
    const { service, prisma } = setup();

    await expect(service.ipn(body())).resolves.toMatchObject({ acknowledged: false });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no MoMo keys on this server: throws (500, MoMo calls again), nothing read', async () => {
    const { service, prisma } = setup({ configured: false });

    await expect(service.ipn(signedIpn())).rejects.toThrow('cannot be verified');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('MomoPaymentService.verifyReturn', () => {
  const asQuery = (body: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)]));
  const stored = {
    bookingId: BOOKING_ID,
    status: PaymentStatus.PENDING,
    amount: AMOUNT,
    providerRequestId: REQUEST_ID,
  };

  it('a signed redirect: verified, with the status as stored (PENDING until the IPN), nothing written', async () => {
    const { service, prisma } = setup({ findFirst: stored });

    await expect(service.verifyReturn(asQuery(signedIpn()))).resolves.toEqual({
      verified: true,
      bookingId: BOOKING_ID,
      paymentStatus: PaymentStatus.PENDING,
      resultCode: 0,
      amountMismatch: false,
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a redirect whose amount differs from the payment: verified, amountMismatch', async () => {
    const { service } = setup({ findFirst: { ...stored, amount: 90_000 } });
    await expect(service.verifyReturn(asQuery(signedIpn()))).resolves.toMatchObject({
      amountMismatch: true,
    });
  });

  it.each([
    ['a bad signature', asQuery(signedIpn({}, 'another-secret')), stored],
    ['a repeated key (array)', { ...asQuery(signedIpn()), orderId: [ORDER_ID, ORDER_ID] }, stored],
    ['an unknown orderId', asQuery(signedIpn()), null],
    ['another requestId', asQuery(signedIpn()), { ...stored, providerRequestId: 'f'.repeat(32) }],
  ])('%s: { verified: false } and nothing else', async (_label, query, findFirst) => {
    const { service } = setup({ findFirst });
    await expect(service.verifyReturn(query)).resolves.toEqual({ verified: false });
  });
});
