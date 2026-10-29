import type { ShowtimeSeatStatus, ShowtimeStatus } from '@ticketify/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { BookingSeatState } from './seat-settlement';

type Tx = Prisma.TransactionClient;

interface SeatRow {
  seat_id: string;
  status: ShowtimeSeatStatus;
  booking_id: string | null;
  held_until: Date | null;
}

/**
 * The seats of a booking as `booking_seats` records them (kept after a release), locked
 * `FOR UPDATE ORDER BY seat_id` like every other flow that locks seats (PLAN §4). Seats another
 * booking holds or bought by now are locked as well, so nobody can change them before the caller
 * decides; the booking_seats rows themselves are not locked.
 */
export async function lockSeatsOfBooking(tx: Tx, bookingId: string): Promise<BookingSeatState[]> {
  const rows = await tx.$queryRaw<SeatRow[]>`
    SELECT seat_id, status::text AS status, booking_id, held_until FROM showtime_seats
    WHERE (showtime_id, seat_id) IN (
      SELECT showtime_id, seat_id FROM booking_seats WHERE booking_id = ${bookingId}::uuid)
    ORDER BY seat_id
    FOR UPDATE`;
  return rows.map((row) => ({
    seatId: row.seat_id,
    status: row.status,
    bookingId: row.booking_id,
    heldUntil: row.held_until,
  }));
}

export interface ShowtimeState {
  id: string;
  status: ShowtimeStatus;
  startsAt: Date;
}

/**
 * The showtime, read without a lock. Read it after `lockSeatsOfBooking`: a showtime cancel locks
 * the showtime and then all of its seats in seat_id order, so one that committed before the seat
 * locks is visible here, and one that comes later waits for those locks and then finds the seats
 * SOLD (it refuses HELD and SOLD seats).
 */
export async function showtimeOf(tx: Tx, showtimeId: string): Promise<ShowtimeState> {
  const [row] = await tx.$queryRaw<{ status: ShowtimeStatus; starts_at: Date }[]>`
    SELECT status::text AS status, starts_at FROM showtimes WHERE id = ${showtimeId}::uuid`;
  if (!row) throw new Error(`Showtime ${showtimeId} of a booking does not exist`);
  return { id: showtimeId, status: row.status, startsAt: row.starts_at };
}
