import {
  BookingStatus,
  PaymentStatus,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import { confirmPayment, type ConfirmOutcome } from './confirm-payment';
import { ipnResponseOf } from './payment.service';
import { mockTx, type Statement, writes } from './testing/mock-tx';

const at = (iso: string): Date => new FakeClock(iso).now();
const NOW = at('2026-11-01T10:05:00.000Z');
const STARTS_AT = at('2026-11-02T12:00:00.000Z');
const HELD_UNTIL = at('2026-11-01T10:15:00.000Z');
const TXN_REF = 'Bq2qmIzmEDBQ2nWyKR55';
const PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f1';
const OTHER_PAYMENT_ID = '01a17e75-7100-7679-b8b1-0000000000f2';
const BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000001';
const OTHER_BOOKING_ID = '01a17e75-7100-7679-b8b1-000000000002';
const USER_ID = '01a17e75-7100-7679-b8b1-0000000000e1';
const SHOWTIME_ID = '01a17e75-7100-7679-b8b1-0000000000a1';
const SEAT_A = '01a17e75-7100-7679-b8b1-0000000000c1';
const SEAT_B = '01a17e75-7100-7679-b8b1-0000000000c2';
const AMOUNT = 180_000;

/** A signed IPN (the signature itself was checked before confirmPayment). */
const ipn = (overrides: Record<string, string> = {}): Record<string, string> => ({
  vnp_Amount: '18000000',
  vnp_BankCode: 'NCB',
  vnp_PayDate: '20261101170500',
  vnp_ResponseCode: '00',
  vnp_TmnCode: 'TKFTEST1',
  vnp_TransactionNo: '14226112',
  vnp_TransactionStatus: '00',
  vnp_TxnRef: TXN_REF,
  vnp_SecureHash: 'ab'.repeat(64),
  ...overrides,
});

const paymentRow = (status: PaymentStatus = PaymentStatus.PENDING) => [
  { id: PAYMENT_ID, booking_id: BOOKING_ID, amount: AMOUNT, status },
];
const bookingRow = (status: BookingStatus) => [
  { id: BOOKING_ID, code: 'K7PX3MQ9TA', user_id: USER_ID, showtime_id: SHOWTIME_ID, status },
];
const seatRow = (
  seatId: string,
  status: ShowtimeSeatStatus,
  bookingId: string | null,
  heldUntil: Date | null,
) => ({ seat_id: seatId, status, booking_id: bookingId, held_until: heldUntil });
const heldByBooking = [
  seatRow(SEAT_A, ShowtimeSeatStatus.HELD, BOOKING_ID, HELD_UNTIL),
  seatRow(SEAT_B, ShowtimeSeatStatus.HELD, BOOKING_ID, HELD_UNTIL),
];
const showtimeRow = (status: ShowtimeStatus = ShowtimeStatus.SCHEDULED, startsAt = STARTS_AT) => [
  { status, starts_at: startsAt },
];

let codes = 0;
const run = (rows: unknown[][], affected: number[] = [], params = ipn(), now = NOW) => {
  const mock = mockTx(rows, affected);
  const ticketCode = () => `CODE${++codes}`;
  return {
    ...mock,
    result: confirmPayment(mock.tx, { txnRef: TXN_REF, params, now, ticketCode }),
  };
};

/** Which table each statement touches, and how: the lock order and the writes at a glance. */
const shape = (statements: readonly Statement[]) =>
  statements.map(({ sql }) => {
    const table = /(?:FROM|UPDATE|INTO) (\w+)/.exec(sql)?.[1] ?? '?';
    const verb = sql.split(' ')[0];
    const lock = /FOR UPDATE$/.test(sql) ? ' FOR UPDATE' : '';
    return `${verb} ${table}${lock}`;
  });

const rspCode = (outcome: ConfirmOutcome) => ipnResponseOf(outcome).RspCode;

describe('confirmPayment — classification (RspCode)', () => {
  it('locks the payment FOR UPDATE by txnRef, first', async () => {
    const { result, statements } = run([[]]);

    await result;
    expect(statements[0]?.sql).toMatch(/FROM payments WHERE txn_ref = \$ FOR UPDATE$/);
    expect(statements[0]?.values).toEqual([TXN_REF]);
  });

  it('01: no payment with this txnRef; nothing written', async () => {
    const { result, statements } = run([[]]);

    const outcome = await result;
    expect(outcome).toEqual({ outcome: 'not_found' });
    expect(rspCode(outcome)).toBe('01');
    expect(writes(statements)).toEqual([]);
  });

  it.each([
    ['amount without × 100', '180000'],
    ['one dong more', '18000100'],
    ['leading zero', '018000000'],
    ['decimal', '18000000.00'],
  ])('04: vnp_Amount %s (%s); nothing written', async (_label, vnpAmount) => {
    const { result, statements } = run([paymentRow()], [], ipn({ vnp_Amount: vnpAmount }));

    const outcome = await result;
    expect(outcome).toEqual({
      outcome: 'invalid_amount',
      paymentId: PAYMENT_ID,
      expected: '18000000',
      received: vnpAmount,
    });
    expect(rspCode(outcome)).toBe('04');
    expect(writes(statements)).toEqual([]);
  });

  it('04: no vnp_Amount at all', async () => {
    const params = ipn();
    delete params.vnp_Amount;
    const { result } = run([paymentRow()], [], params);

    await expect(result).resolves.toMatchObject({ outcome: 'invalid_amount', received: null });
  });

  it('the amount is checked before the status: a wrong amount on a SUCCESS payment is 04', async () => {
    const { result } = run([paymentRow(PaymentStatus.SUCCESS)], [], ipn({ vnp_Amount: '1' }));

    expect(rspCode(await result)).toBe('04');
  });

  it.each([PaymentStatus.SUCCESS, PaymentStatus.FAILED])(
    '02: payment already %s; nothing written, the booking is not even read',
    async (status) => {
      const { result, statements } = run([paymentRow(status)]);

      const outcome = await result;
      expect(outcome).toEqual({ outcome: 'already_processed', paymentId: PAYMENT_ID, status });
      expect(rspCode(outcome)).toBe('02');
      expect(statements).toHaveLength(1);
    },
  );

  it.each([
    ['24', '02'],
    ['00', '02'],
    ['07', '00'],
  ])(
    '00: not paid (vnp_ResponseCode %s, vnp_TransactionStatus %s) → payment FAILED, booking untouched',
    async (responseCode, transactionStatus) => {
      const params = ipn({
        vnp_ResponseCode: responseCode,
        vnp_TransactionStatus: transactionStatus,
        vnp_TransactionNo: '0',
      });
      const { result, statements } = run([paymentRow()], [1], params);

      const outcome = await result;
      expect(outcome).toEqual({
        outcome: 'failed',
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
        responseCode,
        transactionStatus,
      });
      expect(rspCode(outcome)).toBe('00');
      expect(shape(statements)).toEqual(['SELECT payments FOR UPDATE', 'UPDATE payments']);
      const [update] = writes(statements);
      expect(update?.sql).toContain("SET status = 'FAILED'");
      // vnp_TransactionNo ("0" for a cancelled payment) is not written to its unique column.
      expect(update?.sql).not.toContain('vnp_transaction_no');
      expect(update?.values).toEqual([
        'NCB',
        responseCode,
        JSON.stringify(params),
        NOW,
        NOW,
        PAYMENT_ID,
      ]);
    },
  );

  it('an EXPIRED payment is not final: a late success is still recorded', async () => {
    const { result } = run(
      [
        paymentRow(PaymentStatus.EXPIRED),
        bookingRow(BookingStatus.PENDING),
        [],
        heldByBooking,
        showtimeRow(),
      ],
      [1, 2, 1],
    );

    await expect(result).resolves.toMatchObject({ outcome: 'confirmed' });
  });

  it('02: another payment of the booking already succeeded (paid twice); nothing written', async () => {
    const { result, statements } = run([
      paymentRow(),
      bookingRow(BookingStatus.CONFIRMED),
      [{ id: OTHER_PAYMENT_ID }],
    ]);

    const outcome = await result;
    expect(outcome).toEqual({
      outcome: 'paid_twice',
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      paidPaymentId: OTHER_PAYMENT_ID,
      transactionNo: '14226112',
    });
    expect(rspCode(outcome)).toBe('02');
    expect(writes(statements)).toEqual([]);
  });

  it.each([BookingStatus.CONFIRMED, BookingStatus.NEEDS_REVIEW])(
    'a %s booking without any SUCCESS payment is a bug: throws (500), nothing written',
    async (status) => {
      const { result, statements } = run([paymentRow(), bookingRow(status), []]);

      await expect(result).rejects.toThrow(`without a SUCCESS payment`);
      expect(writes(statements)).toEqual([]);
    },
  );
});

describe('confirmPayment — branch A (PENDING, seats still HELD)', () => {
  it('Payment → Booking → Seats, then SOLD, CONFIRMED, one ticket per seat, outbox', async () => {
    const { result, statements, mock } = run(
      [paymentRow(), bookingRow(BookingStatus.PENDING), [], heldByBooking, showtimeRow()],
      [1, 2, 1],
    );

    const outcome = await result;
    expect(outcome).toEqual({
      outcome: 'confirmed',
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      showtimeId: SHOWTIME_ID,
      seatIds: [SEAT_A, SEAT_B],
      ticketIds: ['ticket-1', 'ticket-2'],
      reclaimed: false,
      showtimeStarted: false,
    });
    expect(rspCode(outcome)).toBe('00');
    expect(shape(statements)).toEqual([
      'SELECT payments FOR UPDATE',
      'SELECT bookings FOR UPDATE',
      'SELECT payments',
      'UPDATE payments',
      'SELECT showtime_seats FOR UPDATE',
      'SELECT showtimes',
      'UPDATE showtime_seats',
      'UPDATE bookings',
      'INSERT tickets',
      'INSERT outbox_events',
    ]);
    expect(statements[4]?.sql).toMatch(/ORDER BY seat_id FOR UPDATE$/);
    expect(statements[3]?.sql).toContain("SET status = 'SUCCESS', vnp_transaction_no = $");
    expect(statements[6]?.sql).toContain(
      "SET status = 'SOLD', held_until = NULL WHERE showtime_id = $::uuid AND seat_id = ANY($::uuid[]) AND status = 'HELD' AND booking_id = $::uuid",
    );
    expect(statements[7]?.sql).toContain("SET status = 'CONFIRMED', confirmed_at = $");

    const [tickets] = mock.ticket.createManyAndReturn.mock.calls[0]!;
    expect(tickets.data).toEqual([
      expect.objectContaining({ bookingId: BOOKING_ID, seatId: SEAT_A, status: 'ISSUED' }),
      expect.objectContaining({ bookingId: BOOKING_ID, seatId: SEAT_B, status: 'ISSUED' }),
    ]);
    expect(mock.outboxEvent.create).toHaveBeenCalledTimes(1);
    const [event] = mock.outboxEvent.create.mock.calls[0]!;
    expect(event.data).toEqual({
      type: 'booking.confirmed',
      aggregateId: BOOKING_ID,
      payload: {
        bookingId: BOOKING_ID,
        bookingCode: 'K7PX3MQ9TA',
        userId: USER_ID,
        showtimeId: SHOWTIME_ID,
        paymentId: PAYMENT_ID,
        seatIds: [SEAT_A, SEAT_B],
        ticketIds: ['ticket-1', 'ticket-2'],
        reclaimed: false,
      },
      nextRetryAt: NOW,
      createdAt: NOW,
    });
  });

  it('past heldUntil but nobody took the seats: still confirmed', async () => {
    const later = at('2026-11-01T11:00:00.000Z');
    const { result } = run(
      [paymentRow(), bookingRow(BookingStatus.PENDING), [], heldByBooking, showtimeRow()],
      [1, 2, 1],
      ipn(),
      later,
    );

    await expect(result).resolves.toMatchObject({ outcome: 'confirmed', reclaimed: false });
  });

  it('a showtime that has already started is still confirmed, flagged showtimeStarted', async () => {
    const { result } = run(
      [
        paymentRow(),
        bookingRow(BookingStatus.PENDING),
        [],
        heldByBooking,
        showtimeRow(ShowtimeStatus.SCHEDULED, NOW),
      ],
      [1, 2, 1],
    );

    await expect(result).resolves.toMatchObject({ outcome: 'confirmed', showtimeStarted: true });
  });

  it('fewer seats sold than locked: throws, so the whole IPN rolls back', async () => {
    const { result } = run(
      [paymentRow(), bookingRow(BookingStatus.PENDING), [], heldByBooking, showtimeRow()],
      [1, 1],
    );

    await expect(result).rejects.toThrow('1 of 2 seats could be sold');
  });
});

describe('confirmPayment — branch C (review)', () => {
  it.each([
    [
      'a seat taken by another booking',
      [
        seatRow(SEAT_A, ShowtimeSeatStatus.HELD, BOOKING_ID, HELD_UNTIL),
        seatRow(SEAT_B, ShowtimeSeatStatus.HELD, OTHER_BOOKING_ID, HELD_UNTIL),
      ],
      showtimeRow(),
      { reason: 'SEAT_HELD_BY_OTHER', seatIds: [SEAT_B] },
      [SEAT_A],
    ],
    [
      'a seat sold to another booking',
      [
        seatRow(SEAT_A, ShowtimeSeatStatus.SOLD, OTHER_BOOKING_ID, null),
        seatRow(SEAT_B, ShowtimeSeatStatus.HELD, BOOKING_ID, HELD_UNTIL),
      ],
      showtimeRow(),
      { reason: 'SEAT_SOLD', seatIds: [SEAT_A] },
      [SEAT_B],
    ],
    [
      'a cancelled showtime',
      heldByBooking,
      showtimeRow(ShowtimeStatus.CANCELLED),
      { reason: 'SHOWTIME_CANCELLED', seatIds: [] },
      [SEAT_A, SEAT_B],
    ],
  ])(
    'PENDING booking, %s → NEEDS_REVIEW, its own HELD seats released, no ticket',
    async (_label, seats, showtime, problem, released) => {
      const { result, statements, mock } = run(
        [
          paymentRow(),
          bookingRow(BookingStatus.PENDING),
          [],
          seats,
          showtime,
          released.map((seatId) => ({ seat_id: seatId })),
        ],
        [1, 1],
      );

      const outcome = await result;
      expect(outcome).toEqual({
        outcome: 'needs_review',
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
        showtimeId: SHOWTIME_ID,
        problem,
        releasedSeatIds: released,
        showtimeStarted: false,
      });
      expect(rspCode(outcome)).toBe('00');
      expect(shape(writes(statements))).toEqual([
        'UPDATE payments',
        'UPDATE bookings',
        'UPDATE showtime_seats',
        'INSERT outbox_events',
        'INSERT outbox_events',
      ]);
      expect(writes(statements)[1]?.sql).toContain("SET status = 'NEEDS_REVIEW'");
      // Only seats still HELD by this booking: never a SOLD seat, never another booking's.
      expect(writes(statements)[2]?.sql).toBe(
        "UPDATE showtime_seats SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL WHERE showtime_id = $::uuid AND booking_id = $::uuid AND status = 'HELD' RETURNING seat_id",
      );
      expect(writes(statements)[2]?.values).toEqual([SHOWTIME_ID, BOOKING_ID]);
      expect(mock.ticket.createManyAndReturn).not.toHaveBeenCalled();
      const [event] = mock.outboxEvent.create.mock.calls[0]!;
      expect(event.data).toMatchObject({
        type: 'booking.needs_review',
        aggregateId: BOOKING_ID,
        payload: {
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          amount: AMOUNT,
          vnpTransactionNo: '14226112',
          reason: problem.reason,
          seatIds: problem.seatIds,
          releasedSeatIds: released,
        },
      });
      const [releasedEvent] = mock.outboxEvent.create.mock.calls[1]!;
      expect(releasedEvent.data).toEqual({
        type: 'seats.released',
        aggregateId: BOOKING_ID,
        payload: {
          bookingId: BOOKING_ID,
          showtimeId: SHOWTIME_ID,
          seatIds: released,
          cause: 'booking.needs_review',
        },
        nextRetryAt: NOW,
        createdAt: NOW,
      });
    },
  );

  it('no seat of its own HELD any more: NEEDS_REVIEW without a seats.released event', async () => {
    const seats = [
      seatRow(SEAT_A, ShowtimeSeatStatus.SOLD, OTHER_BOOKING_ID, null),
      seatRow(SEAT_B, ShowtimeSeatStatus.HELD, OTHER_BOOKING_ID, HELD_UNTIL),
    ];
    const { result, mock } = run(
      [paymentRow(), bookingRow(BookingStatus.PENDING), [], seats, showtimeRow(), []],
      [1, 1],
    );

    await expect(result).resolves.toMatchObject({ outcome: 'needs_review', releasedSeatIds: [] });
    expect(
      mock.outboxEvent.create.mock.calls.map(([e]) => (e.data as { type: string }).type),
    ).toEqual(['booking.needs_review']);
  });
});

describe('confirmPayment — branch B (EXPIRED booking)', () => {
  const expiredSeats = [
    seatRow(SEAT_A, ShowtimeSeatStatus.AVAILABLE, null, null),
    seatRow(SEAT_B, ShowtimeSeatStatus.AVAILABLE, null, null),
  ];
  const reclaimBooking = [{ status: BookingStatus.EXPIRED, showtime_id: SHOWTIME_ID }];

  it('every seat free: taken back, then sold like branch A (reclaimed: true)', async () => {
    const { result, statements, mock } = run(
      [
        paymentRow(),
        bookingRow(BookingStatus.EXPIRED),
        [],
        reclaimBooking,
        expiredSeats,
        showtimeRow(),
      ],
      [1, 2, 2, 1],
    );

    const outcome = await result;
    expect(outcome).toMatchObject({
      outcome: 'confirmed',
      reclaimed: true,
      seatIds: [SEAT_A, SEAT_B],
    });
    expect(rspCode(outcome)).toBe('00');
    expect(shape(statements)).toEqual([
      'SELECT payments FOR UPDATE',
      'SELECT bookings FOR UPDATE',
      'SELECT payments',
      'UPDATE payments',
      'SELECT bookings',
      'SELECT showtime_seats FOR UPDATE',
      'SELECT showtimes',
      'UPDATE showtime_seats',
      'UPDATE showtime_seats',
      'UPDATE bookings',
      'INSERT tickets',
      'INSERT outbox_events',
    ]);
    expect(statements[9]?.sql).toContain("AND status IN ('PENDING', 'EXPIRED')");
    const [event] = mock.outboxEvent.create.mock.calls[0]!;
    expect(event.data).toMatchObject({ type: 'booking.confirmed', payload: { reclaimed: true } });
  });

  it('one seat held by a live booking: NEEDS_REVIEW and no seat changes (all or nothing)', async () => {
    const { result, statements, mock } = run(
      [
        paymentRow(),
        bookingRow(BookingStatus.EXPIRED),
        [],
        reclaimBooking,
        [
          seatRow(SEAT_A, ShowtimeSeatStatus.AVAILABLE, null, null),
          seatRow(
            SEAT_B,
            ShowtimeSeatStatus.HELD,
            OTHER_BOOKING_ID,
            at('2026-11-01T10:20:00.000Z'),
          ),
        ],
        showtimeRow(),
        [],
      ],
      [1, 1],
    );

    await expect(result).resolves.toMatchObject({
      outcome: 'needs_review',
      problem: { reason: 'SEAT_HELD_BY_OTHER', seatIds: [SEAT_B] },
      releasedSeatIds: [],
    });
    // The reclaim changed nothing; the release finds no seat HELD by this booking.
    expect(shape(writes(statements))).toEqual([
      'UPDATE payments',
      'UPDATE bookings',
      'UPDATE showtime_seats',
      'INSERT outbox_events',
    ]);
    expect(mock.ticket.createManyAndReturn).not.toHaveBeenCalled();
  });
});
