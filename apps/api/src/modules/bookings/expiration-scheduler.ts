import { Injectable } from '@nestjs/common';

/**
 * Schedules `expireBooking(bookingId)` at `runAt` (the booking's `holdUntil`).
 *
 * Empty this week: week 8 (ROADMAP 2.6–2.7) attaches a BullMQ delayed job `expire-booking` here,
 * plus the per-minute `SKIP LOCKED` sweep (2.8) as the safety net. Until then an expired hold is
 * only released lazily: the hold flow treats `HELD` with `held_until <= now` as free.
 */
@Injectable()
export class ExpirationScheduler {
  /** Called after the hold transaction commits, never inside it. */
  schedule(_bookingId: string, _runAt: Date): Promise<void> {
    return Promise.resolve();
  }
}
