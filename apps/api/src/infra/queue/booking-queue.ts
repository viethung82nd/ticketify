/**
 * The `bookings` BullMQ queue: names shared by the producer (API) and the worker.
 *
 * Postgres stays the only source of truth (PLAN §4): a job only says "look at this booking now",
 * so a lost, duplicated or early job never changes the outcome — `expireBooking` re-checks
 * everything under a row lock, and the per-minute sweep catches what a lost job missed.
 */
export const BOOKING_QUEUE = 'bookings';

export const BookingJob = {
  /** Delayed until the booking's `holdUntil`; one per booking (see `expireBookingJobId`). */
  EXPIRE: 'expire-booking',
  /** Repeated every minute by a BullMQ job scheduler, in the worker only (ROADMAP 2.8). */
  SWEEP: 'sweep-expired-bookings',
} as const;
export type BookingJobName = (typeof BookingJob)[keyof typeof BookingJob];

export interface ExpireBookingJobData {
  bookingId: string;
}

/**
 * Job id of a booking's expiry job, so enqueuing twice for one booking adds a single job.
 *
 * `expire-booking-<id>`, not `expire-booking:<id>`: BullMQ refuses custom ids with one `:`
 * ("Custom Id cannot contain :" — the colon separates its Redis key parts).
 */
export const expireBookingJobId = (bookingId: string): string =>
  `${BookingJob.EXPIRE}-${bookingId}`;
