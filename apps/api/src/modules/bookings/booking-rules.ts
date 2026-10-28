import { randomInt } from 'node:crypto';
import { BookingErrorCode, ShowtimeSeatStatus, ShowtimeStatus } from '@ticketify/shared';

const SECOND_MS = 1_000;

/** `expiresAt` (countdown, last moment to pay) and `holdUntil` (seats stay HELD until then). */
export function holdDeadlines(
  now: Date,
  holdTtlSeconds: number,
  paymentGraceSeconds: number,
): { expiresAt: Date; holdUntil: Date } {
  const expiresAt = new Date(now.getTime() + holdTtlSeconds * SECOND_MS);
  const holdUntil = new Date(expiresAt.getTime() + paymentGraceSeconds * SECOND_MS);
  return { expiresAt, holdUntil };
}

export type ShowtimeRefusal =
  typeof BookingErrorCode.SHOWTIME_CANCELLED | typeof BookingErrorCode.SHOWTIME_STARTED;

/** Why seats of this showtime cannot be held now, or `null` when they can. */
export function showtimeRefusal(
  showtime: { status: ShowtimeStatus; startsAt: Date },
  now: Date,
): ShowtimeRefusal | null {
  if (showtime.status === ShowtimeStatus.CANCELLED) return BookingErrorCode.SHOWTIME_CANCELLED;
  if (showtime.startsAt.getTime() <= now.getTime()) return BookingErrorCode.SHOWTIME_STARTED;
  return null;
}

export interface LockedSeatRow {
  seatId: string;
  status: ShowtimeSeatStatus;
  heldUntil: Date | null;
}

/**
 * Seats that cannot be held: SOLD, or HELD by a hold that has not expired. A HELD seat whose
 * `heldUntil <= now` counts as free (lazy expiry, PLAN §4): no job has to release it first.
 */
export function unavailableSeatIds(rows: readonly LockedSeatRow[], now: Date): string[] {
  return rows
    .filter(
      (row) =>
        row.status === ShowtimeSeatStatus.SOLD ||
        (row.status === ShowtimeSeatStatus.HELD &&
          (row.heldUntil === null || row.heldUntil.getTime() > now.getTime())),
    )
    .map((row) => row.seatId);
}

/** Requested ids without a ShowtimeSeat row for the showtime, in request order. */
export function missingSeatIds(requested: readonly string[], found: readonly string[]): string[] {
  const present = new Set(found);
  return requested.filter((id) => !present.has(id));
}

export interface CoupleSeat {
  id: string;
  coupleGroup: number;
}

/**
 * Couple seats are sold as a pair: every seat sharing a `coupleGroup` with a requested couple
 * seat must be requested too. `coupleSeats` = all couple seats of the room in the groups the
 * request touches. Returns the partners that are missing (sorted); other seats are free to pick.
 */
export function missingCouplePartners(
  requested: readonly string[],
  coupleSeats: readonly CoupleSeat[],
): string[] {
  const wanted = new Set(requested);
  const touched = new Set(
    coupleSeats.filter((seat) => wanted.has(seat.id)).map((seat) => seat.coupleGroup),
  );
  return coupleSeats
    .filter((seat) => touched.has(seat.coupleGroup) && !wanted.has(seat.id))
    .map((seat) => seat.id)
    .sort();
}

/** No 0/O or 1/I: the code is read out at the counter. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

/** Random booking code, e.g. `K7PX3MQ9TA` (32^10 ≈ 10^15 values; `bookings.code` is unique). */
export function bookingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
