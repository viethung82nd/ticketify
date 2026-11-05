import { z } from 'zod';
import { BookingStatus, PaymentStatus, ShowtimeStatus } from '../enums.js';
import { pageSchema } from './movie.js';

/** Limits of the NEEDS_REVIEW queue and of the note an admin must write (ROADMAP 3.8). */
export const REVIEW_LIMITS = {
  listPageSizeDefault: 20,
  listPageSizeMax: 100,
  noteMin: 1,
  noteMax: 1_000,
} as const;

/** Which part of the queue `GET /admin/bookings/needs-review` returns. */
export const ReviewFilter = {
  /** Not marked handled yet: the work queue. Default. */
  OPEN: 'open',
  /** Already marked handled, newest first. */
  RESOLVED: 'resolved',
  ALL: 'all',
} as const;
export type ReviewFilter = (typeof ReviewFilter)[keyof typeof ReviewFilter];

/** Who marked a booking handled, when, and what they wrote. */
export const reviewResolutionSchema = z.object({
  at: z.string(),
  /** Null only if the admin's account was deleted afterwards. */
  byUserId: z.uuid().nullable(),
  byName: z.string().nullable(),
  /** The note from the newest `booking.review_resolved` audit entry. */
  note: z.string().nullable(),
});
export type ReviewResolution = z.infer<typeof reviewResolutionSchema>;

/**
 * One booking in the NEEDS_REVIEW queue: paid, but the seats could not be kept (PLAN §5 step 4).
 * Everything an admin needs to refund by hand or call the customer. No automatic refund exists.
 */
export const needsReviewBookingSchema = z.object({
  bookingId: z.uuid(),
  code: z.string(),
  /** Always NEEDS_REVIEW; marking a booking handled does not change it. */
  status: z.enum(BookingStatus),
  total: z.number().int(),
  createdAt: z.string(),
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    fullName: z.string(),
    phone: z.string().nullable(),
  }),
  showtime: z.object({
    id: z.uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
    status: z.enum(ShowtimeStatus),
    movieTitle: z.string(),
    roomName: z.string(),
  }),
  /** Seat labels of the booking, e.g. `["A1", "A2"]`; kept even after the seats were released. */
  seatLabels: z.array(z.string()),
  /** The payment that went through. Null would mean broken data (the queue always has one). */
  payment: z
    .object({
      id: z.uuid(),
      txnRef: z.string(),
      amount: z.number().int(),
      status: z.enum(PaymentStatus),
      /** Needed to refund through the VNPay merchant portal. */
      vnpTransactionNo: z.string().nullable(),
      bankCode: z.string().nullable(),
      processedAt: z.string().nullable(),
    })
    .nullable(),
  /** `reason` of the `booking.needs_review` outbox event, e.g. `SEAT_SOLD`. */
  reason: z.string().nullable(),
  /** Null while the booking is still open. */
  resolution: reviewResolutionSchema.nullable(),
});
export type NeedsReviewBooking = z.infer<typeof needsReviewBookingSchema>;

export const needsReviewPageSchema = pageSchema(needsReviewBookingSchema);

/**
 * `POST /admin/bookings/:id/resolve-review`: record that an admin handled the booking outside the
 * system. The note is required — it is the only trace of what was actually done (refund made,
 * customer called, ticket reissued). No money moves: refunds are manual (PLAN §5).
 */
export const resolveReviewRequestSchema = z.object({
  note: z.string().trim().min(REVIEW_LIMITS.noteMin).max(REVIEW_LIMITS.noteMax),
});
export type ResolveReviewRequest = z.infer<typeof resolveReviewRequestSchema>;

/** Machine-readable `code` values of the admin review API. */
export const ReviewErrorCode = {
  /** 404: no booking with this id. */
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  /** 409: the booking is not NEEDS_REVIEW, so there is nothing to handle. */
  BOOKING_NOT_IN_REVIEW: 'BOOKING_NOT_IN_REVIEW',
  /** 409: an admin already marked it handled; `details.resolvedAt`. */
  REVIEW_ALREADY_RESOLVED: 'REVIEW_ALREADY_RESOLVED',
} as const;
export type ReviewErrorCode = (typeof ReviewErrorCode)[keyof typeof ReviewErrorCode];

/** `details` of `409 REVIEW_ALREADY_RESOLVED`. */
export const reviewAlreadyResolvedDetailsSchema = z.object({ resolvedAt: z.string() });
export type ReviewAlreadyResolvedDetails = z.infer<typeof reviewAlreadyResolvedDetailsSchema>;
