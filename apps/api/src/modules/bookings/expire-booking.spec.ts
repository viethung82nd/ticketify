import {
  BookingStatus,
  PaymentStatus,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { ConfirmOutcome } from '../payment/confirm-payment';
import { mockTx, type Statement, writes } from '../payment/testing/mock-tx';
import { expireBooking, type PaidQuerydr } from './expire-booking';

const at = (iso: string): Date => new FakeClock(iso).now();
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const HOLD_UNTIL = at('2026-11-01T10:15:00.000Z');
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';
const SEAT_B = '01a17e75-7100-7679-b8b1-0000000000c2';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const OTHER_PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f2';
const USER_ID = '01a17e75-7100-7679-b8b1-0000000000e1';
const TXN_REF = 'Bq2qmIzmEDBQ2nWyKR55';
const AMOUNT = 180_000;

const lockedBooking = (status: BookingStatus) => [
  { status, hold_until: HOLD_UNTIL, showtime_id: SHOWTIME_ID },
];
/** Rows of step 1: the booking's PENDING payment attempts, locked before the booking. */
const pendingPayments = (...ids: string[]) =>
  ids.map((id) => ({ id, txn_ref: id === PAYMENT_ID ? TXN_REF : `${id.slice(-4)}other` }));

/** The querydr answer the service hands in after VNPay reported `PAYMENT_ID` paid. */
const paidAnswer = (overrides: Partial<PaidQuerydr> = {}): PaidQuerydr => ({
  paymentId: PAYMENT_ID,
  txnRef: TXN_REF,
  params: {
    vnp_Amount: String(AMOUNT * 100),
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_TransactionNo: '14226112',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: TXN_REF,
    vnp_SecureHash: 'ab'.repeat(64),
  },
  ...overrides,
});

const ticketCode = (() => {
  let n = 0;
  return () => `CODE${++n}`;
})();

/** Which table each statement touches, and how: the lock order at a glance. */
const shape = (statements: readonly Statement[]) =>
  statements.map(({ sql }) => {
    const table = /(?:FROM|UPDATE|INTO) (\w+)/.exec(sql)?.[1] ?? '?';
    const lock = /FOR UPDATE( SKIP LOCKED)?$/.exec(sql)?.[0] ?? '';
    return `${sql.split(' ')[0]} ${table}${lock ? ` ${lock}` : ''}`;
  });

describe('expireBooking', () => {
  it('locks the PENDING payments first, then the booking row (PLAN §4 order)', async () => {
    const { tx, statements } = mockTx([[], lockedBooking(BookingStatus.EXPIRED)]);

    await expireBooking(tx, BOOKING_ID, HOLD_UNTIL);

    expect(statements[0]?.sql).toMatch(
      /FROM payments WHERE booking_id = \$::uuid AND status = 'PENDING' ORDER BY created_at, id FOR UPDATE$/,
    );
    expect(statements[0]?.values).toEqual([BOOKING_ID]);
    expect(statements[1]?.sql).toMatch(/FROM bookings WHERE id = \$::uuid FOR UPDATE SKIP LOCKED$/);
    expect(statements[1]?.values).toEqual([BOOKING_ID]);
  });

  it.each([BookingStatus.EXPIRED, BookingStatus.CONFIRMED, BookingStatus.NEEDS_REVIEW])(
    'noop when the booking is %s: nothing is written',
    async (status) => {
      const { tx, statements } = mockTx([[], lockedBooking(status)]);

      await expect(expireBooking(tx, BOOKING_ID, at('2026-11-02T00:00:00.000Z'))).resolves.toEqual({
        outcome: 'noop',
      });
      expect(writes(statements)).toEqual([]);
    },
  );

  it('noop for an unknown booking', async () => {
    const { tx, statements } = mockTx([[], [], []]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).resolves.toEqual({ outcome: 'noop' });
    expect(statements).toHaveLength(3);
    expect(writes(statements)).toEqual([]);
  });

  it('skipped when the row exists but another transaction holds it', async () => {
    const { tx, statements } = mockTx([[], [], [{ found: 1 }]]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).resolves.toEqual({
      outcome: 'skipped',
    });
    expect(writes(statements)).toEqual([]);
  });

  it('early while now < holdUntil: returns holdUntil, writes nothing', async () => {
    const { tx, statements } = mockTx([[], lockedBooking(BookingStatus.PENDING)]);

    await expect(expireBooking(tx, BOOKING_ID, at('2026-11-01T10:14:59.999Z'))).resolves.toEqual({
      outcome: 'early',
      holdUntil: HOLD_UNTIL,
    });
    expect(writes(statements)).toEqual([]);
  });

  it('expired from holdUntil on: booking EXPIRED, then its own HELD seats locked and released', async () => {
    const now = HOLD_UNTIL;
    const { tx, statements } = mockTx(
      [[], lockedBooking(BookingStatus.PENDING), [], [{ seat_id: SEAT_B }, { seat_id: SEAT_A }]],
      [1],
    );

    await expect(expireBooking(tx, BOOKING_ID, now)).resolves.toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [SEAT_A, SEAT_B],
      expiredPaymentIds: [],
    });

    const [, , expire, lockSeats, release] = statements;
    expect(expire?.sql).toBe(
      "UPDATE bookings SET status = 'EXPIRED', updated_at = $ WHERE id = $::uuid",
    );
    expect(expire?.values).toEqual([now, BOOKING_ID]);
    // Lock order: payments, booking (above), then seats in seat_id order.
    expect(lockSeats?.sql).toBe(
      "SELECT seat_id FROM showtime_seats WHERE booking_id = $::uuid AND status = 'HELD' " +
        'ORDER BY seat_id FOR UPDATE',
    );
    // Conditional release: only seats still HELD by this booking (lazy expiry, SOLD seats).
    expect(release?.sql).toBe(
      "UPDATE showtime_seats SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL " +
        "WHERE booking_id = $::uuid AND status = 'HELD' RETURNING seat_id",
    );
    expect(release?.values).toEqual([BOOKING_ID]);
    expect(statements).toHaveLength(5);
  });

  it('expired with 0 released seats when another booking already took them all', async () => {
    const { tx } = mockTx([[], lockedBooking(BookingStatus.PENDING), [], []], [1]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).resolves.toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [],
      expiredPaymentIds: [],
    });
  });

  // ─── Unfinished payment attempts (ROADMAP 3.7, PLAN §4 step 4) ───

  it('expires every PENDING attempt with the booking, after the booking and before the seats', async () => {
    const now = HOLD_UNTIL;
    const { tx, statements } = mockTx(
      [
        pendingPayments(PAYMENT_ID, OTHER_PAYMENT_ID),
        lockedBooking(BookingStatus.PENDING),
        [],
        [{ seat_id: SEAT_A }],
      ],
      [1, 2],
    );

    await expect(expireBooking(tx, BOOKING_ID, now)).resolves.toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [SEAT_A],
      expiredPaymentIds: [PAYMENT_ID, OTHER_PAYMENT_ID],
    });
    expect(shape(statements)).toEqual([
      'SELECT payments FOR UPDATE',
      'SELECT bookings FOR UPDATE SKIP LOCKED',
      'UPDATE bookings',
      'UPDATE payments',
      'SELECT showtime_seats FOR UPDATE',
      'UPDATE showtime_seats',
    ]);
    expect(statements[3]?.sql).toBe(
      "UPDATE payments SET status = 'EXPIRED', updated_at = $ " +
        "WHERE booking_id = $::uuid AND status = 'PENDING'",
    );
    expect(statements[3]?.values).toEqual([now, BOOKING_ID]);
  });

  it('throws when fewer attempts are expired than were locked (nothing is committed)', async () => {
    const { tx } = mockTx(
      [pendingPayments(PAYMENT_ID, OTHER_PAYMENT_ID), lockedBooking(BookingStatus.PENDING)],
      [1, 1],
    );

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL)).rejects.toThrow(
      /expired 1 of 2 locked PENDING payments/,
    );
  });

  // ─── A querydr answer that said "paid" (ROADMAP 3.7) ───

  it('ignores an answer about a payment that is no longer PENDING here', async () => {
    // The IPN settled PAYMENT_ID between the HTTP call and this transaction: it is not in step 1.
    const { tx, statements } = mockTx(
      [pendingPayments(OTHER_PAYMENT_ID), lockedBooking(BookingStatus.PENDING), [], []],
      [1, 1],
    );

    const result = await expireBooking(tx, BOOKING_ID, HOLD_UNTIL, {
      paid: paidAnswer(),
      ticketCode,
    });

    expect(result.outcome).toBe('expired');
    // No `payments ... WHERE txn_ref` lookup: confirmPayment was never reached.
    expect(statements.some((s) => s.sql.includes('WHERE txn_ref'))).toBe(false);
  });

  it('ignores an answer whose txnRef is not the one on the locked row', async () => {
    const { tx, statements } = mockTx(
      [pendingPayments(PAYMENT_ID), lockedBooking(BookingStatus.PENDING), [], []],
      [1, 1],
    );

    const result = await expireBooking(tx, BOOKING_ID, HOLD_UNTIL, {
      paid: paidAnswer({ txnRef: 'ZZZZZZZZZZZZZZZZZZZZ' }),
      ticketCode,
    });

    expect(result.outcome).toBe('expired');
    expect(statements.some((s) => s.sql.includes('WHERE txn_ref'))).toBe(false);
  });

  it('expires as usual when the answer does not match the payment row (wrong amount)', async () => {
    const { tx, statements } = mockTx(
      [
        pendingPayments(PAYMENT_ID),
        lockedBooking(BookingStatus.PENDING),
        // confirmPayment: the payment by txn_ref, whose amount × 100 is not what VNPay reported.
        [{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: 1, status: PaymentStatus.PENDING }],
        [],
        [{ seat_id: SEAT_A }],
      ],
      [1, 1],
    );

    const result = await expireBooking(tx, BOOKING_ID, HOLD_UNTIL, {
      paid: paidAnswer(),
      ticketCode,
    });

    expect(result).toEqual({
      outcome: 'expired',
      showtimeId: SHOWTIME_ID,
      releasedSeatIds: [SEAT_A],
      expiredPaymentIds: [PAYMENT_ID],
    });
    // confirmPayment was reached and wrote nothing; the expiry then ran in full.
    expect(statements.some((s) => s.sql.includes('WHERE txn_ref'))).toBe(true);
    expect(writes(statements).map((s) => s.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'UPDATE bookings SET',
      'UPDATE payments SET',
      'UPDATE showtime_seats SET',
    ]);
  });

  it('records the payment and does not expire when the seats are still held for the booking', async () => {
    const now = HOLD_UNTIL;
    const seat = (seatId: string) => ({
      seat_id: seatId,
      status: ShowtimeSeatStatus.HELD,
      booking_id: BOOKING_ID,
      held_until: HOLD_UNTIL,
    });
    const { tx, statements } = mockTx(
      [
        pendingPayments(PAYMENT_ID),
        lockedBooking(BookingStatus.PENDING),
        // confirmPayment, branch A: the payment, the booking, no earlier SUCCESS, the seats, the showtime.
        [{ id: PAYMENT_ID, booking_id: BOOKING_ID, amount: AMOUNT, status: PaymentStatus.PENDING }],
        [
          {
            id: BOOKING_ID,
            code: 'K7PX3MQ9TA',
            user_id: USER_ID,
            showtime_id: SHOWTIME_ID,
            status: BookingStatus.PENDING,
          },
        ],
        [],
        [seat(SEAT_A), seat(SEAT_B)],
        [
          {
            status: ShowtimeStatus.SCHEDULED,
            starts_at: at('2026-11-02T12:00:00.000Z'),
            ends_at: at('2026-11-02T13:55:00.000Z'),
          },
        ],
      ],
      [1, 2, 1],
    );

    const result = await expireBooking(tx, BOOKING_ID, now, { paid: paidAnswer(), ticketCode });

    if (result.outcome !== 'paid') throw new Error(`Expected outcome paid, got ${result.outcome}`);
    expect(result.paymentId).toBe(PAYMENT_ID);
    const confirmation: ConfirmOutcome = result.confirmation;
    if (confirmation.outcome !== 'confirmed') {
      throw new Error(`Expected the payment confirmed, got ${confirmation.outcome}`);
    }
    expect(confirmation.bookingId).toBe(BOOKING_ID);
    expect(confirmation.seatIds).toEqual([SEAT_A, SEAT_B]);
    expect(confirmation.reclaimed).toBe(false);
    expect(confirmation.ticketIds).toHaveLength(2);
    // The booking was confirmed, never expired, and no payment was set EXPIRED.
    const written = writes(statements).map((s) => s.sql);
    expect(written.some((sql) => sql.includes("status = 'EXPIRED'"))).toBe(false);
    expect(written.some((sql) => sql.includes("bookings SET status = 'CONFIRMED'"))).toBe(true);
    expect(written).toContain('INSERT INTO tickets');
  });

  it('refuses a querydr answer without a ticket code source', async () => {
    const { tx } = mockTx([pendingPayments(PAYMENT_ID), lockedBooking(BookingStatus.PENDING)]);

    await expect(expireBooking(tx, BOOKING_ID, HOLD_UNTIL, { paid: paidAnswer() })).rejects.toThrow(
      /needs a ticketCode source/,
    );
  });

  it('never calls confirmPayment without an answer, even with a PENDING attempt', async () => {
    const { tx, statements } = mockTx(
      [pendingPayments(PAYMENT_ID), lockedBooking(BookingStatus.PENDING), [], []],
      [1, 1],
    );

    await expireBooking(tx, BOOKING_ID, HOLD_UNTIL);

    expect(statements.some((s) => s.sql.includes('WHERE txn_ref'))).toBe(false);
  });
});
