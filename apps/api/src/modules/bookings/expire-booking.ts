import { BookingStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';
import { type ConfirmOutcome, confirmPayment } from '../payment/confirm-payment';
import {
  OutboxEventType,
  SeatsReleasedCause,
  writeOutboxEvent,
} from '../../infra/outbox/outbox-events';

type Tx = Prisma.TransactionClient;

/** What `expireBooking` did. Every outcome but `expired` and `paid` leaves the database untouched. */
export type ExpireOutcome =
  /** Another transaction holds the booking row (the other of job/sweep): it decides. */
  | { outcome: 'skipped' }
  /** Unknown booking, or no longer PENDING (already expired, confirmed...): nothing to do. */
  | { outcome: 'noop' }
  /** `now < holdUntil`: too soon. The caller tries again at `holdUntil`. */
  | { outcome: 'early'; holdUntil: Date }
  /**
   * VNPay told the caller (querydr, before this transaction) that a PENDING payment of the booking
   * had gone through, and the result was recorded here exactly as the IPN records it (ROADMAP 3.7).
   * The booking did **not** expire; `confirmation` says what happened to it and its seats.
   */
  | { outcome: 'paid'; paymentId: string; confirmation: ConfirmOutcome }
  /**
   * Booking EXPIRED; `releasedSeatIds` (sorted) are the seats of its own that went back to
   * AVAILABLE — empty when other bookings had already taken them all (lazy expiry).
   * `expiredPaymentIds` are the attempts that were still PENDING and are now EXPIRED.
   */
  | {
      outcome: 'expired';
      showtimeId: string;
      releasedSeatIds: string[];
      expiredPaymentIds: string[];
    };

export type ExpireOutcomeKind = ExpireOutcome['outcome'];

/** A querydr answer that said "paid", for one PENDING payment of the booking (ROADMAP 3.7). */
export interface PaidQuerydr {
  /** The payment the caller asked VNPay about. Ignored unless it is still PENDING here. */
  paymentId: string;
  /** `vnp_TxnRef` it was asked about. Ignored unless it is still that payment's `txn_ref`. */
  txnRef: string;
  /** The querydr response as received; stored verbatim as the payment's `raw_payload`. */
  params: Readonly<Record<string, string>>;
}

export interface ExpireBookingInput {
  /**
   * What VNPay answered about the booking's payment, obtained **outside** this transaction
   * (PLAN §4: the HTTP call must never run while locks are held). Only an answer that said "paid"
   * is passed in; anything else, including a network error, is left out and the booking expires.
   */
  paid?: PaidQuerydr | null;
  /** Draws one ticket code. Required only together with `paid`. */
  ticketCode?: () => string;
}

/** Outcomes of `confirmPayment` that wrote something, so the booking must not also expire. */
const CONFIRM_WROTE: ReadonlySet<ConfirmOutcome['outcome']> = new Set([
  'confirmed',
  'needs_review',
  'paid_twice',
]);

interface BookingRow {
  status: BookingStatus;
  hold_until: Date;
  showtime_id: string;
}

interface PendingPaymentRow {
  id: string;
  txn_ref: string;
}

/**
 * Expires one booking (PLAN §4 "Luồng hết hạn"), shared by the `expire-booking` job and the
 * per-minute sweep. Runs inside the caller's transaction, one booking per transaction.
 *
 * Takes the transaction as a parameter on purpose: the caller first asks VNPay (querydr) about a
 * pending payment — an HTTP call that must never run while row locks are held — and only then
 * opens the transaction that calls this, which locks the same rows and checks every condition
 * again. A querydr answer is never acted on by itself: the payment must still be PENDING with the
 * `txn_ref` that was asked about, and `confirmPayment` then re-reads and re-checks the amount and
 * the seats under its own locks.
 *
 * Locks, in this order (PLAN §4: Payment → Booking → ShowtimeSeat):
 * 1. the booking's PENDING payments `FOR UPDATE` — the IPN takes the payment row first too, so
 *    the two never wait on each other in a cycle; the worker's `lock_timeout` bounds the wait;
 * 2. the booking row `FOR UPDATE SKIP LOCKED` — never waits: whoever got it first does the work;
 * 3. the booking's own HELD seats `FOR UPDATE ORDER BY seat_id`.
 * A hold never waits on a lock (NOWAIT) and a showtime cancel never locks `bookings`, so no flow
 * can wait on this one in a cycle.
 *
 * Seats that went back are announced through the outbox (`seats.released`), written here so it
 * commits with them: a row that exists is a change that happened.
 */
export async function expireBooking(
  tx: Tx,
  bookingId: string,
  now: Date,
  input: ExpireBookingInput = {},
): Promise<ExpireOutcome> {
  // 1. The booking's unfinished payment attempts, locked before the booking row: PLAN §4 fixes the
  //    order Payment → Booking → Seats for every flow, and the IPN follows it as well. Locked even
  //    when the booking turns out not to need expiring — the order cannot depend on what is read.
  const payments = await tx.$queryRaw<PendingPaymentRow[]>`
    SELECT id, txn_ref FROM payments
    WHERE booking_id = ${bookingId}::uuid AND status = 'PENDING'
    ORDER BY created_at, id
    FOR UPDATE`;

  // 2. Lock the booking. No row: either it does not exist or another transaction has it.
  const [booking] = await tx.$queryRaw<BookingRow[]>`
    SELECT status::text AS status, hold_until, showtime_id FROM bookings
    WHERE id = ${bookingId}::uuid
    FOR UPDATE SKIP LOCKED`;
  if (!booking) {
    const [exists] = await tx.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM bookings WHERE id = ${bookingId}::uuid`;
    return exists ? { outcome: 'skipped' } : { outcome: 'noop' };
  }

  // 3. Idempotent: a second run, or a booking paid in the meantime.
  if (booking.status !== BookingStatus.PENDING) return { outcome: 'noop' };

  // 4. Too soon (job ran early, clock skew): change nothing, the caller retries at holdUntil.
  if (now.getTime() < booking.hold_until.getTime()) {
    return { outcome: 'early', holdUntil: booking.hold_until };
  }

  // 5. The money may already have arrived: record it instead of expiring (ROADMAP 3.7). The answer
  //    counts only if the attempt it is about is still one of the PENDING ones locked above; a
  //    payment the IPN settled meanwhile is not in that list, and the IPN has done this work.
  if (input.paid) {
    const asked = payments.find(
      (row) => row.id === input.paid?.paymentId && row.txn_ref === input.paid.txnRef,
    );
    if (asked) {
      const ticketCode = input.ticketCode;
      if (!ticketCode) throw new Error('expireBooking: a querydr answer needs a ticketCode source');
      const confirmation = await confirmPayment(tx, {
        txnRef: asked.txn_ref,
        params: input.paid.params,
        now,
        ticketCode,
      });
      if (CONFIRM_WROTE.has(confirmation.outcome)) {
        return { outcome: 'paid', paymentId: asked.id, confirmation };
      }
      if (confirmation.outcome === 'failed') {
        // Unreachable: a querydr answer only counts as "paid" when vnp_ResponseCode and
        // vnp_TransactionStatus are both 00, which is exactly what `readVnpayIpn` calls a success.
        // Reaching it means the two readings disagree; roll the transaction back and retry.
        throw new Error(
          `Payment ${asked.id} was reported paid by querydr but read as a failure; nothing written`,
        );
      }
      // not_found, invalid_amount, already_processed: nothing was written. The HTTP answer does not
      // match the row, so it is ignored and the booking expires as it would have without querydr.
    }
  }

  // 6. The booking is over.
  await tx.$executeRaw`
    UPDATE bookings SET status = 'EXPIRED', updated_at = ${now}
    WHERE id = ${bookingId}::uuid`;

  // 7. Its unfinished attempts are over too (PLAN §4). EXPIRED is not a final payment status: an
  //    IPN arriving later (VNPay retries for up to ~45 minutes) still records its result, because
  //    money that arrives late must be accounted for (PLAN §5 step 4).
  if (payments.length > 0) {
    const expired = await tx.$executeRaw`
      UPDATE payments SET status = 'EXPIRED', updated_at = ${now}
      WHERE booking_id = ${bookingId}::uuid AND status = 'PENDING'`;
    if (expired !== payments.length) {
      throw new Error(
        `Booking ${bookingId}: expired ${expired} of ${payments.length} locked PENDING payments`,
      );
    }
  }

  // 8. Lock its seats in seat_id order, like every other flow that locks seats.
  await tx.$queryRaw`
    SELECT seat_id FROM showtime_seats
    WHERE booking_id = ${bookingId}::uuid AND status = 'HELD'
    ORDER BY seat_id
    FOR UPDATE`;

  // 9. Release only seats still HELD by THIS booking. Once holdUntil has passed, another booking
  //    may already have taken a seat (lazy expiry: the hold flow treats an expired HELD seat as
  //    free and points it at the new booking) — `booking_id = $1` leaves that seat alone. A SOLD
  //    seat is never touched either.
  const released = await tx.$queryRaw<{ seat_id: string }[]>`
    UPDATE showtime_seats
    SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL
    WHERE booking_id = ${bookingId}::uuid AND status = 'HELD'
    RETURNING seat_id`;
  const releasedSeatIds = released.map((row) => row.seat_id).sort();

  // 10. One `seats.released` event, in this transaction, only when seats really went back
  //    (ROADMAP 4.1). The relay turns it into the `seat:released` every browser watching the
  //    showtime gets, so the news survives this worker being killed right after the commit. The
  //    caller still emits the same event itself for speed; receiving it twice changes nothing.
  //    (phase 5) VoucherUsage RESERVED → RELEASED goes here too.
  if (releasedSeatIds.length > 0) {
    await writeOutboxEvent(
      tx,
      {
        type: OutboxEventType.SEATS_RELEASED,
        aggregateId: bookingId,
        payload: {
          bookingId,
          showtimeId: booking.showtime_id,
          seatIds: releasedSeatIds,
          cause: SeatsReleasedCause.BOOKING_EXPIRED,
        },
      },
      now,
    );
  }

  return {
    outcome: 'expired',
    showtimeId: booking.showtime_id,
    releasedSeatIds,
    expiredPaymentIds: payments.map((row) => row.id),
  };
}
