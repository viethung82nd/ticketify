import { z } from 'zod';
import { BookingStatus, SeatType } from '../enums.js';

/** Limits shared by the API DTOs and the web so both validate the same way. */
export const BOOKING_LIMITS = {
  /** Seats per booking (PLAN §1). */
  seatsMax: 6,
  /** `Idempotency-Key` header length. */
  idempotencyKeyMin: 8,
  idempotencyKeyMax: 128,
} as const;

/**
 * `Idempotency-Key`: URL-safe ASCII only (letters, digits, `-`, `_`, `.`, `~`, `:`), so a UUID or
 * a ULID fits and the key never needs escaping in logs.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]+$/;

export function isIdempotencyKey(value: string): boolean {
  return (
    value.length >= BOOKING_LIMITS.idempotencyKeyMin &&
    value.length <= BOOKING_LIMITS.idempotencyKeyMax &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

const hasNoDuplicates = (values: readonly string[]): boolean =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length;

// ─── Requests ───

/**
 * `POST /bookings` (header `Idempotency-Key` required). Seats are checked against the showtime by
 * the API: a couple seat needs its partner in the same request (`422 COUPLE_INCOMPLETE`).
 */
export const holdBookingRequestSchema = z.object({
  showtimeId: z.uuid(),
  seatIds: z
    .array(z.uuid())
    .min(1, { error: 'Vui lòng chọn ghế' })
    .max(BOOKING_LIMITS.seatsMax, { error: `Tối đa ${BOOKING_LIMITS.seatsMax} ghế mỗi đơn` })
    .refine(hasNoDuplicates, { error: 'Một ghế chỉ được chọn một lần' }),
});
export type HoldBookingRequest = z.infer<typeof holdBookingRequestSchema>;

// ─── Responses ───

export const bookingSeatSchema = z.object({
  seatId: z.uuid(),
  row: z.string(),
  number: z.number().int(),
  /** `A5`. */
  label: z.string(),
  type: z.enum(SeatType),
  /** VND, the showtime's locked price for this seat at hold time. */
  price: z.number().int(),
});
export type BookingSeat = z.infer<typeof bookingSeatSchema>;

/** `201` (new) or `200` (same `Idempotency-Key` and payload again) body of `POST /bookings`. */
export const bookingSchema = z.object({
  id: z.uuid(),
  /** Short code shown to the customer. */
  code: z.string(),
  showtimeId: z.uuid(),
  status: z.enum(BookingStatus),
  /** Countdown shown to the customer; last moment to start a payment. */
  expiresAt: z.string(),
  /** expiresAt + payment grace: the seats stay HELD until then. */
  holdUntil: z.string(),
  seats: z.array(bookingSeatSchema),
  subtotal: z.number().int(),
  discount: z.number().int(),
  total: z.number().int(),
  createdAt: z.string(),
});
export type Booking = z.infer<typeof bookingSchema>;

/** Machine-readable `code` values of booking API errors (also SHOWTIME_NOT_FOUND). */
export const BookingErrorCode = {
  /** 409: another request holds a lock on one of the seats right now; reload the seat map. */
  SEAT_LOCKED: 'SEAT_LOCKED',
  /** 409: seats SOLD or HELD by a live hold; `details.seatIds` lists them. */
  SEAT_UNAVAILABLE: 'SEAT_UNAVAILABLE',
  /** 422: seats not sold for this showtime (unknown, other room, switched off); `details.seatIds`. */
  SEAT_NOT_FOUND: 'SEAT_NOT_FOUND',
  /** 422: a couple seat without its partner; `details.missingSeatIds`. */
  COUPLE_INCOMPLETE: 'COUPLE_INCOMPLETE',
  /** 409: the showtime was cancelled. */
  SHOWTIME_CANCELLED: 'SHOWTIME_CANCELLED',
  /** 422: the showtime has started (`startsAt <= now`). */
  SHOWTIME_STARTED: 'SHOWTIME_STARTED',
  /** 409: the user already has a live PENDING booking for this showtime; `details.bookingId`. */
  BOOKING_ALREADY_PENDING: 'BOOKING_ALREADY_PENDING',
} as const;
export type BookingErrorCode = (typeof BookingErrorCode)[keyof typeof BookingErrorCode];
