import type { PrismaClient } from '../../../src/generated/prisma/client';

export interface SeatState {
  seatId: string;
  status: string;
  bookingId: string | null;
  heldUntil: Date | null;
}

export interface BookingState {
  id: string;
  userId: string;
  status: string;
  holdUntil: Date;
  /** Its `booking_seats`, sorted. */
  seatIds: string[];
}

/** Everything a scenario checks about one showtime, read with plain SQL after the burst. */
export interface ShowtimeSnapshot {
  seats: SeatState[];
  bookings: BookingState[];
}

export async function snapshot(
  prisma: PrismaClient,
  showtimeId: string,
): Promise<ShowtimeSnapshot> {
  const [seats, bookings, lines] = await Promise.all([
    prisma.$queryRaw<SeatState[]>`
      SELECT seat_id AS "seatId", status::text AS status, booking_id AS "bookingId",
             held_until AS "heldUntil"
      FROM showtime_seats WHERE showtime_id = ${showtimeId}::uuid ORDER BY seat_id`,
    prisma.$queryRaw<Omit<BookingState, 'seatIds'>[]>`
      SELECT id, user_id AS "userId", status::text AS status, hold_until AS "holdUntil"
      FROM bookings WHERE showtime_id = ${showtimeId}::uuid`,
    prisma.$queryRaw<{ bookingId: string; seatId: string }[]>`
      SELECT booking_id AS "bookingId", seat_id AS "seatId"
      FROM booking_seats WHERE showtime_id = ${showtimeId}::uuid ORDER BY seat_id`,
  ]);
  return {
    seats,
    bookings: bookings.map((b) => ({
      ...b,
      seatIds: lines.filter((line) => line.bookingId === b.id).map((line) => line.seatId),
    })),
  };
}

/**
 * Seats listed in `booking_seats` of more than one live booking (PENDING, CONFIRMED,
 * NEEDS_REVIEW) of the showtime: a seat sold or held twice. Must always be empty.
 */
export async function doubleBookedSeats(prisma: PrismaClient, showtimeId: string) {
  return prisma.$queryRaw<{ seatId: string; bookings: number }[]>`
    SELECT bs.seat_id AS "seatId", count(*)::int AS bookings
    FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
    WHERE bs.showtime_id = ${showtimeId}::uuid AND b.status <> 'EXPIRED'
    GROUP BY bs.seat_id HAVING count(*) > 1`;
}

/** `pg_stat_database.deadlocks` of the current database. Reported late by backends: reference only. */
export async function deadlockCount(prisma: PrismaClient): Promise<number> {
  const [row] = await prisma.$queryRaw<{ deadlocks: number }[]>`
    SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  return row?.deadlocks ?? 0;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

/** One request of a burst and what it got back. */
export interface SentHold {
  userId: string;
  seatIds: string[];
  status: number;
  bookingId?: string;
  holdUntil?: string;
}

/**
 * Every rule scenario A and B check after a burst on a fresh showtime, as readable violations
 * (empty = all good):
 * - a 201 created exactly one booking of that user, with exactly the requested seats in
 *   `booking_seats`, all of them HELD by it with `held_until` = its `holdUntil`;
 * - any other answer left no booking for that user (all or nothing);
 * - nothing else changed: every seat not held by a 201 is AVAILABLE with no booking;
 * - no seat belongs to two live bookings.
 */
export function violations(state: ShowtimeSnapshot, sent: readonly SentHold[]): string[] {
  const found: string[] = [];
  const bookingsById = new Map(state.bookings.map((b) => [b.id, b]));
  const winners = sent.filter((s) => s.status === 201);
  const heldBy = new Map<string, string>();

  for (const win of winners) {
    const booking = win.bookingId ? bookingsById.get(win.bookingId) : undefined;
    if (!booking) {
      found.push(`201 for user ${win.userId} but booking ${win.bookingId ?? '?'} is not stored`);
      continue;
    }
    if (booking.userId !== win.userId) found.push(`booking ${booking.id} belongs to another user`);
    if (booking.status !== 'PENDING') found.push(`booking ${booking.id} is ${booking.status}`);
    if (!sameSet(booking.seatIds, win.seatIds)) {
      found.push(
        `booking ${booking.id}: booking_seats ${booking.seatIds.join(',')} ≠ requested ${win.seatIds.join(',')}`,
      );
    }
    if (win.holdUntil && booking.holdUntil.toISOString() !== win.holdUntil) {
      found.push(`booking ${booking.id}: stored holdUntil differs from the response`);
    }
    for (const seatId of win.seatIds) heldBy.set(seatId, booking.id);
  }

  const winnerIds = new Set(winners.map((w) => w.bookingId));
  for (const booking of state.bookings) {
    if (!winnerIds.has(booking.id)) {
      found.push(`booking ${booking.id} of user ${booking.userId} exists without a 201`);
    }
  }

  for (const seat of state.seats) {
    const owner = heldBy.get(seat.seatId);
    if (owner) {
      const booking = bookingsById.get(owner);
      if (seat.status !== 'HELD' || seat.bookingId !== owner) {
        found.push(
          `seat ${seat.seatId}: ${seat.status}/${seat.bookingId ?? 'null'}, want HELD by ${owner}`,
        );
      } else if (booking && seat.heldUntil?.getTime() !== booking.holdUntil.getTime()) {
        found.push(`seat ${seat.seatId}: held_until ≠ holdUntil of booking ${owner}`);
      }
    } else if (seat.status !== 'AVAILABLE' || seat.bookingId !== null || seat.heldUntil !== null) {
      found.push(
        `seat ${seat.seatId}: ${seat.status}/${seat.bookingId ?? 'null'} but no 201 holds it`,
      );
    }
  }

  const perSeat = new Map<string, number>();
  for (const booking of state.bookings.filter((b) => b.status !== 'EXPIRED')) {
    for (const seatId of booking.seatIds) perSeat.set(seatId, (perSeat.get(seatId) ?? 0) + 1);
  }
  for (const [seatId, count] of perSeat) {
    if (count > 1) found.push(`seat ${seatId} is in ${count} live bookings`);
  }
  return found;
}
