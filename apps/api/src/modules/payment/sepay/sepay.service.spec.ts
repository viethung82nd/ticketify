import { HttpException, Logger } from '@nestjs/common';
import {
  BookingStatus,
  PaymentErrorCode,
  PaymentProvider,
  PaymentStatus,
  SepayTransactionOutcome,
} from '@ticketify/shared';
import { FakeClock } from '../../../infra/clock/testing/fake-clock';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { SeatEvents } from '../../realtime/seat-events';
import { TicketCodes } from '../seat-settlement';
import { mockTx, writes } from '../testing/mock-tx';
import type { SepayConfig, SepaySettings } from './sepay.config';
import { type SepayDelivery, SepayPaymentService } from './sepay-payment.service';
import { signSepayWebhook } from './sepay-webhook.validator';
import { sepaySample, sepaySampleBody } from './testing/sepay-sample';

const NOW = new FakeClock(sepaySample.timestampIso).now();
const EXPIRES_AT = new Date(NOW.getTime() + 5 * 60_000);
const USER_ID = '01a17e75-7100-7679-b8b1-0000000000e1';
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const LEDGER_ID = '01a17e75-7100-7679-b8b1-0000000000d1';
const AMOUNT = 180_000;
const CODE = 'TKF04817263';

const settings: SepaySettings = {
  webhookSecret: sepaySample.secret,
  accountNumber: sepaySample.accountNumber,
  bankCode: sepaySample.bankCode,
  accountHolder: 'CONG TY TICKETIFY',
  paymentCodePrefix: sepaySample.prefix,
};

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

interface SetupOptions {
  txRows?: unknown[][];
  txAffected?: number[];
  configured?: boolean;
  /** `false`: the ledger insert finds the SePay id already there (a repeated delivery). */
  ledgerInserted?: boolean;
}

function setup(options: SetupOptions = {}) {
  const { tx, statements, mock } = mockTx(options.txRows ?? [], options.txAffected ?? []);
  const insertedPayments: unknown[] = [];
  const insertedLedger: Record<string, unknown>[] = [];
  Object.assign(mock, {
    payment: {
      createManyAndReturn: jest.fn(({ data }: { data: unknown[] }) => {
        insertedPayments.push(...data);
        return Promise.resolve([{ id: PAYMENT_ID }]);
      }),
    },
    sepayTransaction: {
      createManyAndReturn: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
        insertedLedger.push(...data);
        return Promise.resolve(options.ledgerInserted === false ? [] : [{ id: LEDGER_ID }]);
      }),
    },
  });
  const prisma = { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
  const config = {
    settings: jest.fn(() => (options.configured === false ? null : settings)),
  };
  const seatEvents = { sold: jest.fn(), released: jest.fn() };
  const service = new SepayPaymentService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW.toISOString()),
    config as unknown as SepayConfig,
    seatEvents as unknown as SeatEvents,
    new TicketCodes(),
  );
  return { service, prisma, statements, insertedPayments, insertedLedger, seatEvents };
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

async function apiErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { code: string };
    return { status: error.getStatus(), code: body.code };
  }
  throw new Error('expected the promise to reject');
}

/** A delivery SePay would send for `body`, signed now with the test secret. */
function delivery(
  body: Record<string, unknown> = sepaySampleBody(),
  overrides: Partial<SepayDelivery> = {},
): SepayDelivery {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    body,
    rawBody,
    headers: {
      'x-sepay-timestamp': sepaySample.timestamp,
      'x-sepay-signature': signSepayWebhook(sepaySample.secret, sepaySample.timestamp, rawBody),
    },
    contentType: 'application/json',
    ...overrides,
  };
}

describe('SepayPaymentService.create', () => {
  const input = { userId: USER_ID, bookingId: BOOKING_ID };

  it('opens a PENDING SePay attempt with a new payment code and returns the QR details', async () => {
    const { service, insertedPayments } = setup({ txRows: [bookingRow(), [], []] });

    const created = await service.create(input);

    expect(insertedPayments).toEqual([
      expect.objectContaining({
        bookingId: BOOKING_ID,
        provider: PaymentProvider.SEPAY,
        txnRef: expect.stringMatching(/^TKF\d{8}$/) as unknown,
        amount: AMOUNT,
        status: PaymentStatus.PENDING,
      }),
    ]);
    const code = (insertedPayments[0] as { txnRef: string }).txnRef;
    expect(created).toEqual({
      paymentId: PAYMENT_ID,
      provider: 'SEPAY',
      amount: AMOUNT,
      transferContent: code,
      qrCodeUrl: expect.stringContaining(`des=${code}`) as unknown,
      bankCode: settings.bankCode,
      accountNumber: settings.accountNumber,
      accountHolder: settings.accountHolder,
      expiresAt: EXPIRES_AT.toISOString(),
      reused: false,
    });
    expect(created.qrCodeUrl).toContain(`amount=${AMOUNT}`);
    expect(JSON.stringify(created)).not.toContain(sepaySample.secret);
  });

  it('hands the open attempt back instead of opening a second one', async () => {
    const { service, insertedPayments, statements } = setup({
      txRows: [bookingRow(), [], [{ id: PAYMENT_ID, txn_ref: CODE, amount: AMOUNT }]],
    });

    const created = await service.create(input);

    expect(created).toMatchObject({ paymentId: PAYMENT_ID, transferContent: CODE, reused: true });
    expect(insertedPayments).toEqual([]);
    expect(statements[0]?.sql).toContain('FOR NO KEY UPDATE');
  });

  it('answers 503 PAYMENT_NOT_CONFIGURED without touching the database', async () => {
    const { service, prisma } = setup({ configured: false });
    expect(await apiErrorOf(service.create(input))).toEqual({
      status: 503,
      code: PaymentErrorCode.PAYMENT_NOT_CONFIGURED,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['another user’s booking', [[]], 404, PaymentErrorCode.BOOKING_NOT_FOUND],
    [
      'an expired booking',
      [bookingRow({ expires_at: NOW })],
      422,
      PaymentErrorCode.BOOKING_EXPIRED,
    ],
    [
      'a booking that is no longer PENDING',
      [bookingRow({ status: BookingStatus.CONFIRMED })],
      409,
      PaymentErrorCode.BOOKING_NOT_PAYABLE,
    ],
    [
      'an already paid booking',
      [bookingRow(), [{ id: 'paid' }]],
      409,
      PaymentErrorCode.BOOKING_ALREADY_PAID,
    ],
  ])('refuses %s with the shared payment errors', async (_label, txRows, status, code) => {
    const { service, insertedPayments } = setup({ txRows });
    expect(await apiErrorOf(service.create(input))).toEqual({ status, code });
    expect(insertedPayments).toEqual([]);
  });
});

describe('SepayPaymentService.webhook', () => {
  it('answers 503 and reads nothing when SePay is not configured', async () => {
    const { service, prisma } = setup({ configured: false });
    expect(await service.webhook(delivery())).toEqual({
      status: 503,
      reason: expect.any(String) as unknown,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['no signature', { headers: { 'x-sepay-timestamp': sepaySample.timestamp } }],
    [
      'a signature made with another secret',
      {
        headers: {
          'x-sepay-timestamp': sepaySample.timestamp,
          'x-sepay-signature': signSepayWebhook(
            'another-secret-0123456789',
            sepaySample.timestamp,
            Buffer.from(JSON.stringify(sepaySampleBody())),
          ),
        },
      },
    ],
    ['no raw body', { rawBody: undefined }],
  ])('answers 401 for %s and writes nothing', async (_label, overrides) => {
    const { service, prisma } = setup();
    expect(await service.webhook(delivery(sepaySampleBody(), overrides))).toEqual({
      status: 401,
      reason: 'Invalid signature',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 401 for a correctly signed but stale delivery (replay)', async () => {
    const body = sepaySampleBody();
    const rawBody = Buffer.from(JSON.stringify(body));
    const old = String(Number(sepaySample.timestamp) - 301);
    const { service, prisma } = setup();
    const result = await service.webhook(
      delivery(body, {
        headers: {
          'x-sepay-timestamp': old,
          'x-sepay-signature': signSepayWebhook(sepaySample.secret, old, rawBody),
        },
      }),
    );
    expect(result.status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a form-encoded delivery',
      sepaySampleBody(),
      { contentType: 'application/x-www-form-urlencoded' },
    ],
    ['an unknown transferType', { ...sepaySampleBody(), transferType: 'refund' }, {}],
    ['a string amount', { ...sepaySampleBody(), transferAmount: '180000' }, {}],
  ])('answers 400 for %s and writes nothing', async (_label, body, overrides) => {
    const { service, prisma } = setup();
    expect(await service.webhook(delivery(body, overrides))).toEqual({
      status: 400,
      reason: 'Invalid payload',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['money going out', { transferType: 'out' }, SepayTransactionOutcome.OUTGOING],
    [
      'another receiving account',
      { accountNumber: '9999999999' },
      SepayTransactionOutcome.WRONG_ACCOUNT,
    ],
    [
      'no payment code',
      { code: null, content: 'chuyen tien an trua' },
      SepayTransactionOutcome.NO_REFERENCE,
    ],
  ])('records %s without settling anything', async (_label, overrides, outcome) => {
    const { service, statements, insertedLedger } = setup();
    expect(await service.webhook(delivery({ ...sepaySampleBody(), ...overrides }))).toEqual({
      status: 200,
      outcome,
    });
    expect(insertedLedger).toEqual([expect.objectContaining({ sepayId: 92704n, outcome })]);
    expect(statements).toEqual([]);
  });

  it('accepts a transfer to the configured account through its VA (subAccount)', async () => {
    const { service, statements } = setup({ txRows: [[]] });
    await service.webhook(
      delivery({ ...sepaySampleBody(), accountNumber: '0001112223', subAccount: '1017588888' }),
    );
    expect(statements[0]?.sql).toContain('FROM payments');
  });

  it('does nothing more for a SePay id already received (repeated delivery)', async () => {
    const { service, statements } = setup({ ledgerInserted: false });
    expect(await service.webhook(delivery())).toEqual({ status: 200, outcome: 'duplicate' });
    expect(statements).toEqual([]);
  });

  it('settles through settlePayment: the SePay payment of that code, locked first', async () => {
    const { service, statements, insertedLedger } = setup({ txRows: [[]] });

    const result = await service.webhook(delivery());

    expect(insertedLedger).toEqual([
      expect.objectContaining({
        sepayId: 92704n,
        transferType: 'in',
        transferAmount: 180_000n,
        reference: CODE,
        subAccount: null,
        rawPayload: expect.objectContaining({ id: 92704 }) as unknown,
      }),
    ]);
    expect(statements[0]?.sql).toMatch(
      /FROM payments WHERE txn_ref = \$ AND provider = \$::payment_provider FOR UPDATE/,
    );
    expect(statements[0]?.values).toEqual([CODE, PaymentProvider.SEPAY]);
    // No payment has this code: recorded as such.
    expect(result).toEqual({ status: 200, outcome: SepayTransactionOutcome.UNKNOWN_REFERENCE });
    expect(writes(statements).at(-1)?.values).toEqual([
      SepayTransactionOutcome.UNKNOWN_REFERENCE,
      null,
      LEDGER_ID,
    ]);
  });

  it('records a wrong amount and leaves the payment untouched', async () => {
    const { service, statements } = setup({
      txRows: [[{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 200_000, status: 'PENDING' }]],
    });

    expect(await service.webhook(delivery())).toEqual({
      status: 200,
      outcome: SepayTransactionOutcome.AMOUNT_MISMATCH,
    });
    const written = writes(statements);
    expect(written).toHaveLength(1);
    expect(written[0]?.sql).toContain('UPDATE sepay_transactions');
    expect(written[0]?.values).toEqual([
      SepayTransactionOutcome.AMOUNT_MISMATCH,
      PAYMENT_ID,
      LEDGER_ID,
    ]);
  });

  it('records a second transfer for a payment already SUCCESS as DUPLICATE_TRANSFER', async () => {
    const { service, statements } = setup({
      txRows: [[{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: AMOUNT, status: 'SUCCESS' }]],
    });

    expect(await service.webhook(delivery())).toEqual({
      status: 200,
      outcome: SepayTransactionOutcome.DUPLICATE_TRANSFER,
    });
    expect(writes(statements).map((s) => s.sql.split(' ')[1])).toEqual(['sepay_transactions']);
  });

  it('logs money that came in but was not applied as one structured error', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = setup({
      txRows: [[{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 200_000, status: 'PENDING' }]],
    });
    await service.webhook(delivery());
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sepay.transfer_unapplied',
        sepayId: 92704,
        outcome: SepayTransactionOutcome.AMOUNT_MISMATCH,
        paymentId: PAYMENT_ID,
        expectedAmount: '200000',
      }),
      expect.any(String),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(sepaySample.secret);
  });
});
