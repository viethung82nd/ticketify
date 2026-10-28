import {
  PublicSeatStatus,
  ShowtimeErrorCode,
  ShowtimeSeatStatus,
  ShowtimeStatus,
} from '@ticketify/shared';
import { validationFailed } from '../../common/errors/api-error';

const MINUTE_MS = 60_000;

/** `startsAt` + film + cleaning. The room is free again from `endsAt` (half-open range). */
export function showtimeEndsAt(
  startsAt: Date,
  durationMinutes: number,
  cleanupMinutes: number,
): Date {
  return new Date(startsAt.getTime() + (durationMinutes + cleanupMinutes) * MINUTE_MS);
}

/**
 * A showtime must start after "now". This is a limit on the value of `startsAt` (CONTRIBUTING.md,
 * error codes), so it is `400 VALIDATION_FAILED`; it lives here because the DTO has no clock.
 */
export function assertStartsInFuture(startsAt: Date, now: Date): void {
  if (startsAt.getTime() > now.getTime()) return;
  throw validationFailed([
    { field: 'startsAt', messages: [`startsAt must be after ${now.toISOString()}`] },
  ]);
}

export interface SeatState {
  status: ShowtimeSeatStatus;
  heldUntil: Date | null;
  /** `Seat.isActive`: a switched-off seat is never offered. */
  isActive: boolean;
}

/**
 * Status shown to customers, with lazy expiry (PLAN §4): a HELD seat whose `heldUntil` has
 * passed is AVAILABLE even before any job releases it. Read-only, nothing is written.
 */
export function publicSeatStatus(seat: SeatState, now: Date): PublicSeatStatus {
  if (!seat.isActive) return PublicSeatStatus.UNAVAILABLE;
  if (
    seat.status === ShowtimeSeatStatus.HELD &&
    seat.heldUntil !== null &&
    seat.heldUntil.getTime() <= now.getTime()
  ) {
    return PublicSeatStatus.AVAILABLE;
  }
  return seat.status;
}

export type CancelDecision =
  | { action: 'cancel' }
  /** Already cancelled: cancelling again succeeds and changes nothing. */
  | { action: 'none' }
  | {
      action: 'reject';
      code:
        typeof ShowtimeErrorCode.SHOWTIME_STARTED | typeof ShowtimeErrorCode.SHOWTIME_HAS_BOOKINGS;
    };

/**
 * Whether `POST /admin/showtimes/:id/cancel` may cancel. There are no refunds, so any HELD or
 * SOLD seat blocks it, including a HELD seat whose hold has expired: a late payment notification
 * may still confirm it (PLAN §5, step 2).
 */
export function cancelDecision(
  showtime: { status: ShowtimeStatus; startsAt: Date },
  seats: { held: number; sold: number },
  now: Date,
): CancelDecision {
  if (showtime.status === ShowtimeStatus.CANCELLED) return { action: 'none' };
  if (showtime.startsAt.getTime() <= now.getTime()) {
    return { action: 'reject', code: ShowtimeErrorCode.SHOWTIME_STARTED };
  }
  if (seats.held + seats.sold > 0) {
    return { action: 'reject', code: ShowtimeErrorCode.SHOWTIME_HAS_BOOKINGS };
  }
  return { action: 'cancel' };
}
