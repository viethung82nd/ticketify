import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ShowtimeSeatStatus, ShowtimeStatus } from '@ticketify/shared';

/** One seat of a paid booking, as locked by the IPN transaction. */
export interface BookingSeatState {
  seatId: string;
  status: ShowtimeSeatStatus;
  bookingId: string | null;
  heldUntil: Date | null;
}

/**
 * Why a paid booking could not keep its seats and went to NEEDS_REVIEW (`booking.needs_review`
 * payload). Most serious first: when several seats fail for different reasons, the first one in
 * this list names the case.
 */
export const ReviewReason = {
  /** The showtime was cancelled. */
  SHOWTIME_CANCELLED: 'SHOWTIME_CANCELLED',
  /** The showtime is over (`endsAt <= now`): a ticket would be of no use. */
  SHOWTIME_ENDED: 'SHOWTIME_ENDED',
  /** A seat is SOLD (to another booking). */
  SEAT_SOLD: 'SEAT_SOLD',
  /** Another booking holds a seat. */
  SEAT_HELD_BY_OTHER: 'SEAT_HELD_BY_OTHER',
  /** A PENDING booking whose seat is no longer HELD for it (released). */
  SEAT_RELEASED: 'SEAT_RELEASED',
  /** The booking has no seat at all (never expected). */
  NO_SEATS: 'NO_SEATS',
} as const;
export type ReviewReason = (typeof ReviewReason)[keyof typeof ReviewReason];

export interface SeatProblem {
  reason: ReviewReason;
  /** The seats behind `reason` and every other failing seat, sorted; empty for the showtime. */
  seatIds: string[];
}

/**
 * Whether the showtime still takes a paid booking, whatever its seats: not when it was cancelled,
 * nor once it is over. A showtime that has started but not ended still does (ROADMAP "Đã chốt":
 * late entry), the caller only logs a warning.
 */
export function showtimeProblem(
  showtime: { status: ShowtimeStatus; endsAt: Date },
  now: Date,
): SeatProblem | null {
  if (showtime.status === ShowtimeStatus.CANCELLED) {
    return { reason: ReviewReason.SHOWTIME_CANCELLED, seatIds: [] };
  }
  if (showtime.endsAt.getTime() <= now.getTime()) {
    return { reason: ReviewReason.SHOWTIME_ENDED, seatIds: [] };
  }
  return null;
}

const SEVERITY: readonly ReviewReason[] = [
  ReviewReason.SEAT_SOLD,
  ReviewReason.SEAT_HELD_BY_OTHER,
  ReviewReason.SEAT_RELEASED,
];

function problemOf(
  seats: readonly BookingSeatState[],
  reasonOf: (seat: BookingSeatState) => ReviewReason | null,
): SeatProblem | null {
  if (seats.length === 0) return { reason: ReviewReason.NO_SEATS, seatIds: [] };
  const failing = seats.flatMap((seat) => {
    const reason = reasonOf(seat);
    return reason ? [{ seatId: seat.seatId, reason }] : [];
  });
  if (failing.length === 0) return null;
  const reason = SEVERITY.find((r) => failing.some((f) => f.reason === r)) ?? failing[0]!.reason;
  return { reason, seatIds: failing.map((f) => f.seatId).sort() };
}

/**
 * Branch A (PLAN §5 step 6.2) for a PENDING booking: every seat must still be HELD by it, even
 * past `heldUntil` (nobody took it). `null` when it can be confirmed as it is.
 */
export function heldSeatsProblem(
  seats: readonly BookingSeatState[],
  bookingId: string,
): SeatProblem | null {
  return problemOf(seats, (seat) => {
    if (seat.status === ShowtimeSeatStatus.HELD && seat.bookingId === bookingId) return null;
    if (seat.status === ShowtimeSeatStatus.SOLD) return ReviewReason.SEAT_SOLD;
    if (seat.status === ShowtimeSeatStatus.HELD) return ReviewReason.SEAT_HELD_BY_OTHER;
    return ReviewReason.SEAT_RELEASED;
  });
}

/**
 * A seat an EXPIRED booking may take back: AVAILABLE, still HELD by the booking itself, or HELD by
 * another booking past its `heldUntil`. The last one is free for anyone (PLAN §4 rule 3, lazy
 * expiry): the hold flow would give it to a new booking just the same.
 */
export function isReclaimable(seat: BookingSeatState, bookingId: string, now: Date): boolean {
  if (seat.status === ShowtimeSeatStatus.AVAILABLE) return true;
  if (seat.status !== ShowtimeSeatStatus.HELD) return false;
  if (seat.bookingId === bookingId) return true;
  return seat.heldUntil !== null && seat.heldUntil.getTime() <= now.getTime();
}

/**
 * Branch B (PLAN §5 step 6.3) for an EXPIRED booking: every seat must be reclaimable
 * (`isReclaimable`). `null` when all of them can be taken back; otherwise none is.
 */
export function reclaimProblem(
  seats: readonly BookingSeatState[],
  bookingId: string,
  now: Date,
): SeatProblem | null {
  return problemOf(seats, (seat) => {
    if (isReclaimable(seat, bookingId, now)) return null;
    return seat.status === ShowtimeSeatStatus.SOLD
      ? ReviewReason.SEAT_SOLD
      : ReviewReason.SEAT_HELD_BY_OTHER;
  });
}

/** No 0/O or 1/I: the code is read out at the door. */
const TICKET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICKET_CODE_LENGTH = 12;

/**
 * Ticket codes (`tickets.code`, unique), one draw per ticket: 32^12 ≈ 10^18 values. A collision
 * fails the insert and rolls the whole confirmation back (the IPN answers 500 and VNPay calls
 * again). A provider so that tests can replace it.
 */
@Injectable()
export class TicketCodes {
  /** Random code, e.g. `TQ7PX3MQ9TA2`. */
  next(): string {
    let code = '';
    for (let i = 0; i < TICKET_CODE_LENGTH; i++) {
      code += TICKET_CODE_ALPHABET[randomInt(TICKET_CODE_ALPHABET.length)];
    }
    return code;
  }
}
