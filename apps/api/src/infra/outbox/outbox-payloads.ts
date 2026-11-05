import { z } from 'zod';
import { ReviewReason } from '../../modules/payment/seat-settlement';
import { SeatsReleasedCause } from './outbox-events';

/**
 * Shape of each outbox payload, as the writer (`confirmPayment`, `expireBooking`) stores it.
 *
 * A delivery handler parses its payload instead of casting it: the row may have been written by
 * an older build, and a handler must fail loudly (and once, `UnrecoverableError`) rather than
 * email nothing or crash on `undefined`. `confirm-payment.spec.ts` checks the writers against
 * these schemas, so the two cannot drift apart unnoticed.
 */

const uuid = z.uuid();
const seatIds = z.array(uuid);

export const seatsReleasedPayloadSchema = z.object({
  bookingId: uuid,
  showtimeId: uuid,
  seatIds: seatIds.min(1),
  cause: z.enum([SeatsReleasedCause.BOOKING_EXPIRED, SeatsReleasedCause.BOOKING_NEEDS_REVIEW]),
});
export type SeatsReleasedPayload = z.infer<typeof seatsReleasedPayloadSchema>;

export const bookingConfirmedPayloadSchema = z.object({
  bookingId: uuid,
  bookingCode: z.string().min(1),
  userId: uuid,
  showtimeId: uuid,
  paymentId: uuid,
  seatIds: seatIds.min(1),
  ticketIds: seatIds.min(1),
  /** The booking had EXPIRED and took its seats back (branch B). */
  reclaimed: z.boolean(),
});
export type BookingConfirmedPayload = z.infer<typeof bookingConfirmedPayloadSchema>;

export const bookingNeedsReviewPayloadSchema = z.object({
  bookingId: uuid,
  bookingCode: z.string().min(1),
  userId: uuid,
  showtimeId: uuid,
  paymentId: uuid,
  amount: z.number().int(),
  vnpTransactionNo: z.string().nullable(),
  reason: z.enum(Object.values(ReviewReason)),
  /** The seats behind `reason`; empty when the showtime itself is the problem. */
  seatIds,
  /** Seats of this booking that went back to AVAILABLE (often none). */
  releasedSeatIds: seatIds,
});
export type BookingNeedsReviewPayload = z.infer<typeof bookingNeedsReviewPayloadSchema>;

export const paymentRefundRequiredPayloadSchema = z.object({
  paymentId: uuid,
  txnRef: z.string().min(1),
  bookingId: uuid,
  bookingCode: z.string().min(1),
  userId: uuid,
  amount: z.number().int(),
  vnpTransactionNo: z.string().nullable(),
  /** The payment that actually paid the booking and keeps it confirmed. */
  paidPaymentId: uuid,
});
export type PaymentRefundRequiredPayload = z.infer<typeof paymentRefundRequiredPayloadSchema>;
