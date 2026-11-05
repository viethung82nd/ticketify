import { z } from 'zod';
import { SeatsReleasedCause } from './outbox-events';

/**
 * Shape of each outbox payload, as the writer (`confirmPayment`, `expireBooking`) stores it.
 *
 * A delivery handler parses its payload instead of casting it: the row may have been written by
 * an older build, and a handler must fail loudly (and once, `UnrecoverableError`) rather than
 * email nothing or crash on `undefined`.
 */

export const seatsReleasedPayloadSchema = z.object({
  bookingId: z.uuid(),
  showtimeId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1),
  cause: z.enum([SeatsReleasedCause.BOOKING_EXPIRED, SeatsReleasedCause.BOOKING_NEEDS_REVIEW]),
});
export type SeatsReleasedPayload = z.infer<typeof seatsReleasedPayloadSchema>;
