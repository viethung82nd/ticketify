import { BookingStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';
import { lockSeatsOfBooking, type ShowtimeState, showtimeOf } from './booking-seats';
import { reclaimProblem, type SeatProblem, showtimeProblem } from './seat-settlement';

type Tx = Prisma.TransactionClient;

export type ReclaimOutcome =
  /** Every seat is HELD by the booking again; the caller sells them in the same transaction. */
  | { reclaimed: true; seatIds: string[]; showtime: ShowtimeState }
  /** Nothing changed: at least one seat (or the showtime) is lost. */
  | { reclaimed: false; problem: SeatProblem; showtime: ShowtimeState };

/**
 * Branch B of the IPN (PLAN §5 step 6.3, ROADMAP 3.5): a booking that EXPIRED before its payment
 * was confirmed takes its seats back, if every one of them is still free for it (`isReclaimable`:
 * AVAILABLE, HELD by itself, or HELD by another booking past `heldUntil`) and the showtime is
 * neither cancelled nor over. All or nothing: one lost seat and no seat changes.
 *
 * Runs inside the IPN transaction, which already holds Payment → Booking (`FOR UPDATE`); it locks
 * the booking's seats next, `FOR UPDATE ORDER BY seat_id`, so the check and the update below see
 * the same rows. Reclaimed seats are left HELD by the booking (`held_until = now`, already past):
 * the caller turns them SOLD before it commits.
 */
export async function reclaimSeatsForExpiredBooking(
  tx: Tx,
  bookingId: string,
  now: Date,
): Promise<ReclaimOutcome> {
  const [booking] = await tx.$queryRaw<{ status: BookingStatus; showtime_id: string }[]>`
    SELECT status::text AS status, showtime_id FROM bookings WHERE id = ${bookingId}::uuid`;
  if (booking?.status !== BookingStatus.EXPIRED) {
    throw new Error(`Booking ${bookingId} is not EXPIRED; only an expired booking reclaims seats`);
  }

  // 1. Seats first, then the showtime (see showtimeOf).
  const seats = await lockSeatsOfBooking(tx, bookingId);
  const showtime = await showtimeOf(tx, booking.showtime_id);
  // Cancelled or over: nothing to take back for.
  const closed = showtimeProblem(showtime, now);
  if (closed) return { reclaimed: false, problem: closed, showtime };

  // 2. All or nothing: one seat SOLD or held by a live booking and none is taken.
  const problem = reclaimProblem(seats, bookingId, now);
  if (problem) return { reclaimed: false, problem, showtime };

  // 3. Conditional update, the same condition as the check: a second line of defence behind the
  //    locks, as in the hold flow. Fewer rows than seats cannot happen while the locks are held;
  //    if it does, the whole IPN transaction rolls back (500, VNPay calls again).
  const seatIds = seats.map((seat) => seat.seatId);
  const updated = await tx.$executeRaw`
    UPDATE showtime_seats
    SET status = 'HELD', booking_id = ${bookingId}::uuid, held_until = ${now}
    WHERE showtime_id = ${showtime.id}::uuid AND seat_id = ANY(${seatIds}::uuid[])
      AND (status = 'AVAILABLE'
        OR (status = 'HELD' AND (booking_id = ${bookingId}::uuid OR held_until <= ${now})))`;
  if (updated !== seatIds.length) {
    throw new Error(
      `Reclaim of booking ${bookingId} updated ${updated} of ${seatIds.length} locked seats`,
    );
  }
  return { reclaimed: true, seatIds, showtime };
}
