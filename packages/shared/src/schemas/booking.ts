import { z } from 'zod';
import { BookingStatus, SeatType } from '../enums.js';
import { pageSchema } from './movie.js';

/** Limits shared by the API DTOs and the web so both validate the same way. */
export const BOOKING_LIMITS = {
  /** Seats per booking (PLAN §1). */
  seatsMax: 6,
  /** Different combos per booking, and units of one combo. */
  comboLinesMax: 10,
  comboQuantityMax: 10,
  /** `Idempotency-Key` header length. */
  idempotencyKeyMin: 8,
  idempotencyKeyMax: 128,
  /** `GET /me/bookings` page size. */
  listPageSizeDefault: 10,
  listPageSizeMax: 50,
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

export const comboItemSchema = z.object({
  comboId: z.uuid(),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(BOOKING_LIMITS.comboQuantityMax, {
      error: `Tối đa ${BOOKING_LIMITS.comboQuantityMax} phần mỗi combo`,
    }),
});
export type ComboItem = z.infer<typeof comboItemSchema>;

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
  /** Active combos only (`422 COMBO_NOT_AVAILABLE`); name and price are copied into the booking. */
  comboItems: z
    .array(comboItemSchema)
    .max(BOOKING_LIMITS.comboLinesMax)
    .refine((items) => hasNoDuplicates(items.map((item) => item.comboId)), {
      error: 'Mỗi combo chỉ một dòng, tăng số lượng thay vì thêm dòng',
    })
    .default([]),
});
export type HoldBookingRequest = z.input<typeof holdBookingRequestSchema>;

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

/** Snapshot taken at hold time: later combo edits never change it. */
export const bookingComboSchema = z.object({
  comboId: z.uuid(),
  name: z.string(),
  /** VND per unit. */
  unitPrice: z.number().int(),
  quantity: z.number().int(),
  /** unitPrice × quantity. */
  amount: z.number().int(),
});
export type BookingCombo = z.infer<typeof bookingComboSchema>;

/** What the customer needs to recognise a booking without another request. */
export const bookingMovieSchema = z.object({ id: z.uuid(), title: z.string(), slug: z.string() });
export const bookingShowtimeSchema = z.object({
  id: z.uuid(),
  startsAt: z.string(),
  /** End of the film plus cleanup time. */
  endsAt: z.string(),
});
export const bookingRoomSchema = z.object({ id: z.uuid(), name: z.string() });

/**
 * `201` (new) or `200` (same `Idempotency-Key` and payload again) body of `POST /bookings`; also
 * `GET /bookings/:id` and the items of `GET /me/bookings`.
 */
export const bookingSchema = z.object({
  id: z.uuid(),
  /** Short code shown to the customer. */
  code: z.string(),
  showtimeId: z.uuid(),
  movie: bookingMovieSchema,
  showtime: bookingShowtimeSchema,
  room: bookingRoomSchema,
  status: z.enum(BookingStatus),
  /** Countdown shown to the customer; last moment to start a payment. */
  expiresAt: z.string(),
  /** expiresAt + payment grace: the seats stay HELD until then. */
  holdUntil: z.string(),
  /**
   * `status` is PENDING but holdUntil has passed: the booking is over even if the expiry job has
   * not marked it EXPIRED yet. `status` itself is reported as stored.
   */
  expired: z.boolean(),
  seats: z.array(bookingSeatSchema),
  combos: z.array(bookingComboSchema),
  /** Seats + combos. */
  subtotal: z.number().int(),
  discount: z.number().int(),
  total: z.number().int(),
  createdAt: z.string(),
});
export type Booking = z.infer<typeof bookingSchema>;

/** `GET /me/bookings`: the user's bookings, newest first. */
export const bookingPageSchema = pageSchema(bookingSchema);

/**
 * `details` of `409 BOOKING_ALREADY_PENDING`: the booking that blocks a new one, so the client can
 * send the customer to it. `bookingId` is the same id, kept from week 7.
 */
export const bookingAlreadyPendingDetailsSchema = z.object({
  existingBookingId: z.uuid(),
  /** ISO instant; once past it, the same user may book this showtime again. */
  expiresAt: z.string(),
  bookingId: z.uuid(),
});
export type BookingAlreadyPendingDetails = z.infer<typeof bookingAlreadyPendingDetailsSchema>;

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
  /** 422: a combo that does not exist or is switched off; `details.comboIds`. */
  COMBO_NOT_AVAILABLE: 'COMBO_NOT_AVAILABLE',
  /** 422: this Idempotency-Key was already used by the user for a different request. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /**
   * 409: the user already has a PENDING booking for this showtime whose `expiresAt` has not passed;
   * `details` = `bookingAlreadyPendingDetailsSchema`.
   */
  BOOKING_ALREADY_PENDING: 'BOOKING_ALREADY_PENDING',
  /** 404: no such booking, or it belongs to another user (never 403: that would confirm it exists). */
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  /**
   * 409: `DELETE /bookings/:id` on a booking that is CONFIRMED or NEEDS_REVIEW, or that has a
   * SUCCESS payment.
   */
  BOOKING_NOT_CANCELLABLE: 'BOOKING_NOT_CANCELLABLE',
  /** 409: `DELETE /bookings/:id` while a payment of the booking is PENDING (in progress at VNPay). */
  BOOKING_HAS_PAYMENT_IN_PROGRESS: 'BOOKING_HAS_PAYMENT_IN_PROGRESS',
  /** 429: too many `POST /bookings` from this user; `details.retryAfterSeconds`. Same code as login. */
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
} as const;
export type BookingErrorCode = (typeof BookingErrorCode)[keyof typeof BookingErrorCode];
