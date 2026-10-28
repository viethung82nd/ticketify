import { BookingStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** What `expireBooking` did. Every outcome but `expired` leaves the database untouched. */
export type ExpireOutcome =
  /** Another transaction holds the booking row (the other of job/sweep): it decides. */
  | { outcome: 'skipped' }
  /** Unknown booking, or no longer PENDING (already expired, confirmed...): nothing to do. */
  | { outcome: 'noop' }
  /** `now < holdUntil`: too soon. The caller tries again at `holdUntil`. */
  | { outcome: 'early'; holdUntil: Date }
  /**
   * Booking EXPIRED; `releasedSeatIds` (sorted) are the seats of its own that went back to
   * AVAILABLE — empty when other bookings had already taken them all (lazy expiry).
   */
  | { outcome: 'expired'; showtimeId: string; releasedSeatIds: string[] };

export type ExpireOutcomeKind = ExpireOutcome['outcome'];

interface BookingRow {
  status: BookingStatus;
  hold_until: Date;
  showtime_id: string;
}

/**
 * Expires one booking (PLAN §4 "Luồng hết hạn"), shared by the `expire-booking` job and the
 * per-minute sweep. Runs inside the caller's transaction, one booking per transaction.
 *
 * Takes the transaction as a parameter on purpose: from week 13 (ROADMAP 3.7) the caller first
 * asks VNPay (querydr) about a pending payment — an HTTP call that must never run while seat
 * locks are held — and only then opens the transaction that calls this, which re-checks
 * everything under the row lock.
 *
 * Locks, in this order (PLAN §4: Payment → Booking → ShowtimeSeat):
 * 1. the booking row `FOR UPDATE SKIP LOCKED` — never waits: whoever got it first does the work;
 * 2. the booking's own HELD seats `FOR UPDATE ORDER BY seat_id`.
 * A hold never waits on a lock (NOWAIT) and a showtime cancel never locks `bookings`, so no flow
 * can wait on this one in a cycle.
 */
export async function expireBooking(tx: Tx, bookingId: string, now: Date): Promise<ExpireOutcome> {
  // 1. Lock the booking. No row: either it does not exist or another transaction has it.
  const [booking] = await tx.$queryRaw<BookingRow[]>`
    SELECT status::text AS status, hold_until, showtime_id FROM bookings
    WHERE id = ${bookingId}::uuid
    FOR UPDATE SKIP LOCKED`;
  if (!booking) {
    const [exists] = await tx.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM bookings WHERE id = ${bookingId}::uuid`;
    return exists ? { outcome: 'skipped' } : { outcome: 'noop' };
  }

  // 2. Idempotent: a second run, or a booking paid in the meantime.
  if (booking.status !== BookingStatus.PENDING) return { outcome: 'noop' };

  // 3. Too soon (job ran early, clock skew): change nothing, the caller retries at holdUntil.
  if (now.getTime() < booking.hold_until.getTime()) {
    return { outcome: 'early', holdUntil: booking.hold_until };
  }

  // 4. A PENDING Payment cannot exist yet (payments start in week 11).
  // TODO(3.7): querydr ngoài transaction — the caller reads the PENDING payment and calls VNPay
  // before opening this transaction; here, re-check the payment row (locked first, PLAN order
  // Payment → Booking → Seats): SUCCESS → confirmPayment() path, otherwise Payment = EXPIRED.

  // 5. The booking is over.
  await tx.$executeRaw`
    UPDATE bookings SET status = 'EXPIRED', updated_at = ${now}
    WHERE id = ${bookingId}::uuid`;

  // 6. Lock its seats in seat_id order, like every other flow that locks seats.
  await tx.$queryRaw`
    SELECT seat_id FROM showtime_seats
    WHERE booking_id = ${bookingId}::uuid AND status = 'HELD'
    ORDER BY seat_id
    FOR UPDATE`;

  // 7. Release only seats still HELD by THIS booking. Once holdUntil has passed, another booking
  //    may already have taken a seat (lazy expiry: the hold flow treats an expired HELD seat as
  //    free and points it at the new booking) — `booking_id = $1` leaves that seat alone. A SOLD
  //    seat is never touched either.
  const released = await tx.$queryRaw<{ seat_id: string }[]>`
    UPDATE showtime_seats
    SET status = 'AVAILABLE', booking_id = NULL, held_until = NULL
    WHERE booking_id = ${bookingId}::uuid AND status = 'HELD'
    RETURNING seat_id`;

  // (phase 4) INSERT outbox(seats.released); (phase 5) VoucherUsage RESERVED → RELEASED.
  // Until then the caller emits `seat:released` itself, once this transaction has committed.
  return {
    outcome: 'expired',
    showtimeId: booking.showtime_id,
    releasedSeatIds: released.map((row) => row.seat_id).sort(),
  };
}
