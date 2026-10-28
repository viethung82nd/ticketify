import { Injectable, Logger } from '@nestjs/common';
import { ClockService } from '../../infra/clock/clock.service';
import { BookingQueueProducer } from '../../infra/queue/booking-queue.producer';

/** Milliseconds from `now` until `holdUntil`; 0 when it has already passed. */
export function expiryDelayMs(holdUntil: Date, now: Date): number {
  return Math.max(0, holdUntil.getTime() - now.getTime());
}

/**
 * Schedules `expireBooking(bookingId)` at the booking's `holdUntil` (BullMQ delayed job
 * `expire-booking`, ROADMAP 2.7). Was the empty `ExpirationScheduler` hook in week 7.
 */
@Injectable()
export class BookingExpirationQueue {
  private readonly logger = new Logger(BookingExpirationQueue.name);

  constructor(
    private readonly producer: BookingQueueProducer,
    private readonly clock: ClockService,
  ) {}

  /**
   * Called after the hold transaction commits, never inside it: a job must never see a booking
   * that was rolled back.
   *
   * Never throws. The seats are already held when this runs; failing the request now would tell
   * the customer "no" about a booking that exists. If Redis does not take the job, the error is
   * logged and the per-minute sweep (worker) expires the booking at most a minute late. Until then
   * nobody is blocked: an expired hold is free for the next customer (lazy expiry, PLAN §4).
   */
  async schedule(bookingId: string, holdUntil: Date): Promise<void> {
    const delay = expiryDelayMs(holdUntil, this.clock.now());
    try {
      await this.producer.enqueueExpiry(bookingId, delay);
    } catch (error) {
      this.logger.error(
        `expire-booking not enqueued for booking ${bookingId} (the sweep will expire it): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
