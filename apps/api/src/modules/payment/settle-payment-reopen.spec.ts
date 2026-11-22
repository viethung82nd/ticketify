import {
  BookingStatus,
  PaymentProvider,
  PaymentStatus,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { confirmPayment, settlePayment } from './confirm-payment';
import type { PaymentReport } from './payment-report';
import { mockTx, writes } from './testing/mock-tx';

/**
 * A verified paid answer after a recorded failure (review H2, 11/2026): MoMo reopens the FAILED
 * payment and records the money through the usual steps; VNPay keeps FAILED final (ROADMAP 3.4).
 */
const at = (iso: string) => new FakeClock(iso).now();
const NOW = at('2026-11-01T10:05:00.000Z');
const HELD_UNTIL = at('2026-11-01T10:15:00.000Z');
const ORDER_ID = 'Bq2qmIzmEDBQ2nWyKR55';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const OTHER_PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f2';
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const USER_ID = '01a17e75-7100-7679-b8b1-0000000000e1';
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';
const AMOUNT = 180_000;

const momoReport = (overrides: Partial<PaymentReport> = {}): PaymentReport => ({
  amount: String(AMOUNT),
  paid: true,
  responseCode: '0',
  transactionStatus: null,
  bankCode: null,
  transactionNo: '4088878653',
  raw: { orderId: ORDER_ID, resultCode: 0 },
  ...overrides,
});

const paymentRow = (status: PaymentStatus) => [
  { id: PAYMENT_ID, booking_id: BOOKING_ID, amount: AMOUNT, status },
];
const bookingRow = (status: BookingStatus) => [
  { id: BOOKING_ID, code: 'K7PX3MQ9TA', user_id: USER_ID, showtime_id: SHOWTIME_ID, status },
];
const heldSeats = [
  {
    seat_id: SEAT_A,
    status: ShowtimeSeatStatus.HELD,
    booking_id: BOOKING_ID,
    held_until: HELD_UNTIL,
  },
];
const showtimeRow = [
  {
    status: ShowtimeStatus.SCHEDULED,
    starts_at: at('2026-11-02T12:00:00.000Z'),
    ends_at: at('2026-11-02T13:55:00.000Z'),
  },
];

let codes = 0;
const settleMomo = (rows: unknown[][], affected: number[], report = momoReport()) => {
  const mock = mockTx(rows, affected);
  return {
    ...mock,
    result: settlePayment(mock.tx, {
      provider: PaymentProvider.MOMO,
      txnRef: ORDER_ID,
      report,
      now: NOW,
      ticketCode: () => `CODE${++codes}`,
    }),
  };
};

describe('settlePayment — a MoMo payment recorded FAILED, then reported paid', () => {
  it('booking still PENDING with its seats: reopened, SUCCESS, CONFIRMED with tickets, flagged afterFailure', async () => {
    const { result, statements, mock } = settleMomo(
      [
        paymentRow(PaymentStatus.FAILED),
        bookingRow(BookingStatus.PENDING),
        [],
        heldSeats,
        showtimeRow,
      ],
      [1, 1, 1],
    );

    await expect(result).resolves.toMatchObject({
      outcome: 'confirmed',
      paymentId: PAYMENT_ID,
      seatIds: [SEAT_A],
      afterFailure: true,
    });
    const success = writes(statements).find((s) => s.sql.includes("SET status = 'SUCCESS'"));
    // MoMo's transId in provider_transaction_id; vnp_transaction_no stays NULL.
    expect(success?.values.slice(0, 2)).toEqual([null, '4088878653']);
    expect(mock.ticket.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mock.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('booking already paid by another payment: REFUND_REQUIRED with the transId, outbox, no ticket', async () => {
    const { result, statements, mock } = settleMomo(
      [
        paymentRow(PaymentStatus.FAILED),
        bookingRow(BookingStatus.CONFIRMED),
        [{ id: OTHER_PAYMENT_ID }],
      ],
      [1],
    );

    await expect(result).resolves.toEqual({
      outcome: 'paid_twice',
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      paidPaymentId: OTHER_PAYMENT_ID,
      transactionNo: '4088878653',
      afterFailure: true,
    });
    const [update] = writes(statements);
    expect(update?.sql).toContain("SET status = 'REFUND_REQUIRED'");
    const [event] = mock.outboxEvent.create.mock.calls[0]!;
    expect(event.data).toMatchObject({
      type: 'payment.refund_required',
      payload: { provider: 'MOMO', providerTransactionId: '4088878653', vnpTransactionNo: null },
    });
    expect(mock.ticket.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('a repeated failure changes nothing: already processed, the booking is not even read', async () => {
    const { result, statements } = settleMomo(
      [paymentRow(PaymentStatus.FAILED)],
      [],
      momoReport({ paid: false, responseCode: '1006' }),
    );

    await expect(result).resolves.toEqual({
      outcome: 'already_processed',
      paymentId: PAYMENT_ID,
      status: PaymentStatus.FAILED,
    });
    expect(statements).toHaveLength(1);
  });

  it('a paid answer with the wrong amount never reopens it: invalid_amount, nothing written', async () => {
    const { result, statements } = settleMomo(
      [paymentRow(PaymentStatus.FAILED)],
      [],
      momoReport({ amount: '1000' }),
    );

    await expect(result).resolves.toMatchObject({ outcome: 'invalid_amount' });
    expect(writes(statements)).toEqual([]);
  });

  it.each([PaymentStatus.SUCCESS, PaymentStatus.REFUND_REQUIRED])(
    'a paid answer for a payment already %s: still a repeat, nothing written',
    async (status) => {
      const { result, statements } = settleMomo([paymentRow(status)], []);

      await expect(result).resolves.toEqual({
        outcome: 'already_processed',
        paymentId: PAYMENT_ID,
        status,
      });
      expect(writes(statements)).toEqual([]);
    },
  );

  it('a PENDING payment paid normally carries no afterFailure flag', async () => {
    const { result } = settleMomo(
      [
        paymentRow(PaymentStatus.PENDING),
        bookingRow(BookingStatus.PENDING),
        [],
        heldSeats,
        showtimeRow,
      ],
      [1, 1, 1],
    );

    expect(await result).not.toHaveProperty('afterFailure');
  });
});

describe('VNPay keeps FAILED final (unchanged, ROADMAP 3.4)', () => {
  it('a VNPay success after a recorded failure: already processed (02), nothing written', async () => {
    const mock = mockTx([paymentRow(PaymentStatus.FAILED)]);
    const outcome = await confirmPayment(mock.tx, {
      txnRef: ORDER_ID,
      params: {
        vnp_Amount: String(AMOUNT * 100),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: '14226112',
        vnp_TxnRef: ORDER_ID,
      },
      now: NOW,
      ticketCode: () => 'CODE',
    });

    expect(outcome).toEqual({
      outcome: 'already_processed',
      paymentId: PAYMENT_ID,
      status: PaymentStatus.FAILED,
    });
    expect(writes(mock.statements)).toEqual([]);
  });
});
