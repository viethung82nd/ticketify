import { Logger } from '@nestjs/common';
import {
  BookingStatus,
  PaymentStatus,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import type { Response } from 'express';
import type { AppConfig } from '../../config/app-config.service';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { SeatEvents } from '../realtime/seat-events';
import type { PaymentRateLimiter } from './payment-rate-limiter';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { TicketCodes } from './seat-settlement';
import { mockTx, writes } from './testing/mock-tx';
import { VnpayService } from './vnpay/vnpay.service';

const NOW = '2026-11-01T10:05:00.000Z';
const SECRET = 'unit-test-vnpay-hash-secret';
const TXN_REF = 'Bq2qmIzmEDBQ2nWyKR55';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';

const vnpay = new VnpayService();

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

/** An IPN query as Express parses it, signed with `secret`. */
function signedIpn(
  overrides: Record<string, string> = {},
  secret = SECRET,
): Record<string, string> {
  const query = vnpay.buildSignedQuery(
    {
      vnp_Amount: '9000000',
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: 'Thanh toan ve K7PX3MQ9TA',
      vnp_PayDate: '20261101170500',
      vnp_ResponseCode: '00',
      vnp_TmnCode: 'TKFTEST1',
      vnp_TransactionNo: '14226112',
      vnp_TransactionStatus: '00',
      vnp_TxnRef: TXN_REF,
      ...overrides,
    },
    secret,
  );
  return Object.fromEntries(new URLSearchParams(query));
}

function setup(rows: unknown[][] = [], affected: number[] = [], secret: string | null = SECRET) {
  const { tx, statements } = mockTx(rows, affected);
  const prisma = { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
  const config = {
    get: jest.fn((key: string) =>
      key === 'VNPAY_HASH_SECRET' ? (secret ?? undefined) : undefined,
    ),
  };
  const seatEvents = { sold: jest.fn() };
  const service = new PaymentService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    vnpay,
    config as unknown as AppConfig,
    seatEvents as unknown as SeatEvents,
    new TicketCodes(),
  );
  return { service, prisma, statements, seatEvents };
}

describe('PaymentService.vnpayIpn', () => {
  it('97 for a bad signature: no transaction is opened', async () => {
    const { service, prisma } = setup();

    await expect(service.vnpayIpn(signedIpn({}, 'another-secret'))).resolves.toEqual({
      RspCode: '97',
      Message: 'Invalid signature',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('97 for a parameter changed after signing (vnp_Amount)', async () => {
    const { service, prisma } = setup();
    const query = { ...signedIpn(), vnp_Amount: '9000100' };

    expect((await service.vnpayIpn(query)).RspCode).toBe('97');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('97 for an empty query and for a repeated parameter', async () => {
    const { service } = setup();

    expect((await service.vnpayIpn({})).RspCode).toBe('97');
    const query = { ...signedIpn(), vnp_TxnRef: [TXN_REF, TXN_REF] };
    expect((await service.vnpayIpn(query)).RspCode).toBe('97');
  });

  it('01 for a signed IPN without vnp_TxnRef: no transaction is opened', async () => {
    const { service, prisma } = setup();
    const query = signedIpn({ vnp_TxnRef: '' });

    await expect(service.vnpayIpn(query)).resolves.toEqual({
      RspCode: '01',
      Message: 'Order not found',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('01 for an unknown txnRef (inside the transaction), nothing written', async () => {
    const { service, prisma, statements } = setup([[]]);

    expect((await service.vnpayIpn(signedIpn())).RspCode).toBe('01');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 10_000,
    });
    expect(writes(statements)).toEqual([]);
  });

  it('04 and 02 come from confirmPayment', async () => {
    const amount = setup([
      [{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 1, status: 'PENDING' }],
    ]);
    expect((await amount.service.vnpayIpn(signedIpn())).RspCode).toBe('04');

    const done = setup([
      [{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 90_000, status: PaymentStatus.SUCCESS }],
    ]);
    expect(await done.service.vnpayIpn(signedIpn())).toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });
  });

  it('00 on success, and seat:sold for the sold seats only after the transaction', async () => {
    const { service, seatEvents } = setup(
      [
        [{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 90_000, status: 'PENDING' }],
        [
          {
            id: BOOKING_ID,
            code: 'K7PX3MQ9TA',
            user_id: BOOKING_ID,
            showtime_id: SHOWTIME_ID,
            status: BookingStatus.PENDING,
          },
        ],
        [],
        [
          {
            seat_id: SEAT_A,
            status: ShowtimeSeatStatus.HELD,
            booking_id: BOOKING_ID,
            held_until: null,
          },
        ],
        [{ status: ShowtimeStatus.SCHEDULED, starts_at: new FakeClock('2026-11-02').now() }],
      ],
      [1, 1, 1],
    );

    await expect(service.vnpayIpn(signedIpn())).resolves.toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    expect(seatEvents.sold).toHaveBeenCalledWith(SHOWTIME_ID, [SEAT_A]);
  });

  it('00 for a failed payment, and no seat event', async () => {
    const { service, seatEvents } = setup(
      [[{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 90_000, status: 'PENDING' }]],
      [1],
    );

    const query = signedIpn({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02' });
    expect((await service.vnpayIpn(query)).RspCode).toBe('00');
    expect(seatEvents.sold).not.toHaveBeenCalled();
  });

  it('throws (→ 500) without a hash secret, before reading anything', async () => {
    const { service, prisma } = setup([], [], null);

    await expect(service.vnpayIpn(signedIpn())).rejects.toThrow('VNPAY_HASH_SECRET is not set');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PaymentsController.vnpayIpn', () => {
  const response = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  };
  const controller = (vnpayIpn: jest.Mock) =>
    new PaymentsController(
      { vnpayIpn } as unknown as PaymentService,
      {} as unknown as PaymentRateLimiter,
    );

  it('HTTP 200 with the service answer, whatever the RspCode', async () => {
    const res = response();
    const answer = { RspCode: '97', Message: 'Invalid signature' };

    await controller(jest.fn().mockResolvedValue(answer)).vnpayIpn({}, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(answer);
  });

  it('HTTP 500 with RspCode 99 when the service throws (VNPay calls again)', async () => {
    const res = response();
    const failing = jest.fn().mockRejectedValue(new Error('connection terminated'));

    await controller(failing).vnpayIpn({ vnp_TxnRef: TXN_REF }, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ RspCode: '99', Message: 'Unknown error' });
  });
});
