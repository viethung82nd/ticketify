import { BookingStatus, PaymentStatus, ShowtimeStatus, TicketStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';
import { OutboxEventType, writeOutboxEvent } from '../../infra/outbox/outbox-events';
import { lockSeatsOfBooking, type ShowtimeState, showtimeOf } from './booking-seats';
import { heldSeatsProblem, ReviewReason, type SeatProblem } from './seat-settlement';
import { vnpayAmount } from './vnpay/vnpay-format';
import { readVnpayIpn, type VnpayIpnResult } from './vnpay/vnpay-ipn';

type Tx = Prisma.TransactionClient;

export interface ConfirmPaymentInput {
  /** `vnp_TxnRef`. */
  txnRef: string;
  /** Every parameter of the IPN, signature already checked; stored as `raw_payload`. */
  params: Readonly<Record<string, string>>;
  now: Date;
  /** Draws one ticket code (`TicketCodes.next`). */
  ticketCode: () => string;
}

/** What `confirmPayment` did. Only `failed`, `confirmed` and `needs_review` wrote anything. */
export type ConfirmOutcome =
  /** No payment has this `vnp_TxnRef` (`01`). */
  | { outcome: 'not_found' }
  /** `vnp_Amount` ≠ amount × 100 (`04`). */
  | { outcome: 'invalid_amount'; paymentId: string; expected: string; received: string | null }
  /** The payment is SUCCESS or FAILED already, e.g. a repeated IPN (`02`). */
  | { outcome: 'already_processed'; paymentId: string; status: PaymentStatus }
  /**
   * VNPay reports this payment paid, but another payment of the same booking already succeeded
   * (two payment pages paid). Nothing is written (`02`); refunding it is manual for now.
   */
  | {
      outcome: 'paid_twice';
      paymentId: string;
      bookingId: string;
      paidPaymentId: string;
      transactionNo: string | null;
    }
  /** Payment FAILED; the booking stays as it was, PENDING until it expires (`00`). */
  | {
      outcome: 'failed';
      paymentId: string;
      bookingId: string;
      responseCode: string | null;
      transactionStatus: string | null;
    }
  /** Payment SUCCESS, seats SOLD, booking CONFIRMED, tickets ISSUED (`00`). */
  | {
      outcome: 'confirmed';
      paymentId: string;
      bookingId: string;
      showtimeId: string;
      seatIds: string[];
      ticketIds: string[];
      /** The showtime had already started (owner decision pending, ROADMAP "Quyết định chờ"). */
      showtimeStarted: boolean;
    }
  /** Payment SUCCESS, booking NEEDS_REVIEW, seats untouched, no ticket (`00`). */
  | {
      outcome: 'needs_review';
      paymentId: string;
      bookingId: string;
      showtimeId: string;
      problem: SeatProblem;
      showtimeStarted: boolean;
    };

interface PaymentRow {
  id: string;
  booking_id: string;
  amount: number;
  status: PaymentStatus;
}

interface BookingRow {
  id: string;
  code: string;
  user_id: string;
  showtime_id: string;
  status: BookingStatus;
}

/** How the booking's seats turned out once locked (branch A, B or C of PLAN §5 step 6). */
interface Settlement {
  showtime: ShowtimeState;
  /** Seats HELD by the booking, ready to be sold; empty when `problem` is set. */
  seatIds: string[];
  problem: SeatProblem | null;
}

/**
 * Records one VNPay IPN (PLAN §5 "IPN", ROADMAP 3.4) inside the caller's transaction, after the
 * caller has checked the signature. One transaction per IPN; it either commits every change of
 * the outcome or, on any error, none of them (the caller answers 500 and VNPay calls again).
 *
 * Locks, in the order every flow uses (PLAN §4: Payment → Booking → ShowtimeSeat):
 * 1. the payment row `FOR UPDATE`: repeated IPNs of one payment run one after the other, and the
 *    later ones find it SUCCESS or FAILED (`02`);
 * 2. the booking row `FOR UPDATE` (successful payments only): an expiry (`FOR UPDATE SKIP
 *    LOCKED`) skips the booking meanwhile, a cancel and a payment creation wait; a cancel that got
 *    the row first sees this payment PENDING and refuses (`BookingService.cancel`);
 * 3. the booking's seats `FOR UPDATE ORDER BY seat_id` (`lockSeatsOfBooking`), as a hold
 *    (NOWAIT), a cancel, an expiry and a showtime cancel do.
 * No other flow locks a payment row, and none waits for the booking row while holding a seat, so
 * no flow waits on this one in a cycle.
 *
 * The partial unique indexes are the last line of defence: a second SUCCESS for the booking
 * (`payments_booking_id_success_key`) or a second live ticket for a seat
 * (`tickets_showtime_id_seat_id_live_key`) fails the statement and the whole transaction.
 */
export async function confirmPayment(tx: Tx, input: ConfirmPaymentInput): Promise<ConfirmOutcome> {
  const { txnRef, params, now } = input;

  // 1. The payment, locked.
  const [payment] = await tx.$queryRaw<PaymentRow[]>`
    SELECT id, booking_id, amount, status::text AS status FROM payments
    WHERE txn_ref = ${txnRef}
    FOR UPDATE`;
  if (!payment) return { outcome: 'not_found' };

  // 2. Amount: exactly amount × 100, compared as the string VNPay sent.
  const expected = vnpayAmount(payment.amount);
  const received = params.vnp_Amount ?? null;
  if (received !== expected) {
    return { outcome: 'invalid_amount', paymentId: payment.id, expected, received };
  }

  // 3. Already recorded. EXPIRED is not final here: money that arrives after the booking gave up
  //    on this attempt must still be recorded.
  if (payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.FAILED) {
    return { outcome: 'already_processed', paymentId: payment.id, status: payment.status };
  }

  const ipn = readVnpayIpn(params);
  const raw = JSON.stringify(params);

  // 4. Not paid: the payment FAILED, the booking is left alone (the user may pay again before
  //    expiresAt). vnp_TransactionNo is not stored for a failure: VNPay may send `0` for a
  //    cancelled payment and the column is unique; it stays in raw_payload.
  if (!ipn.succeeded) {
    await tx.$executeRaw`
      UPDATE payments
      SET status = 'FAILED', bank_code = ${ipn.bankCode}, response_code = ${ipn.responseCode},
          raw_payload = ${raw}::jsonb, processed_at = ${now}, updated_at = ${now}
      WHERE id = ${payment.id}::uuid`;
    return {
      outcome: 'failed',
      paymentId: payment.id,
      bookingId: payment.booking_id,
      responseCode: ipn.responseCode,
      transactionStatus: ipn.transactionStatus,
    };
  }

  // 5. Paid. The booking, locked.
  const [booking] = await tx.$queryRaw<BookingRow[]>`
    SELECT id, code, user_id, showtime_id, status::text AS status FROM bookings
    WHERE id = ${payment.booking_id}::uuid
    FOR UPDATE`;
  if (!booking)
    throw new Error(`Booking ${payment.booking_id} of payment ${payment.id} is missing`);

  // 6. Paid twice: another payment of this booking already succeeded, and a booking is paid at
  //    most once (payments_booking_id_success_key). Recorded nowhere but the log for now.
  const [paid] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments
    WHERE booking_id = ${booking.id}::uuid AND status = 'SUCCESS'
    LIMIT 1`;
  if (paid) {
    return {
      outcome: 'paid_twice',
      paymentId: payment.id,
      bookingId: booking.id,
      paidPaymentId: paid.id,
      transactionNo: ipn.transactionNo,
    };
  }
  // CONFIRMED and NEEDS_REVIEW only ever follow a SUCCESS payment, which step 6 would have found.
  if (booking.status !== BookingStatus.PENDING && booking.status !== BookingStatus.EXPIRED) {
    throw new Error(`Booking ${booking.id} is ${booking.status} without a SUCCESS payment`);
  }

  // 7. The money is ours whatever happens to the seats.
  await tx.$executeRaw`
    UPDATE payments
    SET status = 'SUCCESS', vnp_transaction_no = ${ipn.transactionNo}, bank_code = ${ipn.bankCode},
        response_code = ${ipn.responseCode}, raw_payload = ${raw}::jsonb,
        processed_at = ${now}, updated_at = ${now}
    WHERE id = ${payment.id}::uuid`;

  // 8. The seats decide: A (still held) or C (review). An EXPIRED booking has given its seats
  //    back, so none of them is HELD for it any more: it goes to review.
  const settlement = await settleHeldSeats(tx, booking);
  const showtimeStarted = settlement.showtime.startsAt.getTime() <= now.getTime();

  if (settlement.problem) {
    await sendToReview(tx, { booking, payment, ipn, problem: settlement.problem }, now);
    return {
      outcome: 'needs_review',
      paymentId: payment.id,
      bookingId: booking.id,
      showtimeId: booking.showtime_id,
      problem: settlement.problem,
      showtimeStarted,
    };
  }

  const ticketIds = await confirmBooking(
    tx,
    { booking, payment, seatIds: settlement.seatIds },
    input,
  );
  return {
    outcome: 'confirmed',
    paymentId: payment.id,
    bookingId: booking.id,
    showtimeId: booking.showtime_id,
    seatIds: settlement.seatIds,
    ticketIds,
    showtimeStarted,
  };
}

/**
 * Branch A (or C): the booking's seats must all still be HELD by it, even past
 * `heldUntil` (nobody took them), and the showtime not cancelled. A started showtime does not
 * matter here (owner decision pending).
 */
async function settleHeldSeats(tx: Tx, booking: BookingRow): Promise<Settlement> {
  const seats = await lockSeatsOfBooking(tx, booking.id);
  const showtime = await showtimeOf(tx, booking.showtime_id);
  const problem: SeatProblem | null =
    showtime.status === ShowtimeStatus.CANCELLED
      ? { reason: ReviewReason.SHOWTIME_CANCELLED, seatIds: [] }
      : heldSeatsProblem(seats, booking.id);
  return {
    showtime,
    seatIds: problem ? [] : seats.map((seat) => seat.seatId),
    problem,
  };
}

/**
 * Branch A: seats SOLD, booking CONFIRMED, one ISSUED ticket per seat, outbox
 * `booking.confirmed`. Returns the ticket ids. Every count is checked: anything off rolls the
 * whole IPN back rather than confirming a booking that does not own all of its seats.
 */
async function confirmBooking(
  tx: Tx,
  ctx: { booking: BookingRow; payment: PaymentRow; seatIds: string[] },
  input: ConfirmPaymentInput,
): Promise<string[]> {
  const { booking, payment, seatIds } = ctx;
  const { now } = input;

  const sold = await tx.$executeRaw`
    UPDATE showtime_seats SET status = 'SOLD', held_until = NULL
    WHERE showtime_id = ${booking.showtime_id}::uuid AND seat_id = ANY(${seatIds}::uuid[])
      AND status = 'HELD' AND booking_id = ${booking.id}::uuid`;
  if (sold !== seatIds.length) {
    throw new Error(`Booking ${booking.id}: ${sold} of ${seatIds.length} seats could be sold`);
  }

  const confirmed = await tx.$executeRaw`
    UPDATE bookings SET status = 'CONFIRMED', confirmed_at = ${now}, updated_at = ${now}
    WHERE id = ${booking.id}::uuid AND status IN ('PENDING', 'EXPIRED')`;
  if (confirmed !== 1) throw new Error(`Booking ${booking.id} could not be confirmed`);

  // No skipDuplicates: ON CONFLICT DO NOTHING would also swallow a violation of the partial
  // unique index on (showtime_id, seat_id) and confirm a booking with a ticket missing.
  const tickets = await tx.ticket.createManyAndReturn({
    data: seatIds.map((seatId) => ({
      bookingId: booking.id,
      showtimeId: booking.showtime_id,
      seatId,
      code: input.ticketCode(),
      status: TicketStatus.ISSUED,
      createdAt: now,
      updatedAt: now,
    })),
    select: { id: true },
  });
  const ticketIds = tickets.map((ticket) => ticket.id);

  await writeOutboxEvent(
    tx,
    {
      type: OutboxEventType.BOOKING_CONFIRMED,
      aggregateId: booking.id,
      payload: {
        bookingId: booking.id,
        bookingCode: booking.code,
        userId: booking.user_id,
        showtimeId: booking.showtime_id,
        paymentId: payment.id,
        seatIds,
        ticketIds,
      },
    },
    now,
  );
  return ticketIds;
}

/** Branch C: booking NEEDS_REVIEW, outbox `booking.needs_review`; seats and tickets untouched. */
async function sendToReview(
  tx: Tx,
  ctx: { booking: BookingRow; payment: PaymentRow; ipn: VnpayIpnResult; problem: SeatProblem },
  now: Date,
): Promise<void> {
  const { booking, payment, ipn, problem } = ctx;
  const updated = await tx.$executeRaw`
    UPDATE bookings SET status = 'NEEDS_REVIEW', updated_at = ${now}
    WHERE id = ${booking.id}::uuid AND status IN ('PENDING', 'EXPIRED')`;
  if (updated !== 1) throw new Error(`Booking ${booking.id} could not be sent to review`);

  await writeOutboxEvent(
    tx,
    {
      type: OutboxEventType.BOOKING_NEEDS_REVIEW,
      aggregateId: booking.id,
      payload: {
        bookingId: booking.id,
        bookingCode: booking.code,
        userId: booking.user_id,
        showtimeId: booking.showtime_id,
        paymentId: payment.id,
        amount: payment.amount,
        vnpTransactionNo: ipn.transactionNo,
        reason: problem.reason,
        seatIds: problem.seatIds,
      },
    },
    now,
  );
}
